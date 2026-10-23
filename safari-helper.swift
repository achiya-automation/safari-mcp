// safari-helper: persistent AppleScript daemon + CGEvent native click
// Replaces osascript subprocess (~80ms) with NSAppleScript in-process (~5ms)
// Also provides OS-level mouse clicks via CGEvent (produces isTrusted: true events)
//
// Input: JSON lines on stdin
//   {"script": "full applescript"}           — run AppleScript
//   {"click": {"x": 500, "y": 300, "windowId": 4127}}  — CGEvent click targeted to window
//   {"click": {"x": 500, "y": 300, "windowId": 4127, "double": true}}  — double-click
//   (windowId is optional — if omitted, falls back to global post)
// Output: JSON lines {"result": "..."} or {"error": "..."} on stdout

import Foundation
import Darwin
import CoreGraphics
import AppKit
import ApplicationServices

// ========== Accessibility preflight (issue #29) ==========
// Posting synthetic CGEvents requires Accessibility, and macOS 26 (Tahoe) tightened the
// post-event TCC grant. Without it, post()/postToPid SILENTLY no-op — yet the old code
// still returned a "clicked"/"hovered"/"key pressed" success, so the page never reacted
// and the agent had no idea. Check first and fail honestly so the Node layer can surface
// an actionable error instead of a phantom success.
func ensurePostEventAccess() -> [String: Any]? {
  if CGPreflightPostEventAccess() { return nil }
  // Triggers the one-time system Accessibility prompt for this binary; returns immediately
  // (does not block for the user's decision) and is a no-op once the choice is remembered.
  CGRequestPostEventAccess()
  return [
    "error": "accessibility-not-granted",
    "needsApproval": true,
    "hint": "Grant Accessibility to safari-helper: System Settings > Privacy & Security > Accessibility, then retry."
  ]
}

// ========== CGEvent Native Hover ==========
// Moves the mouse cursor to a target position to trigger native :hover / mouseenter
// without clicking. Used for revealing tooltips on obfuscated UIs (Discord sidebar,
// virtualized server lists, custom React tooltips) where JS-dispatched mouseenter
// events aren't enough because the rendering depends on CSS :hover or real pointer
// position. Optionally restores the original cursor position after dwell.
func performNativeHover(x: Double, y: Double, windowId: Int64 = 0, dwellMs: Int = 500, restoreMouse: Bool = true) -> [String: Any] {
  if let denied = ensurePostEventAccess() { return denied }
  let point = CGPoint(x: x, y: y)
  // nil when the cursor position can't be read (e.g. Accessibility just revoked) —
  // restoring to a fabricated (0,0) would visibly throw the cursor into the corner.
  let savedPosition = CGEvent(source: nil)?.location

  // Get Safari PID for process-targeted event posting (background hover, no focus steal)
  var safariPID: pid_t = 0
  if windowId > 0 {
    let ws = NSWorkspace.shared
    for app in ws.runningApplications {
      if app.bundleIdentifier == "com.apple.Safari" {
        safariPID = app.processIdentifier
        break
      }
    }
  }

  let kWindowField = CGEventField(rawValue: 91)! // windowUnderMousePointer
  let kWindowHandlerField = CGEventField(rawValue: 92)! // windowThatCanHandleThisEvent

  func postMove(_ position: CGPoint) {
    guard let ev = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: position, mouseButton: .left) else { return }
    if windowId > 0 && safariPID > 0 {
      ev.setIntegerValueField(kWindowField, value: windowId)
      ev.setIntegerValueField(kWindowHandlerField, value: windowId)
      ev.postToPid(safariPID)
    } else {
      ev.post(tap: .cghidEventTap)
    }
  }

  postMove(point)
  let ms = max(0, min(dwellMs, 5000)) // clamp 0-5000ms to prevent runaway blocking
  usleep(UInt32(ms * 1000))
  if restoreMouse, let savedPosition = savedPosition {
    postMove(savedPosition)
  }

  let targetInfo = windowId > 0 ? " (window \(windowId), background)" : ""
  return ["result": "hovered at (\(Int(x)),\(Int(y))) for \(ms)ms\(targetInfo)\(restoreMouse ? " (mouse restored)" : "")"]
}


