# Form Automation

Fill forms, select dropdowns, and submit -- works with plain HTML forms and modern frameworks (React, Vue, Angular, Svelte). Safari MCP uses native value setters and dispatches the correct events so framework state stays in sync.

## 1. Detect forms on a page

Before filling, discover what forms exist and get the right selectors.

```json
// Step 1: Navigate to a page with forms
{ "tool": "safari_new_tab", "arguments": { "url": "https://example.com/contact" } }

// Step 2: Auto-detect all forms, fields, and submit buttons
{ "tool": "safari_detect_forms", "arguments": {} }
```

**Expected output:** JSON listing each form with its fields, input types, selectors, and submit button:
```json
{
  "forms": [
    {
      "selector": "form#contact-form",
      "fields": [
        { "selector": "#name", "type": "text", "name": "name", "label": "Full Name" },
        { "selector": "#email", "type": "email", "name": "email", "label": "Email" },
        { "selector": "#subject", "type": "select", "name": "subject", "options": ["General", "Support", "Sales"] },
        { "selector": "#message", "type": "textarea", "name": "message", "label": "Message" }
      ],
      "submitButton": "button[type='submit']"
    }
  ]
}
```

## 2. Fill a single field

```json
{ "tool": "safari_fill", "arguments": { "selector": "#email", "value": "user@example.com" } }
```

**Expected output:** `"Filled #email with value (length: 16)"`. The field's value is set and input/change events are dispatched, so React/Vue state updates correctly.

## 3. Fill multiple fields at once

```json
{
  "tool": "safari_fill_form",
  "arguments": {
    "fields": [
      { "selector": "#name", "value": "Jane Smith" },
      { "selector": "#email", "value": "jane@example.com" },
      { "selector": "#message", "value": "I'd like to learn more about your services." }
    ]
  }
}
```

**Expected output:** Confirmation that all fields were filled successfully.

## 4. Select a dropdown option

```json
// Native <select> dropdown
{ "tool": "safari_select_option", "arguments": { "selector": "#subject", "value": "Support" } }
```

**Expected output:** `"Selected: Support"`. For custom dropdowns (React Select, Material UI), use click-based interaction instead:

```json
// Custom dropdown: click to open, then click the option
{ "tool": "safari_click", "arguments": { "selector": ".dropdown-trigger" } }
{ "tool": "safari_click", "arguments": { "text": "Support" } }
```

## 5. Fill and submit in one call

Fill all fields and submit the form in a single operation.

```json
{
  "tool": "safari_fill_and_submit",
  "arguments": {
    "fields": [
      { "selector": "#name", "value": "Jane Smith" },
      { "selector": "#email", "value": "jane@example.com" },
      { "selector": "#subject", "value": "Sales" },
      { "selector": "#message", "value": "Interested in enterprise pricing." }
    ],
    "submitSelector": "button[type='submit']"
  }
}
```

**Expected output:** All fields filled, form submitted. If `submitSelector` is omitted, Safari MCP auto-detects the submit button.

## 6. Use snapshot refs for framework-heavy forms

On React/Angular apps, CSS selectors can be fragile. Use `safari_snapshot` to get stable ref IDs.

```json
// Step 1: Get the accessibility tree with ref IDs
{ "tool": "safari_snapshot", "arguments": {} }

// Output shows:
// [textbox ref=0_8] "Full Name" value=""
// [textbox ref=0_9] "Email" value=""
// [combobox ref=0_10] "Subject"
// [textbox ref=0_11] "Message" value=""
// [button ref=0_15] "Submit"

// Step 2: Fill using refs (more reliable than CSS selectors)
{ "tool": "safari_fill", "arguments": { "ref": "0_8", "value": "Jane Smith" } }
{ "tool": "safari_fill", "arguments": { "ref": "0_9", "value": "jane@example.com" } }
{ "tool": "safari_click", "arguments": { "ref": "0_15" } }
```

## 7. Type real keystrokes

For fields that need keystroke-level input (autocomplete, search-as-you-type):

```json
// Click the search field first
{ "tool": "safari_click", "arguments": { "selector": "input[type='search']" } }

// Type character by character with events
{ "tool": "safari_type_text", "arguments": { "text": "safari mcp", "selector": "input[type='search']" } }

// Press Enter to search
{ "tool": "safari_press_key", "arguments": { "key": "Enter" } }
```

**Expected output:** Each character is typed with keydown/keypress/keyup events, triggering autocomplete suggestions. All keyboard input is JavaScript-based, so it works regardless of the system keyboard layout.
