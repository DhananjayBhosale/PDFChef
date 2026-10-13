import CoreGraphics
import Foundation
import PDFKit

enum PdfChefVerifiedCopyError: LocalizedError {
    case unreadable
    case noSignatureBox
    case unsupportedSignatureBox
    case rotatedPage
    case passwordUnsupported
    case tooComplex
    case writeFailed

    var errorDescription: String? {
        switch self {
        case .unreadable:
            return "This PDF could not be read to make a copy."
        case .noSignatureBox:
            return "This signature has no visible signature box to mark."
        case .unsupportedSignatureBox:
            return "This signature box can’t be marked safely."
        case .rotatedPage:
            return "PDFs with rotated pages can’t be copied with a check mark yet."
        case .passwordUnsupported:
            return "This PDF’s password can’t be kept on a shared copy. You can still print it."
        case .tooComplex:
            return "The signature box is too complex to redraw safely."
        case .writeFailed:
            return "The verified copy could not be saved."
        }
    }
}

/// Makes a separate print and share copy whose signature box shows the verified state, the way
/// Acrobat renders the layered appearance (n1 and n4) after it validates a signature. Only boxes
/// of signatures the report verified are marked, the copy carries no digital-signature fields,
/// the signed original is never modified, and a shared copy keeps the original's password.
enum PdfChefVerifiedCopy {
    static let validLayer = Data("% DSValid\nq 0.13 0.62 0.29 rg 14 52 m 40 22 l 88 80 l 78 88 l 40 42 l 24 62 h f Q\n".utf8)
    static let blankLayer = Data("% DSBlank\n".utf8)

