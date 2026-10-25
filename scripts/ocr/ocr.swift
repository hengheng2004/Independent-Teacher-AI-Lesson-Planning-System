// 把 PDF 指定页范围渲染成图，用 macOS Vision 离线 OCR，输出 Markdown。
// 用法: ocr <in.pdf> <out.md> <fromPage> <toPage>
// 页号从 1 开始；输出按页分节，便于多进程并行后合并。
import Foundation
import PDFKit
import Vision
import AppKit

let args = CommandLine.arguments
guard args.count >= 5 else {
    FileHandle.standardError.write("用法: ocr <in.pdf> <out.md> <fromPage> <toPage>\n".data(using: .utf8)!)
    exit(1)
}
let inPath = args[1]
let outPath = args[2]
guard let fromPage = Int(args[3]), let toPage = Int(args[4]) else {
    FileHandle.standardError.write("页号必须是整数\n".data(using: .utf8)!)
    exit(1)
}

guard let doc = PDFDocument(url: URL(fileURLWithPath: inPath)) else {
    FileHandle.standardError.write("无法打开 PDF\n".data(using: .utf8)!)
    exit(2)
}

let start = max(1, fromPage)
let end = min(doc.pageCount, toPage)
var out = ""
var done = 0

for p in start...end {
    guard let page = doc.page(at: p - 1) else { continue }
    let rect = page.bounds(for: .mediaBox)
    let scale: CGFloat = 2.0
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
          let cg = rep.cgImage else { continue }

    let req = VNRecognizeTextRequest()
    req.recognitionLevel = .accurate
    req.recognitionLanguages = ["zh-Hans", "en-US"]
    req.usesLanguageCorrection = true
    let handler = VNImageRequestHandler(cgImage: cg, options: [:])
    try? handler.perform([req])
    let lines = (req.results ?? []).compactMap { $0.topCandidates(1).first?.string }
    out += "\n## 第 \(p) 页\n\n" + lines.joined(separator: "\n") + "\n"
    done += 1
    FileHandle.standardError.write("PAGE \(p)\n".data(using: .utf8)!)
}

try out.write(to: URL(fileURLWithPath: outPath), atomically: true, encoding: .utf8)
print("完成：\(start)-\(end)（\(done) 页）")
