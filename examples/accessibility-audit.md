# Accessibility Audit

Run a quick accessibility check on a page: read the accessibility tree, look for controls with no accessible name, images with no alt text and clickable elements with no role, then check the text contrast of anything that looks too faint. Because Safari MCP uses your real browser session, this works on pages behind a login too.

This is a first pass, not a full WCAG audit. It catches the most common problems quickly; use a dedicated checker and a screen reader for a complete review.

## 1. Open the page in a new tab

```json
{ "tool": "safari_new_tab", "arguments": { "url": "https://example.com/signup" } }
```

**Expected output:** `{ "tabIndex": 3, "safeUrl": "https://example.com/signup", "receipt": "..." }`. Keep the `receipt` and pass it to later calls that accept one, so they stay pinned to this tab.

## 2. Take an accessibility snapshot

```json
// Whole page, default depth (5)
{ "tool": "safari_accessibility_snapshot", "arguments": { "receipt": "<receipt from step 1>" } }

// Only the form, a bit deeper
{ "tool": "safari_accessibility_snapshot", "arguments": { "receipt": "<receipt from step 1>", "selector": "form#signup", "maxDepth": 8 } }
```

**Expected output:** A JSON tree. Each node has a `role` (the `role` attribute, or the tag name when there is none) and, when present, `name` (from `aria-label`), `text`, `id`, ARIA states (`expanded`, `checked`, `selected`, `disabled`), `focusable`, and form details (`type`, `value`, `required`, `placeholder`). Images get `alt`, set to `"(missing)"` when the attribute is absent. Elements with `aria-hidden="true"` are left out.

```json
{
  "role": "form",
  "id": "signup",
  "children": [
    { "role": "input", "type": "email", "value": "", "required": true, "placeholder": "Email", "focusable": true },
    { "role": "img", "alt": "(missing)", "src": "https://example.com/img/badge.png" },
    { "role": "div", "text": "Continue" },
    { "role": "button", "name": "Close", "focusable": true, "children": [{ "role": "svg" }] }
  ]
}
```

## 3. Read the tree for common problems

Look for these patterns in the snapshot:

| Pattern in the tree | Problem | Fix |
|---------------------|---------|-----|
| `input` with only a `placeholder` and no `name` | The field has no label; a placeholder is not a label | Add a `<label for>` or `aria-label` |
| `img` with `"alt": "(missing)"` | Screen readers announce the file name | Add `alt` text, or `alt=""` if the image is decorative |
| `div` or `span` with `text` like "Continue" and no `focusable` | A "button" that keyboard users can't reach | Use a `<button>`, or add `role="button"`, `tabindex="0"` and a key handler |
| `button` with no `text` and no `name` | An icon button with no accessible name | Add `aria-label` |

The snapshot reads `aria-label` but not `<label>` elements, so an input labelled with `<label for="email">` still shows no `name`. Before reporting a missing label, confirm it with a quick check:

```json
{
  "tool": "safari_evaluate",
  "arguments": {
    "receipt": "<receipt from step 1>",
    "script": "JSON.stringify([...document.querySelectorAll('input, select, textarea')].filter(el => el.type !== 'hidden' && !el.labels?.length && !el.getAttribute('aria-label') && !el.getAttribute('aria-labelledby')).map(el => el.outerHTML.slice(0, 120)))"
  }
}
```

**Expected output:** A JSON array of the form controls that really have no label. An empty array means every control is labelled.

## 4. Check the contrast of a suspicious element

When text looks faint, read its colours:

```json
{ "tool": "safari_get_computed_style", "arguments": { "selector": "form#signup .hint", "properties": ["color", "background-color", "font-size", "font-weight"] } }
```

**Expected output:**

```json
{
  "color": "rgb(170, 170, 170)",
  "background-color": "rgb(255, 255, 255)",
  "font-size": "14px",
  "font-weight": "400"
}
```

`rgb(170, 170, 170)` on white has a contrast ratio of about 2.3:1. WCAG AA requires at least 4.5:1 for normal text and 3:1 for large text (24px, or about 18.7px bold). If `background-color` is `rgba(0, 0, 0, 0)` (transparent), check the parent element; the colour you see comes from further up the tree.

## 5. Close the tab

```json
{ "tool": "safari_close_tab", "arguments": { "receipt": "<receipt from step 1>" } }
```

**Expected output:** The audit tab closes. Your other tabs are untouched.