    static func provenanceNote(checkedAt: Date) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "d MMM yyyy"
        return "Copy of a digitally signed PDF. Its signature was checked by PDF Chef on \(formatter.string(from: checkedAt)). Revocation was not checked because verification stayed on this device. This copy itself is not digitally signed."
    }

    static func fileName(for displayName: String) -> String {
        let base = (displayName as NSString).deletingPathExtension
        return "\(base.isEmpty ? "Document" : base) (verified copy).pdf"
    }

    /// Both platforms' writers keep only ASCII passwords of up to 32 bytes exactly.
    static func canPreserve(password: String) -> Bool {
        password.canBeConverted(to: .ascii) && password.utf8.count <= 32
    }

    /// Writes the shareable copy, protected with the original's password when it had one.
    static func create(
        from documentURL: URL,
        password: String?,
        displayName: String,
        checkedAt: Date,
        in directory: URL
    ) throws -> URL {
        let data = try render(from: documentURL, password: password, protected: true, checkedAt: checkedAt)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let url = directory.appendingPathComponent(fileName(for: displayName))
        do {
            try data.write(to: url, options: [.atomic, .completeFileProtection])
        } catch {
            throw PdfChefVerifiedCopyError.writeFailed
        }
        return url
    }

    /// Renders the copy in memory. Printing uses an unprotected rendering that is never written
    /// to disk, so the system print sheet does not ask for the password a second time.
    static func render(from documentURL: URL, password: String?, protected: Bool, checkedAt: Date) throws -> Data {
        guard let data = try? Data(contentsOf: documentURL, options: [.mappedIfSafe]),
              let provider = CGDataProvider(data: data as CFData),
              let source = CGPDFDocument(provider),
              let pages = PDFDocument(data: data) else {
            throw PdfChefVerifiedCopyError.unreadable
        }
        // An encrypted PDF that opened without a prompt has an empty user password, which the
        // copy keeps too.
        let password = password ?? ""
        if source.isEncrypted {
            guard source.isUnlocked || source.unlockWithPassword(password),
                  !pages.isLocked || pages.unlock(withPassword: password) else {
                throw PdfChefVerifiedCopyError.unreadable
            }
        }
        let keepsPassword = protected && source.isEncrypted
        if keepsPassword, !canPreserve(password: password) {
            throw PdfChefVerifiedCopyError.passwordUnsupported
        }

        return try withExtendedLifetime(source) {
            guard let catalog = source.catalog else { throw PdfChefVerifiedCopyError.unreadable }
            let verified = verifiedSignatureRanges(in: catalog)
            var boxes: [Int: [SignatureBox]] = [:]
            for index in 0..<source.numberOfPages {
                guard let page = source.page(at: index + 1) else { continue }
                let found = try signatureBoxes(on: page, verified: verified)
                if found.contains(where: \.marked) { boxes[index] = found }
            }
            guard !boxes.isEmpty else { throw PdfChefVerifiedCopyError.noSignatureBox }

            let output = NSMutableData()
            // Invisible provenance, shown under document properties: the look stays like an
            // Acrobat printout while the file still says what it is and who checked it.
            var auxiliary: [CFString: Any] = [
                kCGPDFContextCreator: "PDF Chef",
                kCGPDFContextSubject: provenanceNote(checkedAt: checkedAt),
            ]
            if keepsPassword {
                auxiliary[kCGPDFContextUserPassword] = password
                auxiliary[kCGPDFContextOwnerPassword] = UUID().uuidString
                auxiliary[kCGPDFContextEncryptionKeyLength] = 128
            }
            guard let consumer = CGDataConsumer(data: output as CFMutableData),
                  let context = CGContext(consumer: consumer, mediaBox: nil, auxiliary as CFDictionary) else {
                throw PdfChefVerifiedCopyError.writeFailed
            }

            for index in 0..<pages.pageCount {
                guard let page = pages.page(at: index) else { throw PdfChefVerifiedCopyError.unreadable }
                // Rotated output needs its own transform, which is not verified yet.
                guard page.rotation % 360 == 0 else { throw PdfChefVerifiedCopyError.rotatedPage }
                let mediaBox = page.bounds(for: .mediaBox)
                let marked = boxes[index] ?? []

                var pageBox = CGRect(origin: .zero, size: mediaBox.size)
                let pageInfo = [kCGPDFContextMediaBox: Data(bytes: &pageBox, count: MemoryLayout<CGRect>.size)]
                context.beginPDFPage(pageInfo as CFDictionary)
                if marked.isEmpty {
                    page.draw(with: .mediaBox, to: context)
                } else {
                    // The original box would repaint "not verified". Draw the page contents, then
                    // every other annotation. PDFKit does not draw signature fields one by one,
                    // so every signature box on this page is redrawn below from its own
                    // appearance. Nothing in the document is changed.
                    guard let content = source.page(at: index + 1) else { throw PdfChefVerifiedCopyError.unreadable }
                    context.saveGState()
                    context.translateBy(x: -mediaBox.minX, y: -mediaBox.minY)
                    context.drawPDFPage(content)
                    context.restoreGState()
                    // PDFKit already draws annotations relative to the box origin.
                    for annotation in page.annotations
                    where annotation.shouldDisplay && annotation.widgetFieldType != .signature {
                        annotation.draw(with: .mediaBox, in: context)
                    }
                }

                for box in marked {
                    guard let appearance = CGDataProvider(data: box.appearance as CFData).flatMap(CGPDFDocument.init),
                          let appearancePage = appearance.page(at: 1) else {
                        throw PdfChefVerifiedCopyError.tooComplex
                    }
                    context.saveGState()
                    context.translateBy(x: box.rect.minX - mediaBox.minX, y: box.rect.minY - mediaBox.minY)
                    context.drawPDFPage(appearancePage)
                    context.restoreGState()
                }
                context.endPDFPage()
            }
            context.closePDF()

            if keepsPassword {
                guard let check = CGDataProvider(data: output as CFData).flatMap(CGPDFDocument.init),
                      check.isEncrypted, check.unlockWithPassword(password) else {
                    throw PdfChefVerifiedCopyError.writeFailed
                }
            }
            return output as Data
        }
    }

    /// Replaces only the first literal-string `Tj` operand of the n4 status layer, as Acrobat
    /// does for a valid signature. Nil when that cannot be done safely.
    static func validStatusLayer(from original: Data) -> Data? {
        let bytes = [UInt8](original)
        let whitespace: Set<UInt8> = [0, 9, 10, 12, 13, 32]
        let delimiters = whitespace.union(Set("()<>[]{}/%".utf8))
        func skip(_ start: Int) -> Int {
            var index = start
            while index < bytes.count {
                if bytes[index] == UInt8(ascii: "%") {
                    while index < bytes.count, bytes[index] != 10, bytes[index] != 13 { index += 1 }
                } else if whitespace.contains(bytes[index]) {
                    index += 1
                } else {
                    break
                }
            }
            return index
        }
        func token(_ offset: Int, _ text: String) -> Bool {
            let expected = Array(text.utf8)
            guard offset + expected.count <= bytes.count,
                  Array(bytes[offset..<(offset + expected.count)]) == expected else { return false }
            let end = offset + expected.count
            return end == bytes.count || delimiters.contains(bytes[end])
        }

        var beginTextEnd: Int?
        var shown: Range<Int>?
        var index = 0
        while index < bytes.count {
            index = skip(index)
            guard index < bytes.count else { break }
            let byte = bytes[index]
            if byte == UInt8(ascii: "(") {
                let start = index
                var depth = 1
                index += 1
                while index < bytes.count, depth > 0 {
                    let next = bytes[index]
                    index += 1
                    if next == UInt8(ascii: "\\"), index < bytes.count {
                        index += 1
                    } else if next == UInt8(ascii: "(") {
                        depth += 1
                    } else if next == UInt8(ascii: ")") {
                        depth -= 1
                    }
                }
                if depth == 0, shown == nil, token(skip(index), "Tj") { shown = start..<index }
            } else if byte == UInt8(ascii: "<"), index + 1 < bytes.count, bytes[index + 1] != UInt8(ascii: "<") {
                index = (bytes[(index + 1)...].firstIndex(of: UInt8(ascii: ">")) ?? bytes.count - 1) + 1
            } else if byte == UInt8(ascii: "/") {
                index += 1
                while index < bytes.count, !delimiters.contains(bytes[index]) { index += 1 }
            } else {
                if beginTextEnd == nil, token(index, "BT") { beginTextEnd = index + 2 }
                let start = index
                index += 1
                if !delimiters.contains(bytes[start]) {
                    while index < bytes.count, !delimiters.contains(bytes[index]) { index += 1 }
                }
            }
        }
        guard let beginTextEnd, let shown, beginTextEnd <= shown.lowerBound else { return nil }
        var result = Array(bytes[..<beginTextEnd])
        result += Array("\n0.13 0.5 0.25 rg\n".utf8)
        result += bytes[beginTextEnd..<shown.lowerBound]
        result += Array("(Signature valid)".utf8)
        result += bytes[shown.upperBound...]
        return Data(result)
    }

    private struct SignatureBox {
        let rect: CGRect
        /// A one-page PDF holding the widget's appearance, with its status layers set to valid
        /// when `marked`, or unchanged for unsigned and unverified signature fields.
        let appearance: Data
        let marked: Bool
    }

    /// The byte ranges of every AcroForm signature, which is exactly the set the report verified.
    private static func verifiedSignatureRanges(in catalog: CGPDFDictionaryRef) -> Set<[Int]> {
        guard let form = dictionary("AcroForm", in: catalog), let fields = array("Fields", in: form) else { return [] }
        var ranges: Set<[Int]> = []
        func collect(_ fields: CGPDFArrayRef, inheritedType: String?, depth: Int) {
            guard depth <= 32 else { return }
            for index in 0..<CGPDFArrayGetCount(fields) {
                var field: CGPDFDictionaryRef?
                guard CGPDFArrayGetDictionary(fields, index, &field), let field else { continue }
                let type = name("FT", in: field) ?? inheritedType
                if type == "Sig", let value = dictionary("V", in: field), let range = byteRange(of: value) {
                    ranges.insert(range)
                }
                if let kids = array("Kids", in: field) { collect(kids, inheritedType: type, depth: depth + 1) }
            }
        }
        collect(fields, inheritedType: nil, depth: 0)
        return ranges
    }

    /// Marks each visible box of a verified signature. Unsigned and unverified signature fields
    /// keep their own appearance; a verified signature whose box cannot be marked stops the copy,
    /// as does any other visible signature box on a marked page that cannot be redrawn as it is.
    private static func signatureBoxes(on page: CGPDFPage, verified: Set<[Int]>) throws -> [SignatureBox] {
        guard let pageDictionary = page.dictionary, let annotations = array("Annots", in: pageDictionary) else { return [] }

        var boxes: [SignatureBox] = []
        var unrenderable = false
        for index in 0..<CGPDFArrayGetCount(annotations) {
            var annotation: CGPDFDictionaryRef?
            var flags: CGPDFInteger = 0
            guard CGPDFArrayGetDictionary(annotations, index, &annotation), let annotation,
                  name("Subtype", in: annotation) == "Widget", isSignatureField(annotation),
                  let rect = rectangle("Rect", in: annotation)?.standardized, rect.width > 0, rect.height > 0 else { continue }
            // Hidden (2) and NoView (32) boxes are not drawn; a box with no appearance draws nothing.
            if CGPDFDictionaryGetInteger(annotation, "F", &flags), flags & (2 | 32) != 0 { continue }
            guard let appearanceSet = dictionary("AP", in: annotation) else { continue }
            guard let normal = stream("N", in: appearanceSet) else {
                unrenderable = true
                continue
            }
            guard let range = signatureValue(of: annotation).flatMap(byteRange), verified.contains(range) else {
                let original = AppearanceWriter(replacements: [:])
                boxes.append(SignatureBox(rect: rect, appearance: try original.document(for: normal, size: rect.size), marked: false))
                continue
            }
            guard let layers = layers(of: normal), let n1 = layers.n1 else {
                throw PdfChefVerifiedCopyError.unsupportedSignatureBox
            }

            var replacements = [identity(n1): validLayer]
            if let n3 = layers.n3 { replacements[identity(n3)] = blankLayer }
            if let n4 = layers.n4 {
                var format = CGPDFDataFormat.raw
                guard let status = CGPDFStreamCopyData(n4, &format) as Data?, format == .raw,
                      let valid = validStatusLayer(from: status) else {
                    throw PdfChefVerifiedCopyError.unsupportedSignatureBox
                }
                replacements[identity(n4)] = valid
            }
            let writer = AppearanceWriter(replacements: replacements)
            boxes.append(SignatureBox(rect: rect, appearance: try writer.document(for: normal, size: rect.size), marked: true))
        }
        if unrenderable, boxes.contains(where: \.marked) { throw PdfChefVerifiedCopyError.unsupportedSignatureBox }
        return boxes
    }

    private static func signatureValue(of widget: CGPDFDictionaryRef) -> CGPDFDictionaryRef? {
        var current: CGPDFDictionaryRef? = widget
        for _ in 0..<32 {
            guard let dictionary = current else { return nil }
            if let value = Self.dictionary("V", in: dictionary) { return value }
            current = Self.dictionary("Parent", in: dictionary)
        }
        return nil
    }

    private static func byteRange(of signature: CGPDFDictionaryRef) -> [Int]? {
        guard let range = array("ByteRange", in: signature), CGPDFArrayGetCount(range) == 4 else { return nil }
        var values: [Int] = []
        for index in 0..<4 {
            var value: CGPDFInteger = 0
            guard CGPDFArrayGetInteger(range, index, &value) else { return nil }
            values.append(Int(value))
        }
        return values
    }

    fileprivate static func identity(_ stream: CGPDFStreamRef) -> UnsafeRawPointer {
        unsafeBitCast(stream, to: UnsafeRawPointer.self)
    }

    private static func isSignatureField(_ field: CGPDFDictionaryRef) -> Bool {
        var current: CGPDFDictionaryRef? = field
        for _ in 0..<32 {
            guard let dictionary = current else { return false }
            if let type = name("FT", in: dictionary) { return type == "Sig" }
            current = Self.dictionary("Parent", in: dictionary)
        }
        return false
    }

    private static func layers(of normal: CGPDFStreamRef) -> (n1: CGPDFStreamRef?, n3: CGPDFStreamRef?, n4: CGPDFStreamRef?)? {
        guard let outer = CGPDFStreamGetDictionary(normal),
              let resources = dictionary("Resources", in: outer),
              let objects = dictionary("XObject", in: resources),
              let frame = stream("FRM", in: objects),
              let frameDictionary = CGPDFStreamGetDictionary(frame),
              let frameResources = dictionary("Resources", in: frameDictionary),
              let frameObjects = dictionary("XObject", in: frameResources) else { return nil }
        return (stream("n1", in: frameObjects), stream("n3", in: frameObjects), stream("n4", in: frameObjects))
    }

    fileprivate static func name(_ key: String, in dictionary: CGPDFDictionaryRef) -> String? {
        var value: UnsafePointer<CChar>?
        guard CGPDFDictionaryGetName(dictionary, key, &value), let value else { return nil }
        return String(cString: value)
    }

    fileprivate static func dictionary(_ key: String, in dictionary: CGPDFDictionaryRef) -> CGPDFDictionaryRef? {
        var value: CGPDFDictionaryRef?
        return CGPDFDictionaryGetDictionary(dictionary, key, &value) ? value : nil
    }

    fileprivate static func array(_ key: String, in dictionary: CGPDFDictionaryRef) -> CGPDFArrayRef? {
        var value: CGPDFArrayRef?
        return CGPDFDictionaryGetArray(dictionary, key, &value) ? value : nil
    }

    fileprivate static func stream(_ key: String, in dictionary: CGPDFDictionaryRef) -> CGPDFStreamRef? {
        var value: CGPDFStreamRef?
        return CGPDFDictionaryGetStream(dictionary, key, &value) ? value : nil
    }

    fileprivate static func numbers(_ key: String, in dictionary: CGPDFDictionaryRef, count: Int) -> [CGFloat]? {
        var array: CGPDFArrayRef?
        guard CGPDFDictionaryGetArray(dictionary, key, &array), let array, CGPDFArrayGetCount(array) == count else { return nil }
        var values: [CGFloat] = []
        for index in 0..<count {
            var number: CGPDFReal = 0
            guard CGPDFArrayGetNumber(array, index, &number) else { return nil }
            values.append(number)
        }
        return values
    }

    fileprivate static func rectangle(_ key: String, in dictionary: CGPDFDictionaryRef) -> CGRect? {
        guard let values = numbers(key, in: dictionary, count: 4) else { return nil }
        return CGRect(x: values[0], y: values[1], width: values[2] - values[0], height: values[3] - values[1])
    }
}

