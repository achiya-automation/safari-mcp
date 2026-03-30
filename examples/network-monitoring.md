# Network Monitoring

Monitor API calls, inspect request/response details, and mock network responses. Safari MCP intercepts fetch and XMLHttpRequest at the JavaScript level, giving you visibility into every API call a web app makes.

## 1. Quick network overview

See what resources the page has loaded (images, scripts, API calls) using the Performance API. No setup required.

```json
// Navigate to a page
{ "tool": "safari_new_tab", "arguments": { "url": "https://api.github.com" } }

// Get a quick overview of loaded resources
{ "tool": "safari_network", "arguments": { "limit": 20 } }
```

**Expected output:** List of resources with URLs, types, sizes, and timing:
```json
[
  { "name": "https://api.github.com/", "type": "document", "duration": 245, "size": 2340 },
  { "name": "https://api.github.com/favicon.ico", "type": "other", "duration": 89, "size": 1406 }
]
```

## 2. Detailed network capture (fetch + XHR)

For full request/response inspection including headers, status codes, and POST bodies, start a capture session first.

```json
// Step 1: Start capturing (intercepts fetch + XHR from this point forward)
{ "tool": "safari_start_network_capture", "arguments": {} }

// Step 2: Navigate or interact to trigger API calls
{ "tool": "safari_navigate", "arguments": { "url": "https://example.com/dashboard" } }

// Step 3: Wait for the page to load and make its API calls
{ "tool": "safari_wait", "arguments": { "ms": 3000 } }

// Step 4: Get captured requests with full details
{ "tool": "safari_network_details", "arguments": {} }
```

**Expected output:** Array of captured requests with method, URL, status, headers, and timing:
```json
[
  {
    "method": "GET",
    "url": "https://api.example.com/v1/user/profile",
    "status": 200,
    "type": "fetch",
    "headers": { "authorization": "Bearer ..." },
    "duration": 142
  },
  {
    "method": "POST",
    "url": "https://api.example.com/v1/analytics/track",
    "status": 200,
    "type": "fetch",
    "duration": 89
  }
]
```

## 3. Filter captured requests

Focus on specific API endpoints.

```json
// Only show requests to the /api/ path
{ "tool": "safari_network_details", "arguments": { "filter": "/api/", "limit": 10 } }
```

## 4. Clear and re-capture

Reset the capture buffer to isolate a specific interaction.

```json
// Clear previous captures
{ "tool": "safari_clear_network", "arguments": {} }

// Perform the action you want to monitor
{ "tool": "safari_click", "arguments": { "text": "Save Changes" } }

// Wait for API calls to complete
{ "tool": "safari_wait", "arguments": { "ms": 2000 } }

// See only the requests triggered by that click
{ "tool": "safari_network_details", "arguments": {} }
```

## 5. Mock API responses

Intercept network requests and return custom responses. Useful for testing error states, simulating API failures, or replacing live data.

```json
// Mock a specific API endpoint to return an error
{
  "tool": "safari_mock_route",
  "arguments": {
    "urlPattern": "/api/v1/user/profile",
    "response": {
      "status": 500,
      "body": "{\"error\": \"Internal Server Error\"}",
      "contentType": "application/json"
    }
  }
}

// Now navigate or reload -- the app will receive the mocked 500 error
{ "tool": "safari_reload", "arguments": {} }
```

**Expected output:** `"Mock registered for pattern: /api/v1/user/profile"`. All subsequent fetch/XHR requests matching the pattern will receive the mocked response instead of hitting the real server.

## 6. Mock a successful response with custom data

```json
{
  "tool": "safari_mock_route",
  "arguments": {
    "urlPattern": "/api/v1/products",
    "response": {
      "status": 200,
      "body": "{\"products\": [{\"id\": 1, \"name\": \"Test Product\", \"price\": 9.99}]}",
      "contentType": "application/json"
    }
  }
}
```

## 7. Remove all mocks

```json
{ "tool": "safari_clear_mocks", "arguments": {} }
```

## 8. Monitor console output alongside network

Combine network monitoring with console capture to see errors and warnings.

```json
// Start both captures
{ "tool": "safari_start_network_capture", "arguments": {} }
{ "tool": "safari_start_console", "arguments": {} }

// Interact with the page
{ "tool": "safari_click", "arguments": { "text": "Load Data" } }
{ "tool": "safari_wait", "arguments": { "ms": 3000 } }

// Check for API errors and console errors together
{ "tool": "safari_network_details", "arguments": { "filter": "/api/" } }
{ "tool": "safari_console_filter", "arguments": { "level": "error" } }
```

**Expected output:** Two complementary views -- network requests showing HTTP status codes, and console errors showing any JavaScript exceptions or error messages triggered by those requests.

## 9. Simulate slow networks

Test how a page behaves on slow connections.

```json
// Throttle to 3G speeds
{ "tool": "safari_throttle_network", "arguments": { "profile": "slow-3g" } }

// Navigate and observe load behavior
{ "tool": "safari_navigate", "arguments": { "url": "https://example.com" } }

// Check performance metrics
{ "tool": "safari_performance_metrics", "arguments": {} }
```

**Expected output:** Performance metrics showing navigation timing, Web Vitals (FCP, LCP, CLS), and resource breakdown under throttled conditions.
