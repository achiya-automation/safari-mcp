// Pure string-escaping helpers for the two injection contexts safari-mcp builds:
//  - escJsSingleQuote: a value going into a SINGLE-QUOTED JS string literal (selectors,
//    keys, text passed through `do JavaScript`).
//  - escAppleScriptString: a value going into a DOUBLE-QUOTED AppleScript literal.
// Extracted into their own module so this security-critical recipe lives in one place,
// free of the daemon/runtime code in safari.js, and is trivially importable by tests.
// ORDER MATTERS: backslash is escaped BEFORE the quote, or the backslash inserted in front
// of the quote gets doubled and the string breaks out. Locked by test/escaping.test.mjs
// and test/injection-safety.test.mjs.
// NOTE: \r and \n are escaped to \\r/\\n so that multiline values round-trip as escape
// sequences inside the single-quoted JS literal rather than being silently space-flattened
// by runJS. U+2028/U+2029 are ECMAScript LineTerminators and must also be spelled as
// escape sequences -- raw U+2028/U+2029 inside a regex literal is a SyntaxError.

export function escJsSingleQuote(s) {
  return String(s)
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

// Also strips CR/LF: a raw newline would close the AppleScript string and allow injection.
export function escAppleScriptString(s) {
  return String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\r\n]/g, "");
}
