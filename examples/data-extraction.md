# Data Extraction

Extract structured data from any web page: tables, links, meta tags, images, and arbitrary content via JavaScript. Since Safari MCP uses your real browser session, you can extract data from authenticated pages (dashboards, admin panels, analytics) without re-logging in.

## 1. Extract tables as structured JSON

Pull data from HTML tables -- useful for scraping pricing pages, comparison tables, or dashboards.

```json
// Step 1: Navigate to a page with tables
{ "tool": "safari_new_tab", "arguments": { "url": "https://en.wikipedia.org/wiki/List_of_countries_by_GDP_(nominal)" } }

// Step 2: Extract all tables
{ "tool": "safari_extract_tables", "arguments": {} }
```

**Expected output:** JSON array of tables, each with headers and rows:
```json
[
  {
    "index": 0,
    "headers": ["Rank", "Country", "GDP (US$ million)"],
    "rows": [
      ["1", "United States", "28,781,083"],
      ["2", "China", "18,532,633"],
      ["3", "Germany", "4,591,100"]
    ],
    "rowCount": 195
  }
]
```

To extract a specific table:

```json
{ "tool": "safari_extract_tables", "arguments": { "selector": "table.wikitable", "limit": 1 } }
```

## 2. Extract all links with metadata

Get every link on a page with its href, text, rel attributes, and external/nofollow detection.

```json
{ "tool": "safari_extract_links", "arguments": {} }
```

**Expected output:** JSON array of links:
```json
[
  { "href": "/about", "text": "About Us", "rel": "", "target": "", "external": false, "nofollow": false },
  { "href": "https://twitter.com/example", "text": "Twitter", "rel": "noopener", "target": "_blank", "external": true, "nofollow": false }
]
```

Filter links by URL or text substring:

```json
{ "tool": "safari_extract_links", "arguments": { "filter": "github.com", "limit": 20 } }
```

## 3. Extract meta tags, OG data, and structured data

Get everything search engines and social platforms see: title, description, Open Graph, Twitter Cards, JSON-LD, canonical URL, and alternate languages.

```json
{ "tool": "safari_extract_meta", "arguments": {} }
```

**Expected output:**
```json
{
  "title": "Safari MCP - Browser Automation for AI Agents",
  "description": "80 tools for native Safari automation...",
  "canonical": "https://example.com/safari-mcp",
  "og": {
    "og:title": "Safari MCP",
    "og:description": "Native browser automation...",
    "og:image": "https://example.com/og-image.png",
    "og:type": "website"
  },
  "twitter": {
    "twitter:card": "summary_large_image",
    "twitter:title": "Safari MCP"
  },
  "jsonLd": [{ "@type": "SoftwareApplication", "name": "Safari MCP" }],
  "alternates": [{ "hrefLang": "he", "href": "https://example.com/he/" }]
}
```

## 4. Extract images with dimensions and loading info

Audit images on a page -- find missing alt text, oversized images, or lazy-loading issues.

```json
{ "tool": "safari_extract_images", "arguments": {} }
```

**Expected output:** Array of images with src, alt, dimensions, loading attribute, and whether the image is visible in the viewport.

## 5. Extract arbitrary data with JavaScript

For data that doesn't fit neatly into tables or links, use `safari_evaluate` to run custom extraction.

```json
// Extract all product prices from an e-commerce page
{
  "tool": "safari_evaluate",
  "arguments": {
    "expression": "JSON.stringify([...document.querySelectorAll('.product-card')].map(card => ({ name: card.querySelector('h3')?.textContent?.trim(), price: card.querySelector('.price')?.textContent?.trim(), inStock: !card.querySelector('.out-of-stock') })))"
  }
}
```

**Expected output:** Custom JSON with exactly the data you need:
```json
[
  { "name": "Wireless Mouse", "price": "$29.99", "inStock": true },
  { "name": "USB-C Hub", "price": "$49.99", "inStock": true },
  { "name": "Webcam HD", "price": "$79.99", "inStock": false }
]
```

## 6. Read page text content

Get the readable text content of a page, useful for summarization or content analysis.

```json
// Read the full page
{ "tool": "safari_read_page", "arguments": {} }

// Read only a specific section
{ "tool": "safari_read_page", "arguments": { "selector": "article.main-content", "maxLength": 10000 } }
```

**Expected output:** Title, URL, and the text content of the page (or selected element), stripped of HTML tags.

## 7. Combine extraction with authenticated access

The real power: extract data from pages that require login. Since Safari MCP uses your actual browser session, you can scrape dashboards you are already logged into.

```json
// Google Search Console -- already logged in via Safari
{ "tool": "safari_new_tab", "arguments": { "url": "https://search.google.com/search-console/performance/search-analytics?resource_id=https://example.com/" } }

// Wait for the performance table to load
{ "tool": "safari_wait_for", "arguments": { "selector": "table", "timeout": 10000 } }

// Extract the search queries table
{ "tool": "safari_extract_tables", "arguments": { "selector": "table", "limit": 1 } }
```

**Expected output:** Your actual Search Console data as structured JSON -- no API keys or OAuth setup needed.
