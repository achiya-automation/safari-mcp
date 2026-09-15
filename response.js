// MCP tool-response helpers — the single source of truth for the
// `{ content: [...] }` envelope shape every tool returns.
//
// Before this module the envelope was hand-written ~90× across index.js in
// three slightly different styles (`text: result`, a defensive
// `typeof result === 'string' ? … : JSON.stringify(result)`, and an
// unconditional `JSON.stringify`). `textResult` folds all three into one:
// strings pass through unchanged (byte-identical to the old dominant form),
// non-strings are JSON-stringified instead of becoming "[object Object]".

/** Text response. Strings pass through; everything else is JSON-stringified. */
export const textResult = (r) => ({
  content: [{ type: "text", text: typeof r === "string" ? r : JSON.stringify(r) }],
});

/** Pretty-printed JSON response, for structured payloads worth indenting. */
export const jsonResult = (r) => ({
  content: [{ type: "text", text: JSON.stringify(r, null, 2) }],
});

/**
 * Image response for base64 JPEG or PNG, labelled by the data's own magic bytes. Anything
 * else is a message ("Element not found: …"): sent as image bytes the client cannot decode
 * it and the reason is lost, so it is raised as the tool's error instead.
 */
export const imageResult = (data) => {
  const mimeType = /^\/9j\//.test(data) ? "image/jpeg" : /^iVBORw0KGgo/.test(data) ? "image/png" : null;
  if (!mimeType) throw new Error(String(data || "no image data returned"));
  return { content: [{ type: "image", data, mimeType }] };
};

/** Error response — sets `isError` so the MCP client renders it as a failure. */
export const errorResult = (msg) => ({
  content: [{ type: "text", text: msg }],
  isError: true,
});

/**
 * `safari_evaluate` / `safari_eval_file` result text.
 *
 * Distinct from `textResult`: only these two tools surface a *script's* return value,
 * so they need to say "the script returned nothing" — and the old form said it with a
 * falsy check, `(… || "(no return value)")`. That collapsed three different outcomes
 * into one string: a script returning `undefined` (nothing), a script returning `""`
 * (a real value), and an injection that never ran at all (a failure). An empty return
 * is a legitimate result and must stay distinguishable from no return.
 */
export const evalResult = (r) => {
  let text;
  if (typeof r === "string") {
    text = r === "" ? '""' : r;
  } else {
    const json = JSON.stringify(r); // undefined for undefined/function/symbol
    text = json === undefined ? "(no return value)" : json;
  }
  return { content: [{ type: "text", text }] };
};
