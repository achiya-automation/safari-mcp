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

// ========== CGEvent Native Click ==========
// Performs a REAL OS-level mouse click that produces isTrusted: true in the browser.
// Requires Accessibility permissions (same as AppleScript automation).

func performNativeClick(x: Double, y: Double, doubleClick: Bool = false, windowId: Int64 = 0) -> [String: Any] {
  let point = CGPoint(x: x, y: y)

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
    let savedPosition = CGEvent(source: nil)?.location ?? CGPoint.zero
    defer {
      if let restoreEvent = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: savedPosition, mouseButton: .left) {
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

while let line = readLine(strippingNewline: true) {
  guard !line.isEmpty else { continue }

  guard let data = line.data(using: .utf8),
        let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
    respond(["error": "invalid input"])
    continue
  }

  // Handle CGEvent click command
  if let clickData = json["click"] as? [String: Any],
     let x = clickData["x"] as? Double,
     let y = clickData["y"] as? Double {
    let isDouble = (clickData["double"] as? Bool) ?? false
    let windowId = Int64((clickData["windowId"] as? Int) ?? 0)
    respond(performNativeClick(x: x, y: y, doubleClick: isDouble, windowId: windowId))
    continue
  }

  // Handle CGEvent keyboard command
  // {"keyboard": {"keyCode": 9, "flags": ["cmd"], "windowId": 4127}}
  // keyCode 9 = V, flags: cmd/shift/alt/ctrl
  if let kbData = json["keyboard"] as? [String: Any],
     let keyCode = kbData["keyCode"] as? Int {
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
    continue
  }

  // Handle getFrontApp — returns frontmost application bundle ID (native, ~0.1ms)
  if json["getFrontApp"] != nil {
    let frontApp = NSWorkspace.shared.frontmostApplication
    respond(["result": frontApp?.localizedName ?? "", "bundleId": frontApp?.bundleIdentifier ?? ""])
    continue
  }

  // Handle hideSafari — hide Safari to prevent focus stealing (native, ~1ms)
  if json["hideSafari"] != nil {
    if let safariApp = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.Safari").first {
      safariApp.hide()
      respond(["result": "hidden"])
    } else {
      respond(["error": "Safari not running"])
    }
    continue
  }

  // Handle AppleScript command
  guard let script = json["script"] as? String else {
    respond(["error": "invalid input — expected 'script', 'click', 'keyboard', 'getFrontApp', or 'hideSafari'"])
    continue
  }

  // ========== FOCUS PRESERVATION ==========
  // Save the frontmost app BEFORE executing AppleScript.
  // Safari AppleScript can steal focus — we hide Safari immediately after.
  // Hiding is better than activating the previous app because:
  // 1. It hides ALL Safari windows (both personal and automation profiles)
  // 2. No wrong window flashes to the user
  // 3. Works regardless of which app was previously active
  let wasSafari = NSWorkspace.shared.frontmostApplication?.bundleIdentifier == "com.apple.Safari"

  guard let nsScript = NSAppleScript(source: script) else {
    respond(["error": "failed to compile AppleScript"])
    continue
  }

  var errorDict: NSDictionary?
  let result = nsScript.executeAndReturnError(&errorDict)

  // Hide Safari if it stole focus (only if caller wasn't already in Safari)
  if !wasSafari,
     NSWorkspace.shared.frontmostApplication?.bundleIdentifier == "com.apple.Safari" {
    if let safariApp = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.Safari").first {
      safariApp.hide()
    }
  }

  if let error = errorDict {
    let msg = (error["NSAppleScriptErrorMessage"] as? String) ?? "AppleScript error"
    respond(["error": msg])
  } else {
    respond(["result": result.stringValue ?? ""])
  }
}