// ========== Accessibility Press (macOS 26-safe "real" click) ==========
// CGEvent clicks posted to a background window silently no-op on macOS 26 (issue #29).
// The Accessibility press action does NOT go through the HID/CGEvent path — it asks the
// app to activate the control directly, and WebKit turns it into an isTrusted DOM click.
// This is what actually works on Tahoe where CGEvent is filtered. Coordinate is a global
// top-left screen point (same space CGEvent uses).
func axPressAtPoint(x: Double, y: Double) -> Bool {
  let sysWide = AXUIElementCreateSystemWide()
  var elementRef: AXUIElement?
  let hit = AXUIElementCopyElementAtPosition(sysWide, Float(x), Float(y), &elementRef)
  guard hit == .success, let hitEl = elementRef else { return false }

  // Walk up from the hit element: the deepest element under the point may be a text/image
  // leaf; the pressable control (AXButton / link) is often an ancestor.
  var current: AXUIElement? = hitEl
  var depth = 0
  while let c = current, depth < 8 {
    var actionsRef: CFArray?
    if AXUIElementCopyActionNames(c, &actionsRef) == .success,
       let actions = actionsRef as? [String], actions.contains(kAXPressAction as String) {
      if AXUIElementPerformAction(c, kAXPressAction as CFString) == .success {
        return true
      }
    }
    var parentRef: CFTypeRef?
    if AXUIElementCopyAttributeValue(c, kAXParentAttribute as CFString, &parentRef) == .success,
       let parent = parentRef, CFGetTypeID(parent) == AXUIElementGetTypeID() {
      current = (parent as! AXUIElement)
    } else {
      current = nil
    }
    depth += 1
  }
  return false
}


// ========== AX act on a web element by DOM id — the focus-free "real" input ==========
// WebKit exposes each element's id as AXDOMIdentifier. The Node side stamps the target
// with a unique id, and this finds it in Safari's AX tree and acts on it directly:
//   press — WebKit fires mousedown/mouseup/click, all isTrusted
//   value — WebKit fires beforeinput/input, isTrusted, any script (Hebrew included)
//   focus — moves DOM focus to the element
// No activate, no window raise, no cursor warp, no CGEvent: Safari can stay behind
// whatever the user is working in. The element must be in its window's SELECTED tab
// (only that tab is in the AX tree) — the caller fronts the tab within its window first.
func axDomAct(domId: String, action: String, value: String?) -> [String: Any] {
  if !AXIsProcessTrusted() {
    return ["error": "accessibility-not-granted", "needsApproval": true,
            "hint": "Grant Accessibility to safari-helper: System Settings > Privacy & Security > Accessibility, then retry."]
  }
  guard let safari = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.Safari").first else {
    return ["error": "Safari process not found"]
  }
  let app = AXUIElementCreateApplication(safari.processIdentifier)
  // Exposes the web content tree to an external AX client (what VoiceOver turns on).
  AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue)

  func str(_ el: AXUIElement, _ n: String) -> String? {
    var v: CFTypeRef?
    guard AXUIElementCopyAttributeValue(el, n as CFString, &v) == .success, let val = v,
          CFGetTypeID(val) == CFStringGetTypeID() else { return nil }
    return (val as! CFString) as String
  }
  // BFS over the windows only — the menu bar alone is thousands of nodes (bookmarks,
  // history). A read index, since removeFirst() would make a big page quadratic.
  var winsRef: CFTypeRef?
  guard AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &winsRef) == .success,
        let windows = winsRef as? [AXUIElement], !windows.isEmpty else {
    return ["error": "ax-no-windows — Safari has no window, or the screen is locked"]
  }
  let deadline = Date().addingTimeInterval(8)
  var queue: [AXUIElement] = windows
  var head = 0
  var found: AXUIElement?
  while head < queue.count && head < 100_000 && Date() < deadline {
    let el = queue[head]; head += 1
    // With the console locked, macOS hands back the application element where a window
    // should be — a cycle that never reaches web content. Nothing to find there.
    if str(el, kAXRoleAttribute as String) == "AXApplication" { continue }
    if str(el, "AXDOMIdentifier") == domId { found = el; break }
    var kidsRef: CFTypeRef?
    if AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &kidsRef) == .success,
       let kids = kidsRef as? [AXUIElement] { queue.append(contentsOf: kids) }
  }
  guard let el = found else {
    return ["error": "ax-dom-not-found (visited \(head) nodes) — the tab must be the selected tab of its window"]
  }
  let role = str(el, kAXRoleAttribute as String) ?? "?"
  var err: AXError
  switch action {
  case "press":
    err = AXUIElementPerformAction(el, kAXPressAction as CFString)
  case "focus":
    err = AXUIElementSetAttributeValue(el, kAXFocusedAttribute as CFString, kCFBooleanTrue)
  case "value":
    AXUIElementSetAttributeValue(el, kAXFocusedAttribute as CFString, kCFBooleanTrue)
    err = AXUIElementSetAttributeValue(el, kAXValueAttribute as CFString, (value ?? "") as CFString)
  default:
    return ["error": "unknown axDom action: \(action)"]
  }
  if err != .success { return ["error": "ax-\(action)-failed (\(err.rawValue)) on \(role)"] }
  return ["result": "ax \(action) on \(role) (\(head) nodes)"]
}


