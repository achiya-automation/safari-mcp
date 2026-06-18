// Pure string-escaping helpers for the two injection contexts safari-mcp builds:
//  - escJsSingleQuote: a value going into a SINGLE-QUOTED JS string literal (selectors,
//    keys, text passed through `do JavaScript`).
//  - escAppleScriptString: a value going into a DOUBLE-QUOTED AppleScript literal.
// Extracted into their own module so this security-critical recipe lives in one place,
// free of the daemon/runtime code in safari.js, and is trivially importable by tests.
// ORDER MATTERS: backslash is escaped BEFORE the quote, or the backslash inserted in front
// of the quote gets doubled and the string breaks out. Locked by test/escaping.test.mjs
// and test/injection-safety.test.mjs.

export function escJsSingleQuote(s) {
  return String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

// Also strips CR/LF: a raw newline would close the AppleScript string and allow injection.
export function escAppleScriptString(s) {
  return String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\r\n]/g, "");
}
