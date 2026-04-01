/**
 * Safari MCP — TypeScript type declarations
 * Covers all ~80 registered tools and the MCP server export.
 */

// ========== CORE TYPES ==========

export interface MCPContent {
  type: "text" | "image";
  text?: string;
  data?: string;
  mimeType?: string;
}

export interface MCPToolResult {
  content: MCPContent[];
  isError?: boolean;
}

export interface MCPToolInputSchema {
  type: "object";
  properties: Record<string, { type: string; description?: string; enum?: string[] }>;
  required?: string[];
}

export interface MCPTool<TInput extends Record<string, unknown> = Record<string, unknown>> {
  name: string;
  description: string;
  inputSchema: MCPToolInputSchema;
  handler: (input: TInput) => Promise<MCPToolResult>;
}

export interface MCPServer {
  name: string;
  version: string;
  description: string;
  tool: <TInput extends Record<string, unknown>>(
    name: string,
    description: string,
    schema: Record<string, unknown>,
    handler: (input: TInput) => Promise<MCPToolResult>
  ) => void;
}

// ========== TOOL INPUT TYPES ==========

// Navigation
export interface SafariNavigateInput { url: string }
export interface SafariGoBackInput {}
export interface SafariGoForwardInput {}
export interface SafariReloadInput { hard?: boolean }
export interface SafariNavigateAndReadInput { url: string; maxLength?: number; timeout?: number }

// Page Info
export interface SafariReadPageInput { selector?: string; maxLength?: number }
export interface SafariGetSourceInput { maxLength?: number }
export interface SafariSnapshotInput { selector?: string }

// Click
export interface SafariClickInput { ref?: string; selector?: string; text?: string; x?: number; y?: number }
export interface SafariClickAndReadInput { text?: string; selector?: string; x?: number; y?: number; wait?: number; maxLength?: number }
export interface SafariDoubleClickInput { selector?: string; x?: number; y?: number }
export interface SafariRightClickInput { selector?: string; x?: number; y?: number }
export interface SafariNativeClickInput { ref?: string; selector?: string; text?: string; x?: number; y?: number; doubleClick?: boolean }

// Form Input
export interface SafariFillInput { ref?: string; selector?: string; value: string }
export interface SafariClearFieldInput { selector: string }
export interface SafariSelectOptionInput { selector: string; value: string }
export interface SafariFillFormField { selector: string; value: string }
export interface SafariFillFormInput { fields: SafariFillFormField[] }

// Keyboard
export interface SafariPressKeyInput { key: string; modifiers?: string[] }
export interface SafariTypeTextInput { text: string; ref?: string; selector?: string }

// Code Editor
export interface SafariReplaceEditorInput { text: string }

// Screenshot
export interface SafariScreenshotInput { fullPage?: boolean }
export interface SafariScreenshotElementInput { selector: string }

// Scroll
export interface SafariScrollInput { direction?: "up" | "down"; amount?: number }
export interface SafariScrollToInput { x?: number; y?: number }
export interface SafariScrollToElementInput {
  selector?: string;
  text?: string;
  block?: "start" | "center" | "end" | "nearest";
  timeout?: number;
}

// Tab Management
export interface SafariListTabsInput {}
export interface SafariNewTabInput { url?: string }
export interface SafariCloseTabInput {}
export interface SafariSwitchTabInput { index: number }
export interface SafariWaitForNewTabInput { timeout?: number; urlContains?: string }

// Wait
export interface SafariWaitForInput { selector?: string; text?: string; timeout?: number }
export interface SafariWaitInput { ms: number }

// Evaluate
export interface SafariEvaluateInput { script: string }

// Element Info
export interface SafariGetElementInput { selector: string }
export interface SafariQueryAllInput { selector: string; limit?: number }

// Hover
export interface SafariHoverInput { ref?: string; selector?: string; x?: number; y?: number }

// Dialog
export interface SafariHandleDialogInput { action?: "accept" | "dismiss"; text?: string }