// ========== CGEvent Native Click ==========
// Performs a REAL OS-level mouse click that produces isTrusted: true in the browser.
// Requires Accessibility permissions (same as AppleScript automation).

func performNativeClick(x: Double, y: Double, doubleClick: Bool = false, windowId: Int64 = 0) -> [String: Any] {
  if let denied = ensurePostEventAccess() { return denied }
  let point = CGPoint(x: x, y: y)

  // macOS 26-safe path first: Accessibility press produces an isTrusted click even when
  // CGEvent-to-background-window is filtered. Only for single clicks (AX has no double).
  if !doubleClick {
    if axPressAtPoint(x: x, y: y) {
      return ["result": "clicked at (\(Int(x)),\(Int(y))) [axpress]"]
    }
  }

  // --- Window-targeted click ---
  // When windowId is provided, we set CGEventField.windowNumber on the event.
  // This sends the click to the specific window WITHOUT moving the physical mouse
  // and WITHOUT bringing Safari to the foreground.
  // When windowId is 0 (not provided), fall back to global post (legacy behavior).

  // Get Safari PID for process-targeted event posting (when windowId is set)
  var safariPID: pid_t = 0
  if windowId > 0 {
    let ws = NSWorkspace.shared
    for app in ws.runningApplications {
      if app.bundleIdentifier == "com.apple.Safari" {
        safariPID = app.processIdentifier
        break
      }
    }
    if safariPID == 0 {
      return ["error": "Safari process not found"]
    }
  }

  // Helper: configure event with window targeting
  // kCGMouseEventWindowUnderMousePointer = 91 (not bridged to Swift CGEventField)
  // kCGMouseEventWindowUnderMousePointerThatCanHandleThisEvent = 92
  let kWindowField = CGEventField(rawValue: 91)! // windowUnderMousePointer
  let kWindowHandlerField = CGEventField(rawValue: 92)! // windowThatCanHandleThisEvent

  func configureEvent(_ event: CGEvent) {
    if windowId > 0 {
      // Target the specific window — the event goes to that window
      // even if it's behind other windows, and the mouse stays where it is.
      event.setIntegerValueField(kWindowField, value: windowId)
      event.setIntegerValueField(kWindowHandlerField, value: windowId)
    }
  }

  // Helper: post event — to Safari process if targeted, global otherwise
  func postEvent(_ event: CGEvent) {
    if windowId > 0 {
      event.postToPid(safariPID)
    } else {
      event.post(tap: .cghidEventTap)
    }
  }

  if windowId == 0 {
    // Legacy path: no window targeting. Move mouse + restore (old behavior).
    // Optional: when the position can't be read, skip the restore instead of
    // jumping the cursor to a fabricated (0,0).
    let savedPosition = CGEvent(source: nil)?.location
    defer {
      if let savedPosition = savedPosition,
         let restoreEvent = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: savedPosition, mouseButton: .left) {
        restoreEvent.post(tap: .cghidEventTap)
      }
    }
    guard let moveEvent = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left) else {
      return ["error": "Failed to create mouse move event"]
    }
    moveEvent.post(tap: .cghidEventTap)
    usleep(20_000)
  }
  // When windowId > 0, we do NOT move the mouse at all.

  // Create mouse down/up events at the target coordinates
  guard let downEvent = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left) else {
    return ["error": "Failed to create mouse down event"]
  }
  guard let upEvent = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left) else {
    return ["error": "Failed to create mouse up event"]
  }
  configureEvent(downEvent)
  configureEvent(upEvent)

  if doubleClick {
    // First click
    downEvent.setIntegerValueField(.mouseEventClickState, value: 1)
    upEvent.setIntegerValueField(.mouseEventClickState, value: 1)
    postEvent(downEvent)
    usleep(50_000)
    postEvent(upEvent)
    usleep(50_000)

    // Second click
    guard let down2 = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left) else {
      return ["error": "Failed to create second mouse down event"]
    }
    guard let up2 = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left) else {
      return ["error": "Failed to create second mouse up event"]
    }
    configureEvent(down2)
    configureEvent(up2)
    down2.setIntegerValueField(.mouseEventClickState, value: 2)
    up2.setIntegerValueField(.mouseEventClickState, value: 2)
    postEvent(down2)
    usleep(50_000)
    postEvent(up2)
  } else {
    // Single click
    downEvent.setIntegerValueField(.mouseEventClickState, value: 1)
    upEvent.setIntegerValueField(.mouseEventClickState, value: 1)
    postEvent(downEvent)
    usleep(50_000)
    postEvent(upEvent)
  }

  let targetInfo = windowId > 0 ? " (window \(windowId), background)" : ""
  return ["result": "clicked at (\(Int(x)),\(Int(y)))\(doubleClick ? " (double)" : "")\(targetInfo)"]
}

