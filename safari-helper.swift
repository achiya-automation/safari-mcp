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


// ========== Accessibility Press by title (z-order & focus immune) ==========
// Coordinate hit-testing returns whatever window is frontmost at the point, so on a
// contended desktop it presses the wrong thing (or nothing). Searching Safari's own AX
// tree for a button by its title/description finds the control regardless of window
// stacking or focus, and pressing it produces an isTrusted DOM click that macOS 26 honors
// where CGEvent is filtered. Returns true iff a matching, enabled, pressable element was
// found and pressed.
func axEnableEnhancedUI(_ app: AXUIElement) {
  // Safari (and WebKit) only expose the full web-content AX tree to external clients when
  // enhanced accessibility is on — the same flag VoiceOver sets. Without it, the app tree
  // has windows but the web area's descendants (the actual buttons) are hidden, so a title
  // search finds nothing. Turn it on before traversing.
  AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue)
  AXUIElementSetAttributeValue(app, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
}

func axChildText(_ el: AXUIElement) -> String? {
  // A WebKit AXButton often carries no AXTitle — its label lives in a child AXStaticText.
  var kidsRef: CFTypeRef?
  guard AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &kidsRef) == .success,
        let kids = kidsRef as? [AXUIElement] else { return nil }
  for k in kids {
    var v: CFTypeRef?
    for name in [kAXValueAttribute as String, kAXTitleAttribute as String, kAXDescriptionAttribute as String] {
      if AXUIElementCopyAttributeValue(k, name as CFString, &v) == .success, let val = v,
         CFGetTypeID(val) == CFStringGetTypeID() {
        let t = ((val as! CFString) as String).trimmingCharacters(in: .whitespacesAndNewlines)
        if !t.isEmpty { return t }
      }
    }
  }
  return nil
}

func axPressByTitle(pid: pid_t, title: String, maxNodes: Int = 40000) -> Bool {
  let app = AXUIElementCreateApplication(pid)
  axEnableEnhancedUI(app)
  usleep(150_000) // give WebKit a beat to build the tree
  var queue: [(AXUIElement, Int)] = [(app, 0)]
  var visited = 0
  func attr(_ el: AXUIElement, _ name: String) -> String? {
    var v: CFTypeRef?
    guard AXUIElementCopyAttributeValue(el, name as CFString, &v) == .success, let val = v else { return nil }
    if CFGetTypeID(val) == CFStringGetTypeID() { return (val as! CFString) as String }
    return nil
  }
  func hasPress(_ el: AXUIElement) -> Bool {
    var a: CFArray?
    if AXUIElementCopyActionNames(el, &a) == .success, let acts = a as? [String] {
      return acts.contains(kAXPressAction as String)
    }
    return false
  }
  func matches(_ el: AXUIElement) -> Bool {
    for name in [kAXTitleAttribute as String, kAXDescriptionAttribute as String, kAXValueAttribute as String] {
      if let t = attr(el, name)?.trimmingCharacters(in: .whitespacesAndNewlines), t == title { return true }
    }
    if let ct = axChildText(el), ct == title { return true }
    return false
  }
  while !queue.isEmpty && visited < maxNodes {
    let (el, depth) = queue.removeFirst()
    visited += 1
    if matches(el) && hasPress(el) {
      // Prefer enabled controls; if AXEnabled is explicitly false, skip.
      var enabledRef: CFTypeRef?
      if AXUIElementCopyAttributeValue(el, kAXEnabledAttribute as CFString, &enabledRef) == .success,
         let e = enabledRef, CFGetTypeID(e) == CFBooleanGetTypeID(), (e as! CFBoolean) == kCFBooleanFalse {
        // disabled — keep searching
      } else if AXUIElementPerformAction(el, kAXPressAction as CFString) == .success {
        return true
      }
    }
    if depth < 40 {
      var kidsRef: CFTypeRef?
      if AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &kidsRef) == .success,
         let kids = kidsRef as? [AXUIElement] {
        for k in kids { queue.append((k, depth + 1)) }
      }
    }
  }
  return false
}


