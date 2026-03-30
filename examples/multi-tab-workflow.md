# Multi-Tab Workflow

Work with multiple tabs safely, without touching the user's existing tabs. Safari MCP tracks which tabs it opens and auto-closes them when the session ends. This is critical -- the user may have unsaved work, forms in progress, or important page state in their own tabs.

## The golden rule

**Never interact with a tab you didn't open.** Always open your own tabs with `safari_new_tab`.

## 1. Inventory existing tabs first

Before any work, check what tabs are already open so you know which ones belong to the user.

```json
// Step 1: See all existing tabs (these are the USER'S tabs -- never touch them)
{ "tool": "safari_list_tabs", "arguments": {} }
```

**Expected output:**
```json
[
  { "index": 1, "title": "Gmail - Inbox", "url": "https://mail.google.com/..." },
  { "index": 2, "title": "Figma - Design System", "url": "https://www.figma.com/..." },
  { "index": 3, "title": "Jira Board", "url": "https://company.atlassian.net/..." }
]
```

Tabs 1-3 are the user's. Never navigate, click, or fill in these tabs.

## 2. Open your own tabs

```json
// Open tabs for your work -- remember the indices
{ "tool": "safari_new_tab", "arguments": { "url": "https://example.com/page-a" } }
// Returns: { "tabIndex": 4, ... }

{ "tool": "safari_new_tab", "arguments": { "url": "https://example.com/page-b" } }
// Returns: { "tabIndex": 5, ... }
```

Tabs 4 and 5 are yours. Only interact with these.

## 3. Switch between your tabs

```json
// Switch to your first tab
{ "tool": "safari_switch_tab", "arguments": { "index": 4 } }

// Do some work -- extract data
{ "tool": "safari_extract_tables", "arguments": {} }

// Switch to your second tab
{ "tool": "safari_switch_tab", "arguments": { "index": 5 } }

// Do different work
{ "tool": "safari_read_page", "arguments": {} }
```

## 4. Practical example: compare two pages

Compare pricing pages from two competitors side by side.

```json
// Step 1: Inventory user's tabs
{ "tool": "safari_list_tabs", "arguments": {} }
// Note: user has tabs 1-3

// Step 2: Open competitor A
{ "tool": "safari_new_tab", "arguments": { "url": "https://competitor-a.com/pricing" } }
// Tab 4 is ours

// Step 3: Open competitor B
{ "tool": "safari_new_tab", "arguments": { "url": "https://competitor-b.com/pricing" } }
// Tab 5 is ours

// Step 4: Extract pricing from competitor A
{ "tool": "safari_switch_tab", "arguments": { "index": 4 } }
{ "tool": "safari_wait_for", "arguments": { "selector": ".pricing-table", "timeout": 5000 } }
{ "tool": "safari_extract_tables", "arguments": { "selector": ".pricing-table" } }

// Step 5: Extract pricing from competitor B
{ "tool": "safari_switch_tab", "arguments": { "index": 5 } }
{ "tool": "safari_wait_for", "arguments": { "selector": ".pricing-table", "timeout": 5000 } }
{ "tool": "safari_extract_tables", "arguments": { "selector": ".pricing-table" } }

// Step 6: Clean up when done
{ "tool": "safari_switch_tab", "arguments": { "index": 5 } }
{ "tool": "safari_close_tab", "arguments": {} }
{ "tool": "safari_switch_tab", "arguments": { "index": 4 } }
{ "tool": "safari_close_tab", "arguments": {} }
```

## 5. Multi-step form workflow across tabs

Fill a form that requires information from another page.

```json
// Step 1: Open the source page to get reference data
{ "tool": "safari_new_tab", "arguments": { "url": "https://internal.company.com/employee/12345" } }
// Tab 4 is ours

// Step 2: Read the employee data
{ "tool": "safari_read_page", "arguments": { "selector": ".employee-details" } }
// Agent stores the employee name, email, department, etc.

// Step 3: Open the target form in a second tab
{ "tool": "safari_new_tab", "arguments": { "url": "https://hr-system.company.com/new-request" } }
// Tab 5 is ours

// Step 4: Fill the form using data from the other tab
{ "tool": "safari_fill_form", "arguments": {
  "fields": [
    { "selector": "#employee-name", "value": "Jane Smith" },
    { "selector": "#employee-email", "value": "jane@company.com" },
    { "selector": "#department", "value": "Engineering" }
  ]
} }

// Step 5: Clean up the source tab (keep the form tab for review)
{ "tool": "safari_switch_tab", "arguments": { "index": 4 } }
{ "tool": "safari_close_tab", "arguments": {} }
```

## 6. Handle tab index changes

When you close a tab, higher-numbered tabs shift down. Always re-check if needed.

```json
// You have tabs 4 and 5
// Close tab 4 -- tab 5 becomes tab 4
{ "tool": "safari_switch_tab", "arguments": { "index": 4 } }
{ "tool": "safari_close_tab", "arguments": {} }

// If unsure about indices after closing, re-list
{ "tool": "safari_list_tabs", "arguments": {} }
```

## Automatic cleanup

Safari MCP automatically tracks tabs opened during a session. When the MCP server process exits (conversation ends, client disconnects), all MCP-opened tabs are closed automatically. There is also a configurable tab limit (default: 6) -- if you open too many tabs, the oldest one is closed to stay within bounds.

## Memory safety

Safari MCP monitors WebKit memory usage. If the WebKit process exceeds the configured limit (default: 3GB), the oldest MCP-opened tab is automatically closed to free memory. User tabs are never touched.
