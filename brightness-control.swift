import Foundation
import IOKit

// Controls display brightness via IOKit on Apple Silicon and Intel Macs
// Usage: brightness-control 0.0-1.0

let args = CommandLine.arguments
guard args.count > 1, let level = Float(args[1]) else {
  fputs("usage: brightness-control <0.0-1.0>\n", stderr)
  exit(1)
}

let clamped = min(max(level, 0.0), 1.0)

// Try IOKit display brightness (works on built-in displays)
func setBrightnessIOKit(_ value: Float) -> Bool {
  let service = IOServiceGetMatchingService(kIOMainPortDefault,
    IOServiceMatching("IODisplayConnect"))
  guard service != 0 else { return false }
  defer { IOObjectRelease(service) }

  IODisplaySetFloatParameter(service, 0,
    kIODisplayBrightnessKey as CFString, value)
  return true
}

// Try CoreBrightness framework (private, but very reliable)
func setBrightnessCB(_ value: Float) -> Bool {
  let bundle = Bundle(path:
    "/System/Library/PrivateFrameworks/CoreBrightness.framework")
  guard bundle?.load() == true else { return false }

  guard let cls = NSClassFromString("CBDisplayManager") as? NSObject.Type
  else { return false }

  let mgr = cls.init()
  let sel = NSSelectorFromString("setDisplayBrightness:")
  guard mgr.responds(to: sel) else { return false }
  mgr.perform(sel, with: NSNumber(value: value))
  return true
}

if setBrightnessCB(clamped) {
  print("ok:cb:\(clamped)")
} else if setBrightnessIOKit(clamped) {
  print("ok:iokit:\(clamped)")
} else {
  fputs("error: could not set brightness\n", stderr)
  exit(1)
}