// ========== Accessibility Press inside a named window (fronts it first) ==========
// AX (and coordinate clicks) only see the FOCUSED, visible tab's web content. When the
// target tab is in a background window, its buttons aren't in the tree at all. So: find
// the Safari window by title (isolation-safe — we target the automation window, not
// "window 1"), raise it + activate Safari from inside the helper (NOT Bash osascript, so
// the Safari-window guard hook does not apply), let WebKit build the tree, then press the
// button by title. This is the macOS 26-safe "real click" that CGEvent can't deliver.
func axPressInWindow(pid: pid_t, windowMatch: String, buttonTitle: String) -> (Bool, String) {
  let app = AXUIElementCreateApplication(pid)
  AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue)
  AXUIElementSetAttributeValue(app, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)

  func str(_ el: AXUIElement, _ n: String) -> String? {
    var v: CFTypeRef?
    guard AXUIElementCopyAttributeValue(el, n as CFString, &v) == .success, let val = v,
          CFGetTypeID(val) == CFStringGetTypeID() else { return nil }
    return (val as! CFString) as String
  }
  // Find the matching window
  var winsRef: CFTypeRef?
  guard AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &winsRef) == .success,
        let windows = winsRef as? [AXUIElement] else { return (false, "no-windows") }
  var target: AXUIElement?
  for w in windows {
    if let t = str(w, kAXTitleAttribute as String), t.contains(windowMatch) { target = w; break }
  }
  guard let win = target else { return (false, "window-not-found") }
  // Raise + focus the window, activate the app — brings the tab's web view to visible/front
  AXUIElementPerformAction(win, kAXRaiseAction as CFString)
  AXUIElementSetAttributeValue(win, kAXMainAttribute as CFString, kCFBooleanTrue)
  AXUIElementSetAttributeValue(win, kAXFocusedAttribute as CFString, kCFBooleanTrue)
  if let running = NSRunningApplication(processIdentifier: pid) {
    running.activate(options: [.activateIgnoringOtherApps])
  }
  usleep(500_000) // let WebKit populate the AX tree for the now-visible tab

  // Search this window's subtree for the pressable button by title / child text
  var queue: [(AXUIElement, Int)] = [(win, 0)]
  var visited = 0
  while !queue.isEmpty && visited < 60000 {
    let (el, depth) = queue.removeFirst(); visited += 1
    if matchesTitle(el, buttonTitle) && elementHasPress(el) {
      var enRef: CFTypeRef?
      let disabled = (AXUIElementCopyAttributeValue(el, kAXEnabledAttribute as CFString, &enRef) == .success)
        && (enRef != nil) && (CFGetTypeID(enRef!) == CFBooleanGetTypeID()) && ((enRef as! CFBoolean) == kCFBooleanFalse)
      if !disabled && AXUIElementPerformAction(el, kAXPressAction as CFString) == .success {
        return (true, "pressed after \(visited) nodes")
      }
    }
    if depth < 60 {
      var kidsRef: CFTypeRef?
      if AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &kidsRef) == .success,
         let kids = kidsRef as? [AXUIElement] {
        for k in kids { queue.append((k, depth + 1)) }
      }
    }
  }
  return (false, "button-not-found-in-window (visited \(visited))")
}

// Shared matchers (used by both axPressByTitle and axPressInWindow)
func elementHasPress(_ el: AXUIElement) -> Bool {
  var a: CFArray?
  if AXUIElementCopyActionNames(el, &a) == .success, let acts = a as? [String] {
    return acts.contains(kAXPressAction as String)
  }
  return false
}
func matchesTitle(_ el: AXUIElement, _ title: String) -> Bool {
  func str(_ n: String) -> String? {
    var v: CFTypeRef?
    guard AXUIElementCopyAttributeValue(el, n as CFString, &v) == .success, let val = v,
          CFGetTypeID(val) == CFStringGetTypeID() else { return nil }
    return ((val as! CFString) as String).trimmingCharacters(in: .whitespacesAndNewlines)
  }
  for n in [kAXTitleAttribute as String, kAXDescriptionAttribute as String, kAXValueAttribute as String] {
    if str(n) == title { return true }
  }
  if let ct = axChildText(el)?.trimmingCharacters(in: .whitespacesAndNewlines), ct == title { return true }
  return false
}


// ========== Front my tab (by URL) + AX press — atomic, beats tab-stealing ==========
// Parallel sessions keep switching the automation window's active tab away from mine, so
// the target's web content is never in the AX tree long enough. This does it in one shot:
// an in-helper AppleScript makes the tab whose URL matches the current tab AND fronts its
// window (targeted by URL, isolation-safe — never a generic "window 1"), then — without
// yielding — enables enhanced AX and presses the button. Runs as NSAppleScript in-process,
// so the Bash-level Safari-window guard hook does not apply.
func frontTabByUrl(_ urlContains: String) -> Bool {
  let src = """
  tell application "Safari"
    repeat with w in windows
      repeat with t in tabs of w
        try
          if (URL of t) contains "\(urlContains)" then
            set current tab of w to t
            set index of w to 1
            return "ok"
          end if
        end try
      end repeat
    end repeat
    return "notfound"
  end tell
  """
  guard let script = NSAppleScript(source: src) else { return false }
  var err: NSDictionary?
  let res = script.executeAndReturnError(&err)
  return (res.stringValue ?? "") == "ok"
}