/// Copies one appearance stream and everything it references into a small unencrypted PDF whose
/// only page shows that appearance at the widget's size.
private final class AppearanceWriter {
    private static let maximumObjects = 512
    private static let maximumDepth = 32
    private static let maximumNodes = 20_000
    private static let maximumDecodedBytes = 8 * 1024 * 1024

    private let replacements: [UnsafeRawPointer: Data]
    private var numbers: [UnsafeRawPointer: Int] = [:]
    private var bodies: [Int: Data] = [:]
    private var nextNumber = 5
    private var nodes = 0
    private var decodedBytes = 0

    init(replacements: [UnsafeRawPointer: Data]) {
        self.replacements = replacements
    }

    func document(for appearance: CGPDFStreamRef, size: CGSize) throws -> Data {
        let form = try reference(to: appearance, depth: 0)
        guard let dictionary = CGPDFStreamGetDictionary(appearance),
              var box = PdfChefVerifiedCopy.rectangle("BBox", in: dictionary)?.standardized,
              box.width > 0, box.height > 0 else { throw PdfChefVerifiedCopyError.tooComplex }
        if let matrix = PdfChefVerifiedCopy.numbers("Matrix", in: dictionary, count: 6) {
            box = box.applying(CGAffineTransform(a: matrix[0], b: matrix[1], c: matrix[2], d: matrix[3], tx: matrix[4], ty: matrix[5]))
        }
        // PDF 12.5.5: map the (transformed) form box onto the annotation rectangle.
        let scaleX = size.width / box.width
        let scaleY = size.height / box.height
        let content = Data(String(format: "q %.6f 0 0 %.6f %.6f %.6f cm /AP Do Q\n",
                                  scaleX, scaleY, -box.minX * scaleX, -box.minY * scaleY).utf8)

        bodies[1] = Data("<< /Type /Catalog /Pages 2 0 R >>".utf8)
        bodies[2] = Data("<< /Type /Pages /Kids [3 0 R] /Count 1 >>".utf8)
        bodies[3] = Data(String(format: "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 %.4f %.4f] /Contents 4 0 R /Resources << /XObject << /AP %d 0 R >> >> >>",
                                size.width, size.height, form).utf8)
        bodies[4] = streamBody(dictionary: "", data: content)

        var file = Data("%PDF-1.7\n".utf8)
        var offsets: [Int] = []
        let count = nextNumber
        for number in 1..<count {
            offsets.append(file.count)
            file.append(Data("\(number) 0 obj\n".utf8))
            file.append(bodies[number] ?? Data("null".utf8))
            file.append(Data("\nendobj\n".utf8))
        }
        let xref = file.count
        file.append(Data("xref\n0 \(count)\n0000000000 65535 f \n".utf8))
        for offset in offsets { file.append(Data(String(format: "%010d 00000 n \n", offset).utf8)) }
        file.append(Data("trailer\n<< /Size \(count) /Root 1 0 R >>\nstartxref\n\(xref)\n%%EOF\n".utf8))
        return file
    }