// ========== CGEvent Native Keyboard ==========
// Sends keyboard events (keystrokes, shortcuts) targeted to a specific window
// WITHOUT activating Safari or stealing focus. Same principle as native click.

func performNativeKeyboard(keyCode: UInt16, flags: CGEventFlags = [], windowId: Int64 = 0) -> [String: Any] {
  if let denied = ensurePostEventAccess() { return denied }
  // Get Safari PID
  var safariPID: pid_t = 0
  if windowId > 0 {
    let ws = NSWorkspace.shared
    for app in ws.runningApplications {
      if app.bundleIdentifier == "com.apple.Safari" {
        safariPID = app.processIdentifier
        break
      }
    }
    if safariPID == 0 {
      return ["error": "Safari process not found"]
    }
  }

  let kWindowField = CGEventField(rawValue: 91)!
  let kWindowHandlerField = CGEventField(rawValue: 92)!

  guard let keyDown = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: true) else {
    return ["error": "Failed to create key down event"]
  }
  guard let keyUp = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: false) else {
    return ["error": "Failed to create key up event"]
  }

  keyDown.flags = flags
  keyUp.flags = flags

  if windowId > 0 {
    keyDown.setIntegerValueField(kWindowField, value: windowId)
    keyDown.setIntegerValueField(kWindowHandlerField, value: windowId)
    keyUp.setIntegerValueField(kWindowField, value: windowId)
    keyUp.setIntegerValueField(kWindowHandlerField, value: windowId)
    keyDown.postToPid(safariPID)
    usleep(30_000)
    keyUp.postToPid(safariPID)
  } else {
    keyDown.post(tap: .cghidEventTap)
    usleep(30_000)
    keyUp.post(tap: .cghidEventTap)
  }

  let targetInfo = windowId > 0 ? " (window \(windowId), background)" : ""
  return ["result": "key \(keyCode) pressed\(targetInfo)"]
}

// ========== Response Helper ==========

// Replies are emitted from several background queues at once (one per in-flight
// AppleScript), so the write itself must be atomic: print() is not, and two
// concurrent writers can interleave bytes mid-line and corrupt both JSON objects.
// This lock guards only the write — microseconds — and never waits on AppleScript.
let _stdoutLock = NSLock()

func emitResponse(_ obj: [String: Any]) {
  _stdoutLock.lock()
  defer { _stdoutLock.unlock() }
  if let data = try? JSONSerialization.data(withJSONObject: obj),
     let str = String(data: data, encoding: .utf8) {
    print(str)
  } else {
    print("{\"error\":\"serialization failed\"}")
  }
  fflush(stdout)
}

