// A form field holds a secret when it is a password input, or when its autocomplete names a
// password, a one-time code or payment-card data (cc-*). No read tool returns such a field's
// value: it is reported as "[redacted N chars]", so an agent still sees that it is filled.

export function isSensitiveField(type, autocomplete) {
  if (String(type || "").toLowerCase() === "password") return true;
  return String(autocomplete || "").toLowerCase().split(/\s+/).some((t) =>
    t === "current-password" || t === "new-password" || t === "one-time-code" || t.startsWith("cc-"));
}

export const maskValue = (value) => `[redacted ${String(value).length} chars]`;

const MASKED = /^\[redacted \d+ chars\]$/;

// The same check for the page scripts safari.js runs: __mcpValue(el, v) is v, or its mask when
// el is a sensitive field.
export const PAGE_FIELD_JS =
  `var __mcpIsSensitive=${isSensitiveField};` +
  "function __mcpValue(el,v){if(v===undefined||v===null||v==='')return v;" +
  "var t=el&&el.tagName==='INPUT'?el.type:'';var ac=el&&el.getAttribute?el.getAttribute('autocomplete'):'';" +
  "return __mcpIsSensitive(t,ac)?'[redacted '+String(v).length+' chars]':v;}";

// Quoted strings are skipped whole, so ` type="` inside another attribute's value is not read.
function attr(attrs, name) {
  for (const m of attrs.matchAll(new RegExp(`"[^"]*"?|\\s${name}\\s*=\\s*"([^"]*)`, "gi"))) if (m[1] !== undefined) return m[1];
  return "";
}
const unescapeAttr = (s) => s.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

// Masks the value attribute of sensitive input/textarea/select tags in page source or a
// snapshot. A tag cut off by a length limit is masked whatever it is: the attribute that
// makes it sensitive may be in the part that was cut.
export function redactMarkupFieldValues(markup) {
  if (typeof markup !== "string" || !/value/i.test(markup)) return markup;
  return markup.replace(/<(input|textarea|select)\b((?:[^>"]|"[^"]*"|"[^"]*$)*)(>|$)/gi, (tag, name, attrs, end) => {
    const type = name.toLowerCase() === "input" ? attr(attrs, "type") : "";
    if (end && !isSensitiveField(type, attr(attrs, "autocomplete"))) return tag;
    const masked = attrs.replace(/"[^"]*"?|(\svalue\s*=\s*")([^"]*)("?)/gi, (m, open, v, close) =>
      open === undefined || MASKED.test(v) ? m : open + maskValue(unescapeAttr(v)) + close);
    return `<${name}${masked}${end}`;
  });
}

// The pass every extension reply makes on the server: an extension built before its page
// functions masked these fields still reports them as they are.
export function redactFieldValues(command, result) {
  if (typeof result !== "string") return result;
  if (command === "snapshot" || command === "get_source") return redactMarkupFieldValues(result);
  if (command !== "get_element" && command !== "query_all") return result;
  let data;
  try { data = JSON.parse(result); } catch { return result; }
  let changed = false;
  for (const el of [data].flat()) {
    if (!el || typeof el !== "object") continue;
    const attrs = el.attrs && typeof el.attrs === "object" ? el.attrs : {};
    const type = String(el.tag || "").toUpperCase() === "INPUT" ? el.type ?? attrs.type : "";
    if (!isSensitiveField(type, el.autocomplete ?? attrs.autocomplete)) continue;
    for (const holder of [el, attrs]) {
      if (holder.value === undefined || holder.value === null || holder.value === "" || MASKED.test(holder.value)) continue;
      holder.value = maskValue(holder.value);
      changed = true;
    }
  }
  return changed ? JSON.stringify(data) : result;
}
