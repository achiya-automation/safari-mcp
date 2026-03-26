// safari-helper: persistent AppleScript daemon + CGEvent native click
// Replaces osascript subprocess (~80ms) with NSAppleScript in-process (~5ms)
// Also provides OS-level mouse clicks via CGEvent (produces isTrusted: true events)
//
// Input: JSON lines on stdin
//   {"script": "full applescript"}           — run AppleScript
//   {"click": {"x": 500, "y": 300}}         — CGEvent click at screen coords
//   {"click": {"x": 500, "y": 300, "double": true}}  — CGEvent double-click
// Output: JSON lines {"result": "..."} or {"error": "..."} on stdout

import Foundation
import Darwin
import CoreGraphics

// ========== CGEvent Native Click ==========
// Performs a REAL OS-level mouse click that produces isTrusted: true in the browser.
// Requires Accessibility permissions (same as AppleScript automation).

func performNativeClick(x: Double, y: Double, doubleClick: Bool = false) -> [String: Any] {
  let point = CGPoint(x: x, y: y)

  // Save current mouse position so we can restore it after the click.
  // This prevents the physical cursor from visibly jumping away from the user.
  let savedPosition = CGEvent(source: nil)?.location ?? CGPoint.zero

  // Restore mouse position when we exit — even if we return early on error.
  defer {
    if let restoreEvent = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: savedPosition, mouseButton: .left) {
      restoreEvent.post(tap: .cghidEventTap)
    }
  }

  // Create mouse events
  guard let moveEvent = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left) else {
    return ["error": "Failed to create mouse move event"]
  }
  guard let downEvent = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left) else {
    return ["error": "Failed to create mouse down event"]
  }
  guard let upEvent = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left) else {
    return ["error": "Failed to create mouse up event"]
  }

  // Move mouse to position first (some apps need this)
  moveEvent.post(tap: .cghidEventTap)
  usleep(20_000) // 20ms settle

  if doubleClick {
    // First click
    downEvent.setIntegerValueField(.mouseEventClickState, value: 1)
    upEvent.setIntegerValueField(.mouseEventClickState, value: 1)
    downEvent.post(tap: .cghidEventTap)
    usleep(50_000) // 50ms between down/up
    upEvent.post(tap: .cghidEventTap)
    usleep(50_000) // 50ms between clicks

    // Second click
    guard let down2 = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left) else {
      return ["error": "Failed to create second mouse down event"]
    }
    guard let up2 = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left) else {
      return ["error": "Failed to create second mouse up event"]
    }
    down2.setIntegerValueField(.mouseEventClickState, value: 2)
    up2.setIntegerValueField(.mouseEventClickState, value: 2)
    down2.post(tap: .cghidEventTap)
    usleep(50_000)
    up2.post(tap: .cghidEventTap)
  } else {
    // Single click
    downEvent.setIntegerValueField(.mouseEventClickState, value: 1)
    upEvent.setIntegerValueField(.mouseEventClickState, value: 1)
    downEvent.post(tap: .cghidEventTap)
    usleep(50_000) // 50ms between down/up for reliability
    upEvent.post(tap: .cghidEventTap)
  }

  // defer will restore mouse position after this return
  return ["result": "clicked at (\(Int(x)),\(Int(y)))\(doubleClick ? " (double)" : "")"]
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

// ========== CLI Mode: --click X Y ==========
// For direct invocation: swift safari-helper.swift --click 500 300

let args = CommandLine.arguments
if args.count >= 4 && args[1] == "--click" {
  guard let x = Double(args[2]), let y = Double(args[3]) else {
    respond(["error": "Invalid coordinates: \(args[2]) \(args[3])"])
    exit(1)
  }
  let isDouble = args.count >= 5 && args[4] == "--double"
  let result = performNativeClick(x: x, y: y, doubleClick: isDouble)
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
    respond(performNativeClick(x: x, y: y, doubleClick: isDouble))
    continue
  }

  // Handle AppleScript command
  guard let script = json["script"] as? String else {
    respond(["error": "invalid input — expected 'script' or 'click'"])
    continue
  }

  guard let nsScript = NSAppleScript(source: script) else {
    respond(["error": "failed to compile AppleScript"])
    continue
  }

  var errorDict: NSDictionary?
  let result = nsScript.executeAndReturnError(&errorDict)

  if let error = errorDict {
    let msg = (error["NSAppleScriptErrorMessage"] as? String) ?? "AppleScript error"
    respond(["error": msg])
  } else {
    respond(["result": result.stringValue ?? ""])
  }
}