// CLI-mode call sites (--click and friends) have no request id to echo.
func respond(_ obj: [String: Any]) {
  emitResponse(obj)
}

// ========== CLI Mode: --click X Y [--window WID] [--double] ==========
// For direct invocation: safari-helper --click 500 300 --window 4127

let args = CommandLine.arguments
if args.count >= 4 && args[1] == "--click" {
  guard let x = Double(args[2]), let y = Double(args[3]) else {
    respond(["error": "Invalid coordinates: \(args[2]) \(args[3])"])
    exit(1)
  }
  var isDouble = false
  var windowId: Int64 = 0
  var i = 4
  while i < args.count {
    if args[i] == "--double" {
      isDouble = true
    } else if args[i] == "--window" && i + 1 < args.count {
      windowId = Int64(args[i + 1]) ?? 0
      i += 1
    }
    i += 1
  }
  let result = performNativeClick(x: x, y: y, doubleClick: isDouble, windowId: windowId)
  respond(result)
  exit(result["error"] != nil ? 1 : 0)
}

// ========== CLI Mode: --paste --window WID ==========
// Convenience: Cmd+V via CGEvent (no activate needed)
if args.count >= 2 && args[1] == "--paste" {
  var windowId: Int64 = 0
  var i = 2
  while i < args.count {
    if args[i] == "--window" && i + 1 < args.count {
      windowId = Int64(args[i + 1]) ?? 0
      i += 1
    }
    i += 1
  }
  // keyCode 9 = V key
  let result = performNativeKeyboard(keyCode: 9, flags: .maskCommand, windowId: windowId)
  respond(result)
  exit(result["error"] != nil ? 1 : 0)
}

// ========== Daemon Mode: JSON lines on stdin ==========

// Counts AppleScript executions currently blocked inside executeAndReturnError.
// Each 30s timeout leaves its GCD thread stuck there, and the global pool is
// finite (~64 threads): past a small threshold the daemon exits so the Node
// watchdog respawns a clean one instead of degrading into a wedged process
// that accepts stdin but can no longer dispatch work.
let _inFlightLock = NSLock()
var _inFlightScripts = 0
// Scripts that blew their own timeout and left their GCD thread parked inside
// executeAndReturnError. Concurrency made the plain in-flight count useless as a
// wedge signal: N genuinely parallel commands are healthy, N *stuck* ones are not.
var _stuckScripts = 0

final class _ScriptState {
  var finished = false
  var timedOut = false
}

// AppleScript execution is serialized on purpose. NSAppleScript is not thread-safe:
// two concurrent executeAndReturnError() calls clobber each other's state, and a
// measured run had a 3-second script return the *next* script's result under its own
// request id — silent cross-talk, the worst possible failure for a measurement tool.
// Safari processes Apple Events one at a time regardless, so a serial queue costs no
// real throughput. What it buys is that the stdin reader never waits on it: native
// commands (clicks, keystrokes, front-app checks) and every other session keep moving
// while a heavy `do JavaScript` is still running.
let _appleScriptQueue = DispatchQueue(label: "com.achiya-automation.safari-mcp.applescript")

