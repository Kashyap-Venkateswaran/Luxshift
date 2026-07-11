import Foundation

let bundle = Bundle(path: "/System/Library/PrivateFrameworks/CoreBrightness.framework")
bundle?.load()

let args = CommandLine.arguments
let command = args.count > 1 ? args[1] : "status"
let value = args.count > 2 ? (Float(args[2]) ?? 0.5) : Float(0.5)

if let clientClass = NSClassFromString("CBBlueLightClient") as? NSObject.Type {
  let client = clientClass.init()

  switch command {
  case "on":
    let clamped = min(max(value, 0.0), 1.0)
    client.perform(NSSelectorFromString("setEnabled:"), with: true as AnyObject)
    client.perform(NSSelectorFromString("setStrength:commit:"), with: clamped as AnyObject, with: true as AnyObject)
    print("ok:on:\(clamped)")
  case "off":
    client.perform(NSSelectorFromString("setEnabled:"), with: false as AnyObject)
    print("ok:off")
  case "strength":
    let clamped = min(max(value, 0.0), 1.0)
    client.perform(NSSelectorFromString("setStrength:commit:"), with: clamped as AnyObject, with: true as AnyObject)
    print("ok:strength:\(clamped)")
  default:
    print("usage: nightshift-control on|off|strength [0.0-1.0]")
  }
} else {
  fputs("error: CBBlueLightClient not found\n", stderr)
  exit(1)
}