func axPressTab(pid: pid_t, urlContains: String, buttonTitle: String) -> (Bool, String) {
  if !frontTabByUrl(urlContains) { return (false, "front-failed") }
  let app = AXUIElementCreateApplication(pid)
  AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue)
  AXUIElementSetAttributeValue(app, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
  if let running = NSRunningApplication(processIdentifier: pid) { running.activate(options: []) }
  usleep(600_000) // WebKit builds the AX tree for the now-frontmost tab

  // Press within the frontmost window (index 0 in AX windows is the frontmost/main one).
  var winsRef: CFTypeRef?
  guard AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &winsRef) == .success,
        let windows = winsRef as? [AXUIElement], let front = windows.first else { return (false, "no-window") }
  var queue: [(AXUIElement, Int)] = [(front, 0)]
  var visited = 0
  while !queue.isEmpty && visited < 80000 {
    let (el, depth) = queue.removeFirst(); visited += 1
    if matchesTitle(el, buttonTitle) && elementHasPress(el) {
      var enRef: CFTypeRef?
      let disabled = (AXUIElementCopyAttributeValue(el, kAXEnabledAttribute as CFString, &enRef) == .success)
        && (enRef != nil) && (CFGetTypeID(enRef!) == CFBooleanGetTypeID()) && ((enRef as! CFBoolean) == kCFBooleanFalse)
      if !disabled && AXUIElementPerformAction(el, kAXPressAction as CFString) == .success {
        return (true, "pressed after \(visited) nodes")
      }
    }
    if depth < 60 {
      var kidsRef: CFTypeRef?
      if AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &kidsRef) == .success,
         let kids = kidsRef as? [AXUIElement] {
        for k in kids { queue.append((k, depth + 1)) }
      }
    }
  }
  return (false, "button-not-found (visited \(visited))")
}


