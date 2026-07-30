import Foundation

let bundle = Bundle(path: "/System/Library/PrivateFrameworks/CoreBrightness.framework")
let loaded = bundle?.load() ?? false

if !loaded {
    fputs("error: failed to load CoreBrightness.framework\n", stderr)
    exit(1)
}

let args = CommandLine.arguments
let command = args.count > 1 ? args[1] : "status"
let value = args.count > 2 ? (Float(args[2]) ?? 0.5) : Float(0.5)

guard let clientClass = NSClassFromString("CBBlueLightClient") as? NSObject.Type else {
    fputs("error: CBBlueLightClient class not found (macOS version may not expose this API)\n", stderr)
    exit(1)
}

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
    fputs("usage: nightshift-control on|off|strength [0.0-1.0]\n", stderr)
    exit(1)
}