func handleLine(_ line: String) {
  guard !line.isEmpty else { return }

  guard let data = line.data(using: .utf8),
        let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
    // Unparseable line: there is no id to echo, and the shadowing respond() below
    // does not exist yet from this guard's point of view.
    emitResponse(["error": "invalid input"])
    return
  }

  // Echo the caller's request id on every reply. Commands now finish out of order,
  // so the Node side matches replies by identity instead of by arrival order — that
  // is what lets several checks run at once instead of queueing behind each other.
  // Shadows the global respond(), so every call site below tags itself for free.
  let requestId = json["id"]
  func respond(_ obj: [String: Any]) {
    guard let rid = requestId else { emitResponse(obj); return }
    var tagged = obj
    tagged["id"] = rid
    emitResponse(tagged)
  }

  // {"axDom": {"id": "mcpax-…", "action": "press"|"value"|"focus", "value": "…"}}
  if let ad = json["axDom"] as? [String: Any], let domId = ad["id"] as? String {
    respond(axDomAct(domId: domId, action: (ad["action"] as? String) ?? "press", value: ad["value"] as? String))
    return
  }

  // Handle CGEvent click command
  if let clickData = json["click"] as? [String: Any],
     let x = clickData["x"] as? Double,
     let y = clickData["y"] as? Double {
    let isDouble = (clickData["double"] as? Bool) ?? false
    let windowId = Int64((clickData["windowId"] as? Int) ?? 0)
    respond(performNativeClick(x: x, y: y, doubleClick: isDouble, windowId: windowId))
    return
  }

  // Handle CGEvent hover command — native mouse move to trigger real :hover / mouseenter
  // {"hover": {"x": 500, "y": 300, "windowId": 4127, "dwellMs": 500, "restoreMouse": true}}
  if let hoverData = json["hover"] as? [String: Any],
     let x = hoverData["x"] as? Double,
     let y = hoverData["y"] as? Double {
    let windowId = Int64((hoverData["windowId"] as? Int) ?? 0)
    let dwellMs = (hoverData["dwellMs"] as? Int) ?? 500
    let restoreMouse = (hoverData["restoreMouse"] as? Bool) ?? true
    respond(performNativeHover(x: x, y: y, windowId: windowId, dwellMs: dwellMs, restoreMouse: restoreMouse))
    return
  }

  // Handle CGEvent keyboard command
  // {"keyboard": {"keyCode": 9, "flags": ["cmd"], "windowId": 4127}}
  // keyCode 9 = V, flags: cmd/shift/alt/ctrl
  if let kbData = json["keyboard"] as? [String: Any],
     let keyCode = kbData["keyCode"] as? Int {
    // CGEvent virtualKey is UInt16 — a JSON value outside 0...65535 would trap the daemon
    // on the UInt16() conversion below. Validate before converting.
    guard keyCode >= 0 && keyCode <= 0xFFFF else {
      respond(["error": "keyCode out of range (0-65535): \(keyCode)"])
      return
    }
    let windowId = Int64((kbData["windowId"] as? Int) ?? 0)
    var flags: CGEventFlags = []
    if let flagNames = kbData["flags"] as? [String] {
      for f in flagNames {
        switch f.lowercased() {
          case "cmd": flags.insert(.maskCommand)
          case "shift": flags.insert(.maskShift)
          case "alt", "option": flags.insert(.maskAlternate)
          case "ctrl", "control": flags.insert(.maskControl)
          default: break
        }
      }
    }
    respond(performNativeKeyboard(keyCode: UInt16(keyCode), flags: flags, windowId: windowId))
    return
  }

  // Handle preflight — report permission state WITHOUT acting. Used by safari_doctor
  // to turn the silent-failure permission chain into an actionable checklist (issue #29/#14/#15).
  if json["preflight"] != nil {
    respond([
      "result": "preflight",
      "accessibility": CGPreflightPostEventAccess(),
      "screenRecording": CGPreflightScreenCaptureAccess()
    ])
    return
  }

  // Handle getFrontApp — returns frontmost application bundle ID (native, ~0.1ms)
  if json["getFrontApp"] != nil {
    let frontApp = NSWorkspace.shared.frontmostApplication
    respond(["result": frontApp?.localizedName ?? "", "bundleId": frontApp?.bundleIdentifier ?? ""])
    return
  }

  // Handle activateApp — activate a specific app by bundle ID (native, ~1ms)
  // Used to restore focus to previous app instead of hiding Safari (less jarring)
  if let bundleId = json["activateApp"] as? String {
    if let app = NSRunningApplication.runningApplications(withBundleIdentifier: bundleId).first {
      app.activate()
      respond(["result": "activated"])
    } else {
      respond(["error": "app not found: \(bundleId)"])
    }
    return
  }

  // Handle hideSafari — hide Safari to prevent focus stealing (native, ~1ms)
  if json["hideSafari"] != nil {
    if let safariApp = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.Safari").first {
      safariApp.hide()
      respond(["result": "hidden"])
    } else {
      respond(["error": "Safari not running"])
    }
    return
  }

  // Handle AppleScript command
  guard let script = json["script"] as? String else {
    respond(["error": "invalid input — expected 'script', 'click', 'keyboard', 'getFrontApp', or 'hideSafari'"])
    return
  }

  // Focus preservation is handled by the Node.js layer (osascript() function
  // and extensionOrFallback). The daemon must NOT manage focus — it runs every
  // 3 seconds for background checks, and restoring focus here steals Safari
  // from the user whenever they switch to it.

  guard let nsScript = NSAppleScript(source: script) else {
    respond(["error": "failed to compile AppleScript"])
    return
  }

  // Execute AND await on background threads so stdin reading never blocks.
  // Heavy pages (SourceForge, etc.) can cause executeAndReturnError() to block
  // for 10-30+ seconds. Dispatching the execution alone was not enough: handleLine
  // still waited on the semaphore inline, so one slow `do JavaScript` stalled every
  // later command — including native ones that never touch Apple Events — and a
  // second session sharing this Safari looked completely dead for 30s at a time.
  _inFlightLock.lock()
  let alreadyStuck = _stuckScripts
  _inFlightLock.unlock()
  if alreadyStuck >= 8 {
    respond(["error": "daemon wedged: \(alreadyStuck) AppleScript executions still blocked past their timeout — exiting for a clean respawn"])
    exit(1)
  }

  _inFlightLock.lock(); _inFlightScripts += 1; _inFlightLock.unlock()

  // handleLine returns immediately; the reply is delivered from this queue when the
  // script finishes. The autorelease pool moves in here with it, so each command
  // still drains its own NSAppleScript instead of retaining it until process exit.
  _appleScriptQueue.async {
    autoreleasepool {
      let state = _ScriptState()
      let semaphore = DispatchSemaphore(value: 0)
      var scriptResult: NSAppleEventDescriptor?
      var scriptError: NSDictionary?

      DispatchQueue.global(qos: .userInitiated).async {
        var errorDict: NSDictionary?
        scriptResult = nsScript.executeAndReturnError(&errorDict)
        scriptError = errorDict
        _inFlightLock.lock()
        _inFlightScripts -= 1
        state.finished = true
        // A late finish frees the parked thread, so stop counting it as wedged.
        if state.timedOut { _stuckScripts -= 1 }
        _inFlightLock.unlock()
        semaphore.signal()
      }

      // Wait up to 30 seconds for the script to complete. On timeout the thread stays
      // parked inside executeAndReturnError, so charge it against the wedge budget.
      if semaphore.wait(timeout: .now() + 30.0) == .timedOut {
        _inFlightLock.lock()
        // finished may have landed in the same instant; only a real overrun counts.
        if !state.finished {
          state.timedOut = true
          _stuckScripts += 1
        }
        _inFlightLock.unlock()
        respond(["error": "AppleScript execution timed out (30s)"])
      } else if let error = scriptError {
        let msg = (error["NSAppleScriptErrorMessage"] as? String) ?? "AppleScript error"
        respond(["error": msg])
      } else {
        respond(["result": scriptResult?.stringValue ?? ""])
      }
    }
  }
}

while let line = readLine(strippingNewline: true) {
  // Command-line Swift has no runloop, so the implicit top-level autorelease pool
  // never drains — every NSAppleScript / NSDictionary allocated per command was
  // retained until process exit. Drain per command.
  autoreleasepool { handleLine(line) }
}

// stdin closed. Two very different callers reach this line.
//
// A one-shot invocation — `echo '{"script":"…"}' | safari-helper` — closes stdin the
// instant the command is written, long before the script it just asked for has run.
// Replies are emitted asynchronously now, so exiting here would drop the answer on
// the floor and the caller would read nothing at all.
//
// A dead parent (clean shutdown or crash) has nobody left to read results, and GCD
// threads still blocked inside executeAndReturnError would keep this process alive as
// an orphan holding Apple Events / Accessibility grants.
//
// Draining the serial queue serves both: it returns immediately when nothing is in
// flight (the dead-parent case), and waits just long enough for work already running
// to answer. The bound is one script timeout, so a wedged script can't strand us.
let drained = DispatchSemaphore(value: 0)
_appleScriptQueue.async { drained.signal() }
_ = drained.wait(timeout: .now() + 35.0)
exit(0)