    private func reference(to stream: CGPDFStreamRef, depth: Int) throws -> Int {
        let key = PdfChefVerifiedCopy.identity(stream)
        if let number = numbers[key] { return number }
        guard nextNumber < Self.maximumObjects, depth < Self.maximumDepth else { throw PdfChefVerifiedCopyError.tooComplex }
        let number = nextNumber
        nextNumber += 1
        numbers[key] = number

        var format = CGPDFDataFormat.raw
        guard let decoded = CGPDFStreamCopyData(stream, &format) as Data?, format == .raw,
              let dictionary = CGPDFStreamGetDictionary(stream) else { throw PdfChefVerifiedCopyError.tooComplex }
        decodedBytes += decoded.count
        guard decodedBytes <= Self.maximumDecodedBytes else { throw PdfChefVerifiedCopyError.tooComplex }
        let data = replacements[key] ?? decoded
        let entries = try serialize(dictionary, depth: depth + 1, skipping: ["Length", "Filter", "DecodeParms", "DL"])
        bodies[number] = streamBody(dictionary: entries, data: data)
        return number
    }

    private func streamBody(dictionary: String, data: Data) -> Data {
        var body = Data("<< /Length \(data.count) \(dictionary)>>\nstream\n".utf8)
        body.append(data)
        body.append(Data("\nendstream".utf8))
        return body
    }

