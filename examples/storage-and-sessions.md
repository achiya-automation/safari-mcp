# Storage and Sessions

Read and write `localStorage`, save a page's storage state, and restore it into a fresh tab. Useful for seeding a page with known state or carrying web storage between test runs.

> **Warning:** exported storage can contain session secrets (readable cookies, tokens in `localStorage` or `sessionStorage`). Treat the exported JSON like a password: don't commit it, paste it into issues, or share it.

All values below are fake.

## 1. Open your own tab

Storage tools act on the current page's origin, so open a tab on the site first.

```json
{ "tool": "safari_new_tab", "arguments": { "url": "https://example.com" } }
// Returns: { "tabIndex": 4, "safeUrl": "https://example.com/", "receipt": "..." }
```

## 2. Read localStorage

```json
// All keys (each value is truncated to 200 characters)
{ "tool": "safari_local_storage", "arguments": {} }
```

**Expected output:**
```json
{ "theme": "dark", "onboarding_done": "true" }
```

```json
// A single key (full value)
{ "tool": "safari_local_storage", "arguments": { "key": "theme" } }
// Returns: "dark"
```

## 3. Set a value

```json
{ "tool": "safari_set_local_storage", "arguments": { "key": "demo_token", "value": "fake-token-123" } }
// Returns: "Set localStorage: demo_token"
```

## 4. Export the storage state

```json
{ "tool": "safari_export_storage", "arguments": {} }
```

**Expected output:**
```json
{
  "url": "https://example.com/",
  "cookies": "session_id=fake-session-abc; lang=en",
  "localStorage": { "theme": "dark", "onboarding_done": "true", "demo_token": "fake-token-123" },
  "sessionStorage": { "cart_step": "2" }
}
```

The export is read from the page itself (`document.cookie`, `localStorage`, `sessionStorage`), so it covers the cookies and storage visible to the current page and leaves out `HttpOnly` cookies.

## 5. Import into a fresh tab

Clear localStorage and cookies, then open a new tab on the **same origin**. A new tab starts with empty `sessionStorage`; localStorage and cookies are shared per origin, so clearing them in the first tab clears them here too. Import the JSON from step 4, passed as a string in `state`.

```json
// Simulate a fresh start
{ "tool": "safari_delete_local_storage", "arguments": {} }
// Returns: "Cleared localStorage: 3 items"

{ "tool": "safari_delete_cookies", "arguments": { "all": true } }
// Returns: "Deleted 2 cookies"

{ "tool": "safari_new_tab", "arguments": { "url": "https://example.com" } }

{
  "tool": "safari_import_storage",
  "arguments": {
    "state": "{\"url\":\"https://example.com/\",\"cookies\":\"session_id=fake-session-abc; lang=en\",\"localStorage\":{\"theme\":\"dark\",\"onboarding_done\":\"true\",\"demo_token\":\"fake-token-123\"},\"sessionStorage\":{\"cart_step\":\"2\"}}"
  }
}
// Returns: "Imported 6 items"
```

Reload the page (`safari_reload`) if the site only reads storage on load, then check the value came back:

```json
{ "tool": "safari_local_storage", "arguments": { "key": "demo_token" } }
// Returns: "fake-token-123"
```

## 6. Clean up

```json
// Remove one key
{ "tool": "safari_delete_local_storage", "arguments": { "key": "demo_token" } }
// Returns: "Deleted localStorage: demo_token"

// Or clear everything for this origin
{ "tool": "safari_delete_local_storage", "arguments": {} }
// Returns: "Cleared localStorage: 2 items"
```

`safari_delete_session_storage` works the same way for `sessionStorage`.

## Tips

- Import writes into the origin of the current page. Navigate to the right site before calling `safari_import_storage`.
- Cookies are restored through `document.cookie`, so attributes such as `Path`, `Domain`, `Secure`, `SameSite` and expiry are not carried over. Restored cookies are session cookies for the current host.
- If the site's login cookie is `HttpOnly`, export and import won't carry the login. Only readable cookies and web storage move.
- Delete the exported JSON when you're done with it.