// Window
export interface SafariResizeInput { width: number; height: number }

// Drag
export interface SafariDragInput {
  sourceSelector?: string;
  targetSelector?: string;
  sourceX?: number;
  sourceY?: number;
  targetX?: number;
  targetY?: number;
}

// File / Image
export interface SafariUploadFileInput { selector: string; filePath: string }
export interface SafariPasteImageInput { filePath: string }

// Emulation
export interface SafariEmulateInput { device?: string; width?: number; height?: number; userAgent?: string; scale?: number }
export interface SafariResetEmulationInput {}

// Cookies & Storage
export interface SafariGetCookiesInput {}
export interface SafariLocalStorageInput { key?: string }
export interface SafariSetCookieInput {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  expires?: string;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
}
export interface SafariDeleteCookiesInput { name?: string; all?: boolean }
export interface SafariSessionStorageInput { key?: string }
export interface SafariSetSessionStorageInput { key: string; value: string }
export interface SafariSetLocalStorageInput { key: string; value: string }
export interface SafariDeleteLocalStorageInput { key?: string }
export interface SafariDeleteSessionStorageInput { key?: string }
export interface SafariExportStorageInput {}
export interface SafariImportStorageInput { state: string }

// Clipboard
export interface SafariClipboardReadInput {}
export interface SafariClipboardWriteInput { text: string }

// Network
export interface SafariNetworkInput { limit?: number }
export interface SafariMockRouteResponse { status?: number; body?: string; contentType?: string }
export interface SafariMockRouteInput { urlPattern: string; response: SafariMockRouteResponse }
export interface SafariClearMocksInput {}
export interface SafariStartNetworkCaptureInput {}
export interface SafariNetworkDetailsInput { limit?: number; filter?: string }
export interface SafariClearNetworkInput {}
export interface SafariThrottleNetworkInput { profile?: string; latency?: number; downloadKbps?: number }

// Console
export interface SafariStartConsoleInput {}
export interface SafariGetConsoleInput {}
export interface SafariClearConsoleInput {}
export interface SafariConsoleFilterInput { level: "log" | "warn" | "error" | "info" }

// PDF
export interface SafariSavePDFInput { path: string }

// Accessibility
export interface SafariAccessibilitySnapshotInput { selector?: string; maxDepth?: number }

// Performance
export interface SafariPerformanceMetricsInput {}
export interface SafariCSSCoverageInput {}

// Data Extraction
export interface SafariExtractTablesInput { selector?: string; limit?: number }
export interface SafariExtractMetaInput {}
export interface SafariExtractImagesInput { limit?: number }
export interface SafariExtractLinksInput { limit?: number; filter?: string }

// Geolocation
export interface SafariOverrideGeolocationInput { latitude: number; longitude: number; accuracy?: number }

// Computed Styles
export interface SafariGetComputedStyleInput { selector: string; properties?: string[] }

// IndexedDB
export interface SafariListIndexedDBsInput {}
export interface SafariGetIndexedDBInput { dbName: string; storeName: string; limit?: number }

// Form Detection
export interface SafariDetectFormsInput {}

// Batch / Combo Tools
export interface SafariRunScriptStep { action: string; args?: Record<string, unknown> }
export interface SafariRunScriptInput { steps: SafariRunScriptStep[] }
export interface SafariClickAndWaitInput { selector?: string; text?: string; waitFor?: string; timeout?: number }
export interface SafariFillAndSubmitInput { fields: SafariFillFormField[]; submitSelector?: string }
export interface SafariAnalyzePageInput {}

// ========== TAB INFO ==========

export interface SafariTab {
  index: number;
  title: string;
  url: string;
}

// ========== MODULE DECLARATION ==========
// safari-mcp runs as a stdio MCP server process. It does not export values at
// runtime, but consumers can import these types for type-safe MCP client code.

declare const server: MCPServer;
export default server;