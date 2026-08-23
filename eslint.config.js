// ESLint flat config. Mostly advisory — `npm run lint` is for local use and the style
// backlog predates linting, so CI is not gated on the full run. The ONE exception is
// `no-undef`, which CI does gate (see ci.yml): a module-scope reference to a function-local
// `server` shipped in v2.16.2 and killed the startup banner silently for three days, and
// this rule had already flagged it. Rules are otherwise tuned to surface real bugs
// (unreachable code, accidental globals) without drowning in style noise.
import js from "@eslint/js";
import globals from "globals";

export default [
  js.configs.recommended,
  {
    files: ["**/*.js", "**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { ...globals.node },
    },
    rules: {
      // `_`-prefixed args/vars are intentional throwaways across this codebase.
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" }],
      "no-empty": ["warn", { allowEmptyCatch: true }],
      "no-constant-condition": ["warn", { checkLoops: false }],
    },
  },
  {
    // mcp-helpers.js is browser-context DOM code (injected as a string).
    files: ["mcp-helpers.js"],
    languageOptions: { globals: { ...globals.browser } },
  },
  {
    // The Xcode app's Safari extension resources run in a page context, not Node.
    files: ["xcode/**/Resources/*.js"],
    languageOptions: { globals: { ...globals.browser, browser: "readonly", webkit: "readonly" } },
  },
  {
    files: ["**/*.cjs"],
    languageOptions: { sourceType: "commonjs", globals: { ...globals.node } },
  },
  {
    ignores: ["node_modules/**", "extension/**", "*.swift", "safari-helper"],
  },
];
