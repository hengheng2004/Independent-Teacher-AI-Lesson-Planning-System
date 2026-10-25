// 把 PDF 指定页渲染成 JPEG（给多模态模型 OCR 用）。
// 用法: render <in.pdf> <outDir> <fromPage> <toPage>
import Foundation
import PDFKit
import AppKit

let args = CommandLine.arguments
guard args.count >= 5,
      let from = Int(args[3]), let to = Int(args[4]),
      let doc = PDFDocument(url: URL(fileURLWithPath: args[1])) else {
    FileHandle.standardError.write("用法: render <in.pdf> <outDir> <from> <to>\n".data(using: .utf8)!)
    exit(1)
}
let outDir = args[2]
try? FileManager.default.createDirectory(atPath: outDir, withIntermediateDirectories: true)

let start = max(1, from)
let end = min(doc.pageCount, to)
for p in start...end {
    guard let page = doc.page(at: p - 1) else { continue }
    let rect = page.bounds(for: .mediaBox)
    let scale: CGFloat = 1.6
    let size = NSSize(width: rect.width * scale, height: rect.height * scale)
    let img = NSImage(size: size)
    img.lockFocus()
    NSColor.white.setFill()
    NSRect(origin: .zero, size: size).fill()
    if let ctx = NSGraphicsContext.current?.cgContext {
        ctx.scaleBy(x: scale, y: scale)
        page.draw(with: .mediaBox, to: ctx)
    }
    img.unlockFocus()
    guard let tiff = img.tiffRepresentation,
          let rep = NSBitmapImageRep(data: tiff),
          let jpg = rep.representation(using: .jpeg, properties: [.compressionFactor: 0.72]) else { continue }
    let name = String(format: "p-%04d.jpg", p)
    try? jpg.write(to: URL(fileURLWithPath: outDir).appendingPathComponent(name))
}
print("rendered \(start)-\(end)")