    private func serialize(_ dictionary: CGPDFDictionaryRef, depth: Int, skipping: Set<String> = []) throws -> String {
        var entries: [(String, CGPDFObjectRef)] = []
        CGPDFDictionaryApplyBlock(dictionary, { key, value, _ in
            let name = String(cString: key)
            if !skipping.contains(name) { entries.append((name, value)) }
            return true
        }, nil)
        var result = ""
        for (key, value) in entries.sorted(by: { $0.0 < $1.0 }) {
            result += "\(Self.name(key)) \(try serialize(value, depth: depth)) "
        }
        return result
    }

    private func serialize(_ object: CGPDFObjectRef, depth: Int) throws -> String {
        nodes += 1
        guard depth < Self.maximumDepth, nodes <= Self.maximumNodes else { throw PdfChefVerifiedCopyError.tooComplex }
        switch CGPDFObjectGetType(object) {
        case .null:
            return "null"
        case .boolean:
            var value: CGPDFBoolean = 0
            CGPDFObjectGetValue(object, .boolean, &value)
            return value != 0 ? "true" : "false"
        case .integer:
            var value: CGPDFInteger = 0
            CGPDFObjectGetValue(object, .integer, &value)
            return "\(value)"
        case .real:
            var value: CGPDFReal = 0
            CGPDFObjectGetValue(object, .real, &value)
            return String(format: "%.6f", value)
        case .name:
            var value: UnsafePointer<CChar>?
            guard CGPDFObjectGetValue(object, .name, &value), let value else { throw PdfChefVerifiedCopyError.tooComplex }
            return Self.name(String(cString: value))
        case .string:
            var value: CGPDFStringRef?
            guard CGPDFObjectGetValue(object, .string, &value), let value, let bytes = CGPDFStringGetBytePtr(value) else {
                throw PdfChefVerifiedCopyError.tooComplex
            }
            let data = Data(bytes: bytes, count: CGPDFStringGetLength(value))
            return "<" + data.map { String(format: "%02x", $0) }.joined() + ">"
        case .array:
            var array: CGPDFArrayRef?
            guard CGPDFObjectGetValue(object, .array, &array), let array else { throw PdfChefVerifiedCopyError.tooComplex }
            var items: [String] = []
            for index in 0..<CGPDFArrayGetCount(array) {
                var item: CGPDFObjectRef?
                guard CGPDFArrayGetObject(array, index, &item), let item else { throw PdfChefVerifiedCopyError.tooComplex }
                items.append(try serialize(item, depth: depth + 1))
            }
            return "[" + items.joined(separator: " ") + "]"
        case .dictionary:
            var dictionary: CGPDFDictionaryRef?
            guard CGPDFObjectGetValue(object, .dictionary, &dictionary), let dictionary else { throw PdfChefVerifiedCopyError.tooComplex }
            return "<< " + (try serialize(dictionary, depth: depth + 1)) + ">>"
        case .stream:
            var stream: CGPDFStreamRef?
            guard CGPDFObjectGetValue(object, .stream, &stream), let stream else { throw PdfChefVerifiedCopyError.tooComplex }
            return "\(try reference(to: stream, depth: depth + 1)) 0 R"
        @unknown default:
            throw PdfChefVerifiedCopyError.tooComplex
        }
    }

    private static func name(_ value: String) -> String {
        let delimiters = Set("()<>[]{}/%#".utf8)
        return "/" + value.utf8.map { byte -> String in
            byte < 33 || byte > 126 || delimiters.contains(byte) ? String(format: "#%02X", byte) : String(UnicodeScalar(byte))
        }.joined()
    }
}