// A physical-equivalent click on the FRONTMOST window: warp the cursor there and post
// down/up to the HID tap (kCGHIDEventTap) — the same path a trackpad tap takes. macOS 26
// honors this where process-targeted (postToPid) events are filtered. Caller must ensure
// the intended window is frontmost first (frontTabByUrl).
func realClickAtPoint(x: Double, y: Double) {
  let pt = CGPoint(x: x, y: y)
  let src = CGEventSource(stateID: .hidSystemState)
  CGWarpMouseCursorPosition(pt)
  usleep(30_000)
  if let mv = CGEvent(mouseEventSource: src, mouseType: .mouseMoved, mouseCursorPosition: pt, mouseButton: .left) { mv.post(tap: .cghidEventTap) }
  usleep(20_000)
  if let dn = CGEvent(mouseEventSource: src, mouseType: .leftMouseDown, mouseCursorPosition: pt, mouseButton: .left) {
    dn.setIntegerValueField(.mouseEventClickState, value: 1); dn.post(tap: .cghidEventTap)
  }
  usleep(60_000)
  if let up = CGEvent(mouseEventSource: src, mouseType: .leftMouseUp, mouseCursorPosition: pt, mouseButton: .left) {
    up.setIntegerValueField(.mouseEventClickState, value: 1); up.post(tap: .cghidEventTap)
  }
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

func respond(_ obj: [String: Any]) {
  if let data = try? JSONSerialization.data(withJSONObject: obj),
     let str = String(data: data, encoding: .utf8) {
    print(str)
  } else {
    print("{\"error\":\"serialization failed\"}")
  }
  fflush(stdout)
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

func handleLine(_ line: String) {
  guard !line.isEmpty else { return }

  guard let data = line.data(using: .utf8),
        let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
    respond(["error": "invalid input"])
    return
  }

  // Debug: list pressable elements and their labels
  // {"axdump": {}}
  if json["axdump"] != nil {
    var pid: pid_t = 0
    for app in NSWorkspace.shared.runningApplications where app.bundleIdentifier == "com.apple.Safari" { pid = app.processIdentifier; break }
    if pid == 0 { respond(["error": "Safari not found"]); return }
    let app = AXUIElementCreateApplication(pid)
    AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue)
    AXUIElementSetAttributeValue(app, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
    usleep(200_000)
    var out: [String] = []
    var queue: [(AXUIElement, Int)] = [(app, 0)]
    var visited = 0
    func a(_ el: AXUIElement, _ n: String) -> String {
      var v: CFTypeRef?
      if AXUIElementCopyAttributeValue(el, n as CFString, &v) == .success, let val = v, CFGetTypeID(val) == CFStringGetTypeID() { return (val as! CFString) as String }
      return ""
    }
    while !queue.isEmpty && visited < 40000 && out.count < 60 {
      let (el, depth) = queue.removeFirst(); visited += 1
      var acts: CFArray?
      let pressable = (AXUIElementCopyActionNames(el, &acts) == .success) && ((acts as? [String])?.contains(kAXPressAction as String) ?? false)
      if pressable {
        let role = a(el, kAXRoleAttribute as String)
        let title = a(el, kAXTitleAttribute as String)
        let desc = a(el, kAXDescriptionAttribute as String)
        let ct = axChildText(el) ?? ""
        let label = [title, desc, ct].first(where: { !$0.isEmpty }) ?? ""
        if !label.isEmpty { out.append("\(role):\(label.prefix(30))") }
      }
      if depth < 40 {
        var kidsRef: CFTypeRef?
        if AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &kidsRef) == .success, let kids = kidsRef as? [AXUIElement] {
          for k in kids { queue.append((k, depth + 1)) }
        }
      }
    }
    respond(["result": out.joined(separator: " | "), "visited": visited])
    return
  }

  // Debug: list Safari window titles
  if json["axwindows"] != nil {
    var pid: pid_t = 0
    for app in NSWorkspace.shared.runningApplications where app.bundleIdentifier == "com.apple.Safari" { pid = app.processIdentifier; break }
    let app = AXUIElementCreateApplication(pid)
    var winsRef: CFTypeRef?
    var out: [String] = []
    if AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &winsRef) == .success, let ws = winsRef as? [AXUIElement] {
      for (i,w) in ws.enumerated() {
        var v: CFTypeRef?
        var title = "?"
        if AXUIElementCopyAttributeValue(w, kAXTitleAttribute as CFString, &v) == .success, let val = v, CFGetTypeID(val)==CFStringGetTypeID() { title = (val as! CFString) as String }
        out.append("[\(i)] \(title.prefix(50))")
      }
    }
    respond(["result": out.joined(separator: " || ")])
    return
  }

  // Diagnostic: front my tab by URL, report the resulting frontmost window title
  if let fc = json["frontcheck"] as? [String: Any], let url = fc["url"] as? String {
    let ok = frontTabByUrl(url)
    var pid: pid_t = 0
    for app in NSWorkspace.shared.runningApplications where app.bundleIdentifier == "com.apple.Safari" { pid = app.processIdentifier; break }
    if let running = NSRunningApplication(processIdentifier: pid) { running.activate(options: []) }
    usleep(500_000)
    let app = AXUIElementCreateApplication(pid)
    var winsRef: CFTypeRef?
    var title = "?"
    if AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &winsRef) == .success, let ws = winsRef as? [AXUIElement], let f = ws.first {
      var v: CFTypeRef?
      if AXUIElementCopyAttributeValue(f, kAXTitleAttribute as CFString, &v) == .success, let val = v, CFGetTypeID(val)==CFStringGetTypeID() { title = (val as! CFString) as String }
    }
    respond(["result": "front=\(ok) frontmostWindow=\(title.prefix(60))"])
    return
  }

  // Front my tab by URL, then AX-press at exact coordinates (atomic; beats tab-stealing).
  // Once the tab is frontmost, hit-testing returns the right element. {"clickTab":{"url":"..","x":..,"y":..}}
  if let ct = json["clickTab"] as? [String: Any], let url = ct["url"] as? String,
     let x = ct["x"] as? Double, let y = ct["y"] as? Double {
    if let denied = ensurePostEventAccess() { respond(denied); return }
    let fronted = frontTabByUrl(url)
    var pid: pid_t = 0
    for app in NSWorkspace.shared.runningApplications where app.bundleIdentifier == "com.apple.Safari" { pid = app.processIdentifier; break }
    if let running = NSRunningApplication(processIdentifier: pid) { running.activate(options: []) }
    usleep(500_000)
    realClickAtPoint(x: x, y: y)
    respond(["result": "clickTab fronted=\(fronted) realclick at (\(Int(x)),\(Int(y)))"])
    return
  }

  // Front my tab by URL then AX-press a button by title (atomic)
  // {"axpressTab": {"url": "use_cases", "title": "Save"}}
  if let apt = json["axpressTab"] as? [String: Any],
     let url = apt["url"] as? String, let title = apt["title"] as? String {
    if let denied = ensurePostEventAccess() { respond(denied); return }
    var pid: pid_t = 0
    for app in NSWorkspace.shared.runningApplications where app.bundleIdentifier == "com.apple.Safari" { pid = app.processIdentifier; break }
    if pid == 0 { respond(["error": "Safari not found"]); return }
    let (ok, msg) = axPressTab(pid: pid, urlContains: url, buttonTitle: title)
    respond(ok ? ["result": "axpressTab:\(title) (\(msg))"] : ["error": "axpressTab-failed:\(msg)"])
    return
  }

  // Handle window-scoped AX press
  // {"axpressWindow": {"window": "בננה בוק", "title": "Save"}}
  if let apw = json["axpressWindow"] as? [String: Any],
     let wm = apw["window"] as? String, let title = apw["title"] as? String {
    if let denied = ensurePostEventAccess() { respond(denied); return }
    var pid: pid_t = 0
    for app in NSWorkspace.shared.runningApplications where app.bundleIdentifier == "com.apple.Safari" { pid = app.processIdentifier; break }
    if pid == 0 { respond(["error": "Safari not found"]); return }
    let (ok, msg) = axPressInWindow(pid: pid, windowMatch: wm, buttonTitle: title)
    respond(ok ? ["result": "axpressWindow:\(title) (\(msg))"] : ["error": "axpressWindow-failed:\(msg)"])
    return
  }

  // Handle Accessibility press-by-title command
  // {"axpress": {"title": "Save"}}  — finds Safari's button by title and presses it (isTrusted)
  if let ap = json["axpress"] as? [String: Any], let title = ap["title"] as? String {
    if let denied = ensurePostEventAccess() { respond(denied); return }
    var pid: pid_t = 0
    for app in NSWorkspace.shared.runningApplications where app.bundleIdentifier == "com.apple.Safari" {
      pid = app.processIdentifier; break
    }
    if pid == 0 { respond(["error": "Safari process not found"]); return }
    let ok = axPressByTitle(pid: pid, title: title)
    respond(ok ? ["result": "axpress:\(title)"] : ["error": "axpress-no-match:\(title)"])
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

  // Execute on a background thread to avoid blocking stdin reading.
  // Heavy pages (SourceForge, etc.) can cause executeAndReturnError() to block
  // for 10-30+ seconds, preventing ALL subsequent commands from being read.
  _inFlightLock.lock()
  let alreadyStuck = _inFlightScripts
  _inFlightLock.unlock()
  if alreadyStuck >= 8 {
    respond(["error": "daemon wedged: \(alreadyStuck) AppleScript executions still blocked past their timeout — exiting for a clean respawn"])
    exit(1)
  }

  let semaphore = DispatchSemaphore(value: 0)
  var scriptResult: NSAppleEventDescriptor?
  var scriptError: NSDictionary?

  _inFlightLock.lock(); _inFlightScripts += 1; _inFlightLock.unlock()
  DispatchQueue.global(qos: .userInitiated).async {
    var errorDict: NSDictionary?
    scriptResult = nsScript.executeAndReturnError(&errorDict)
    scriptError = errorDict
    _inFlightLock.lock(); _inFlightScripts -= 1; _inFlightLock.unlock()
    semaphore.signal()
  }

  // Wait up to 30 seconds for the script to complete.
  // If it times out, respond with error but don't block the loop forever.
  let waitResult = semaphore.wait(timeout: .now() + 30.0)

  if waitResult == .timedOut {
    respond(["error": "AppleScript execution timed out (30s)"])
  } else if let error = scriptError {
    let msg = (error["NSAppleScriptErrorMessage"] as? String) ?? "AppleScript error"
    respond(["error": msg])
  } else {
    respond(["result": scriptResult?.stringValue ?? ""])
  }
}

while let line = readLine(strippingNewline: true) {
  // Command-line Swift has no runloop, so the implicit top-level autorelease pool
  // never drains — every NSAppleScript / NSDictionary allocated per command was
  // retained until process exit. Drain per command.
  autoreleasepool { handleLine(line) }
}

// stdin closed — the parent Node process is gone (clean shutdown or crash). GCD
// threads still blocked inside executeAndReturnError would keep this process alive
// as an orphan holding Apple Events / Accessibility grants; with no parent left to
// read results there is nothing useful to finish. Exit explicitly.
exit(0)
