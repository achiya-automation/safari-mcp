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

/** Image response (base64 + mime type). */
export const imageResult = (data, mimeType = "image/jpeg") => ({
  content: [{ type: "image", data, mimeType }],
});

/** Error response — sets `isError` so the MCP client renders it as a failure. */
export const errorResult = (msg) => ({
  content: [{ type: "text", text: msg }],
  isError: true,
});
