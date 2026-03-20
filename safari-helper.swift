// safari-helper: persistent AppleScript daemon
// Replaces osascript subprocess (~80ms) with NSAppleScript in-process (~5ms)
// Input: JSON lines {"script": "full applescript"} on stdin
// Output: JSON lines {"result": "..."} or {"error": "..."} on stdout

import Foundation
import Darwin

func respond(_ obj: [String: Any]) {
  if let data = try? JSONSerialization.data(withJSONObject: obj),
     let str = String(data: data, encoding: .utf8) {
    print(str)
  } else {
    print("{\"error\":\"serialization failed\"}")
  }
  fflush(stdout)
}

while let line = readLine(strippingNewline: true) {
  guard !line.isEmpty else { continue }

  guard let data = line.data(using: .utf8),
        let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
        let script = json["script"] as? String else {
    respond(["error": "invalid input"])
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
