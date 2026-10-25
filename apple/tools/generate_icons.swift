#!/usr/bin/env swift
// Repackage the existing macOS brand artwork for Apple's other launchers.
// Run with: swift apple/tools/generate_icons.swift
import Foundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
let temporary = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
try FileManager.default.createDirectory(at: temporary, withIntermediateDirectories: true)
defer { try? FileManager.default.removeItem(at: temporary) }
let iconset = temporary.appendingPathComponent("Tigerest.iconset")
let extraction = Process()
extraction.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
extraction.arguments = ["--convert", "iconset", "--output", iconset.path,
                        root.deletingLastPathComponent().appendingPathComponent("bundle/osx/tigerest.icns").path]
try extraction.run()
extraction.waitUntilExit()
guard extraction.terminationStatus == 0,
      let source = CGImageSourceCreateWithURL(iconset.appendingPathComponent("icon_512x512@2x.png") as CFURL, nil),
      let artwork = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
    fatalError("Cannot read the existing 1024px macOS icon")
}
let info: [String: Any] = ["author": "xcode", "version": 1]
func json(_ value: [String: Any], at directory: URL) throws {
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let data = try JSONSerialization.data(withJSONObject: value, options: [.prettyPrinted, .sortedKeys])
    try data.write(to: directory.appendingPathComponent("Contents.json"))
}

// Use an opaque canvas for iPad and the back TV layer; the system supplies masks.
// TV's front layer retains the original logo, with room for focus/parallax motion.
func png(at url: URL, width: Int, height: Int, background: Bool, logoFraction: CGFloat?) throws {
    let alpha: CGImageAlphaInfo = background ? .noneSkipLast : .premultipliedLast
    guard let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8,
                                  bytesPerRow: 0, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                                  bitmapInfo: alpha.rawValue) else { fatalError("Cannot create icon canvas") }
    context.interpolationQuality = .high
    let bounds = CGRect(x: 0, y: 0, width: width, height: height)
    if background {
        context.setFillColor(CGColor(srgbRed: 0.067, green: 0.067, blue: 0.071, alpha: 1))
        context.fill(bounds)
    } else {
        context.clear(bounds)
    }
    if let fraction = logoFraction {
        let side = CGFloat(height) * fraction
        context.draw(artwork, in: CGRect(x: (CGFloat(width) - side) / 2, y: (CGFloat(height) - side) / 2,
                                        width: side, height: side))
    }
    guard let result = context.makeImage(),
          let destination = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil) else {
        fatalError("Cannot encode icon")
    }
    CGImageDestinationAddImage(destination, result, nil)
    guard CGImageDestinationFinalize(destination) else { fatalError("Cannot write icon") }
}

let ipad = root.appendingPathComponent("Resources/iPad.xcassets")
try json(["info": info], at: ipad)
let appIcon = ipad.appendingPathComponent("AppIcon.appiconset")
var images = [[String: String]]()
for size in [20, 29, 40, 76] {
    for scale in [1, 2] {
        images.append(["idiom": "ipad", "size": "\(size)x\(size)", "scale": "\(scale)x",
                       "filename": "icon-\(size * scale).png"])
    }
}
images.append(["idiom": "ipad", "size": "83.5x83.5", "scale": "2x", "filename": "icon-167.png"])
// The universal build also runs on iPhone, whose home screen needs its own sizes.
for size in [20, 29, 40, 60] {
    for scale in [2, 3] {
        images.append(["idiom": "iphone", "size": "\(size)x\(size)", "scale": "\(scale)x",
                       "filename": "icon-\(size * scale).png"])
    }
}
images.append(["idiom": "ios-marketing", "size": "1024x1024", "scale": "1x", "filename": "icon-1024.png"])
try json(["info": info, "images": images], at: appIcon)
for size in Set([20, 40, 29, 58, 80, 76, 152, 167, 1024, 60, 87, 120, 180]) {
    try png(at: appIcon.appendingPathComponent("icon-\(size).png"), width: size, height: size,
            background: true, logoFraction: 1)
}

let tv = root.appendingPathComponent("Resources/TV.xcassets")
try json(["info": info], at: tv)
let brand = tv.appendingPathComponent("App Icon & Top Shelf Image.brandassets")
try json(["info": info, "assets": [
    ["filename": "App Icon.imagestack", "idiom": "tv", "role": "primary-app-icon", "size": "400x240"],
    ["filename": "App Icon - App Store.imagestack", "idiom": "tv", "role": "primary-app-icon", "size": "1280x768"],
    ["filename": "Top Shelf Image.imageset", "idiom": "tv", "role": "top-shelf-image", "size": "1920x720"],
    ["filename": "Top Shelf Image Wide.imageset", "idiom": "tv", "role": "top-shelf-image-wide", "size": "2320x720"]
]], at: brand)
for (name, width, height, scales) in [("App Icon", 400, 240, [1, 2]), ("App Icon - App Store", 1280, 768, [1])] {
    let stack = brand.appendingPathComponent(name + ".imagestack")
    try json(["info": info, "layers": [["filename": "Front.imagestacklayer"], ["filename": "Back.imagestacklayer"]]], at: stack)
    for layer in ["Front", "Back"] {
        let directory = stack.appendingPathComponent(layer + ".imagestacklayer")
        try json(["info": info], at: directory)
        let content = directory.appendingPathComponent("Content.imageset")
        try json(["info": info, "images": scales.map { scale -> [String: String] in
            var image = ["idiom": "tv", "filename": "image-\(scale)x.png"]
            if name == "App Icon" { image["scale"] = "\(scale)x" }
            return image
        }], at: content)
        for scale in scales {
            try png(at: content.appendingPathComponent("image-\(scale)x.png"), width: width * scale, height: height * scale,
                    background: layer == "Back", logoFraction: layer == "Front" ? 0.84 : nil)
        }
    }
}
for (name, width) in [("Top Shelf Image", 1920), ("Top Shelf Image Wide", 2320)] {
    let directory = brand.appendingPathComponent(name + ".imageset")
    try json(["info": info, "images": [1, 2].map { ["idiom": "tv", "scale": "\($0)x", "filename": "image-\($0)x.png"] }], at: directory)
    for scale in [1, 2] {
        try png(at: directory.appendingPathComponent("image-\(scale)x.png"), width: width * scale, height: 720 * scale,
                background: true, logoFraction: 0.72)
    }
}
print("Updated iPad and tvOS icons from bundle/osx/tigerest.icns")
