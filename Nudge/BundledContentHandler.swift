import Foundation
import WebKit
import UIKit
import ImageIO
import CryptoKit

/// Exact product catalogue photographs only. The cache is separate from diary
/// storage and contains no user photos, tokens, nutrition or account details.
/// Both the camera and WebKit use it, so opening History reuses the same image.
actor CatalogueProductImages {
    static let shared = CatalogueProductImages()
    static let maximumImageBytes = 150_000
    static let maximumCacheBytes = 12_000_000
    static let maximumCacheCount = 256
    static let maximumMemoryBytes = 3_000_000
    static let maximumMemoryCount = 128
    static let thumbnailPixels = 200
    private let directory: URL
    private let fetcher: @Sendable (URL) async throws -> (Data, URLResponse)
    private var pending: [String: Task<Data, Error>] = [:]
    private struct MemoryEntry { let data: Data; var access: UInt64 }
    private var memory: [String: MemoryEntry] = [:]
    private var access: UInt64 = 0

    // A shared session reuses connections across cards/screens. It has no account
    // authorization, cookies or additional on-disk URLCache; only public photos
    // reach this transport and the bounded cache below owns their persistence.
    private static let session: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForResource = 12
        configuration.timeoutIntervalForRequest = 8
        configuration.httpMaximumConnectionsPerHost = 6
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: configuration, delegate: LabelSessionDelegate(), delegateQueue: nil)
    }()

    init(directory: URL? = nil, fetcher: @escaping @Sendable (URL) async throws -> (Data, URLResponse) = { url in try await CatalogueProductImages.download(url) }) {
        self.directory = directory ?? FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("NudgeProductImages", isDirectory: true)
        self.fetcher = fetcher
    }

    nonisolated static func sourceURL(_ value: String) -> URL? {
        guard value.count <= 2_000, value.rangeOfCharacter(from: .whitespacesAndNewlines) == nil, !value.contains("\\"),
              let url = URL(string: value), url.scheme?.lowercased() == "https",
              url.user == nil, url.password == nil, url.port == nil, url.query == nil, url.fragment == nil,
              ["images.openfoodfacts.org", "images.openfoodfacts.net"].contains(url.host?.lowercased() ?? ""),
              !url.path.split(separator: "/").contains(where: { $0 == "." || $0 == ".." }),
              ["jpg", "jpeg", "png", "webp"].contains(url.pathExtension.lowercased()) else { return nil }
        return url
    }

    /// Only OFF's documented product revision variants can be normalized. The
    /// selected source remains unchanged in product evidence/history; all views
    /// load a single small variant of that exact photograph and revision.
    /// OFF provides selected front photos at 200px; raw uploads guarantee 100px.
    nonisolated static func thumbnailURL(for source: URL) -> URL? {
        guard let source = sourceURL(source.absoluteString), !source.absoluteString.contains("%") else { return nil }
        let segments = source.path.split(separator: "/").map(String.init)
        guard segments.count >= 4, segments.count <= 9, segments[0] == "images", segments[1] == "products" else { return nil }
        let barcodeParts = Array(segments.dropFirst(2).dropLast())
        let barcode = barcodeParts.joined()
        guard (4...18).contains(barcode.count), barcodeParts.allSatisfy({ part in
            !part.isEmpty && part.utf8.allSatisfy { (48...57).contains($0) }
        }) else { return nil }
        let name = source.lastPathComponent
        let revision = #"^(front(?:_[a-z]{2,3}(?:[-_][a-z0-9]{2,8})?)?\.[0-9]+|[0-9]+)\.(?:100|200|400|full)\.jpg$"#
        let raw = #"^([0-9]+)\.jpg$"#
        guard let pattern = [revision, raw].first(where: { name.range(of: $0, options: .regularExpression) != nil }) else { return nil }
        let pixels = name.hasPrefix("front") ? "200" : "100"
        let filename = name.replacingOccurrences(of: pattern, with: "$1." + pixels + ".jpg", options: .regularExpression)
        var parts = URLComponents(url: source, resolvingAgainstBaseURL: false)
        parts?.host = "images.openfoodfacts.org"
        parts?.path = "/" + (Array(segments.dropLast()) + [filename]).joined(separator: "/")
        return parts?.url
    }

    nonisolated static func mirrorURL(for source: URL) -> URL? {
        guard let thumbnail = thumbnailURL(for: source) else { return nil }
        var parts = URLComponents(url: NudgeServiceConfiguration.backendURL.appendingPathComponent("v1/catalogue/image"), resolvingAgainstBaseURL: false)!
        parts.queryItems = [URLQueryItem(name: "source", value: thumbnail.absoluteString)]
        return parts.url
    }

    nonisolated static func download(_ url: URL) async throws -> (Data, URLResponse) {
        // Requests are either an allowlisted OFF source or our exact public
        // mirror route. Never turn this image loader into an arbitrary proxy.
        let approvedMirror: Bool = {
            guard let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
                  let items = parts.queryItems, items.count == 1, items[0].name == "source",
                  let source = items[0].value.flatMap(sourceURL) else { return false }
            return mirrorURL(for: source) == url
        }()
        guard sourceURL(url.absoluteString) != nil || approvedMirror else { throw URLError(.unsupportedURL) }
        let (data, response) = try await BoundedHTTPData.load(URLRequest(url: url), session: session, maximumBytes: 600_000)
        guard response.statusCode == 200, response.url == url,
              ["image/jpeg", "image/png", "image/webp"].contains(response.mimeType?.lowercased() ?? "") else { throw URLError(.badServerResponse) }
        return (data, response)
    }

    nonisolated static func normalized(_ data: Data, response: URLResponse, source: URL) throws -> Data {
        guard let response = response as? HTTPURLResponse, response.statusCode == 200,
              response.url == source, data.count <= 600_000,
              ["image/jpeg", "image/png", "image/webp"].contains(response.mimeType?.lowercased() ?? "") else { throw URLError(.badServerResponse) }
        return try thumbnail(data)
    }

    // This runs on the cache actor, away from the main/UI actor. ImageIO decodes
    // only the thumbnail instead of allocating a full-resolution source bitmap.
    nonisolated private static func thumbnail(_ data: Data, preserveCachedJPEG: Bool = false) throws -> Data {
        guard let imageSource = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary),
              let properties = CGImageSourceCopyPropertiesAtIndex(imageSource, 0, nil) as? [CFString: Any],
              let width = properties[kCGImagePropertyPixelWidth] as? Int,
              let height = properties[kCGImagePropertyPixelHeight] as? Int,
              width > 0, height > 0, width <= 3_000, height <= 3_000,
              let image = CGImageSourceCreateThumbnailAtIndex(imageSource, 0, [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceShouldCacheImmediately: true,
                kCGImageSourceThumbnailMaxPixelSize: thumbnailPixels
              ] as CFDictionary) else { throw URLError(.cannotDecodeContentData) }
        if preserveCachedJPEG, width <= thumbnailPixels, height <= thumbnailPixels,
           CGImageSourceGetType(imageSource) as String? == "public.jpeg" { return data }
        guard let preview = UIImage(cgImage: image).jpegData(compressionQuality: 0.8),
              preview.count <= maximumImageBytes else { throw URLError(.cannotDecodeContentData) }
        return preview
    }

    nonisolated private static func cacheKey(_ url: URL) -> String {
        SHA256.hash(data: Data(url.absoluteString.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    /// Old releases cached the supplied 100/400/full URL. Check only sibling
    /// sizes of the same exact revision so previously viewed foods stay visible
    /// offline after upgrading, without borrowing another product's photograph.
    nonisolated private static func legacyURLs(source: URL, thumbnail: URL) -> [URL] {
        var urls = [source]
        if thumbnailURL(for: source) != nil {
            for host in ["images.openfoodfacts.org", "images.openfoodfacts.net"] {
                for size in ["100", "200", "400", "full"] {
                    var parts = URLComponents(url: thumbnail, resolvingAgainstBaseURL: false)!
                    parts.host = host
                    parts.path = thumbnail.path.replacingOccurrences(of: #"\.(?:100|200)\.jpg$"#, with: "." + size + ".jpg", options: .regularExpression)
                    if let url = parts.url { urls.append(url) }
                }
                if thumbnail.lastPathComponent.range(of: #"^[0-9]+\.100\.jpg$"#, options: .regularExpression) != nil {
                    var parts = URLComponents(url: thumbnail, resolvingAgainstBaseURL: false)!
                    parts.host = host
                    parts.path = thumbnail.path.replacingOccurrences(of: #"\.100\.jpg$"#, with: ".jpg", options: .regularExpression)
                    if let url = parts.url { urls.append(url) }
                }
            }
        }
        return urls
    }

    func data(for source: URL) async throws -> Data {
        try Task.checkCancellation()
        guard let source = Self.sourceURL(source.absoluteString) else { throw URLError(.unsupportedURL) }
        let url = Self.thumbnailURL(for: source) ?? source
        let key = Self.cacheKey(url)
        if let cached = memory[key] { remember(cached.data, key: key); return cached.data }
        if let task = pending[key] { return try await task.value }
        let file = directory.appendingPathComponent(key + ".jpg")
        var checked = Set<String>()
        for candidate in [url] + Self.legacyURLs(source: source, thumbnail: url) {
            let candidateKey = Self.cacheKey(candidate)
            guard checked.insert(candidateKey).inserted else { continue }
            let candidateFile = directory.appendingPathComponent(candidateKey + ".jpg")
            guard let data = try? Data(contentsOf: candidateFile), data.count <= Self.maximumImageBytes,
                  let preview = try? Self.thumbnail(data, preserveCachedJPEG: true) else { continue }
            if candidateKey != key || preview != data { try? preview.write(to: file, options: .atomic); trimCache() }
            try? FileManager.default.setAttributes([.modificationDate: Date()], ofItemAtPath: candidateFile.path)
            remember(preview, key: key)
            return preview
        }
        let task = Task<Data, Error> {
            var requests = [URL]()
            if let mirror = Self.mirrorURL(for: url) { requests.append(mirror) }
            requests.append(url)
            if source != url { requests.append(source) }
            var failure: Error = URLError(.badServerResponse)
            for request in requests {
                do {
                    let (body, response) = try await fetcher(request)
                    let preview = try Self.normalized(body, response: response, source: request)
                    // Disk-full/cache eviction must never prevent a successfully
                    // loaded photo from displaying or affect saved food evidence.
                    try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
                    try? preview.write(to: file, options: .atomic)
                    remember(preview, key: key)
                    trimCache()
                    return preview
                } catch {
                    if error is CancellationError || (error as? URLError)?.code == .cancelled { throw error }
                    failure = error
                }
            }
            throw failure
        }
        pending[key] = task
        defer { pending[key] = nil }
        return try await task.value
    }

    private func remember(_ data: Data, key: String) {
        access &+= 1
        memory[key] = MemoryEntry(data: data, access: access)
        var total = memory.values.reduce(0) { $0 + $1.data.count }
        for entry in memory.sorted(by: { $0.value.access < $1.value.access }) {
            guard memory.count > Self.maximumMemoryCount || total > Self.maximumMemoryBytes else { break }
            total -= entry.value.data.count
            memory.removeValue(forKey: entry.key)
        }
    }

    private func trimCache() {
        let files = (try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: [.fileSizeKey, .contentModificationDateKey], options: .skipsHiddenFiles)) ?? []
        let records = files.filter { $0.pathExtension == "jpg" }.compactMap { url -> (URL, Int, Date)? in
            guard let values = try? url.resourceValues(forKeys: [.fileSizeKey, .contentModificationDateKey]) else { return nil }
            return (url, values.fileSize ?? 0, values.contentModificationDate ?? .distantPast)
        }.sorted { $0.2 > $1.2 }
        var bytes = 0
        for (index, record) in records.enumerated() {
            bytes += record.1
            if index >= Self.maximumCacheCount || bytes > Self.maximumCacheBytes { try? FileManager.default.removeItem(at: record.0) }
        }
    }
}

/// Gives the bundled web app a stable origin, including root-relative asset URLs.
/// No HTTP server, file-URL workaround or private WebKit API is used. Catalogue
/// photos have a separate, restricted native loader; WebKit remains offline.
@MainActor
final class BundledContentHandler: NSObject, WKURLSchemeHandler {
    static let contentPolicy = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"
    private let images: CatalogueProductImages
    private var imageTasks: [ObjectIdentifier: Task<Void, Never>] = [:]

    init(images: CatalogueProductImages = .shared) { self.images = images; super.init() }

    static func catalogueSource(for requestURL: URL) -> URL? {
        guard NudgeWebConfiguration.isLocal(requestURL), requestURL.path == "/catalogue-image",
              requestURL.fragment == nil,
              let items = URLComponents(url: requestURL, resolvingAgainstBaseURL: false)?.queryItems,
              items.count == 1, items[0].name == "url", let value = items[0].value else { return nil }
        return CatalogueProductImages.sourceURL(value)
    }

    static func resourceURL(for requestURL: URL, root: URL) -> URL? {
        guard NudgeWebConfiguration.isLocal(requestURL) else { return nil }
        let path = requestURL.path == "/" || requestURL.path.isEmpty ? "index.html" : requestURL.path
        let relativePath = path.hasPrefix("/") ? String(path.dropFirst()) : path
        let canonicalRoot = root.resolvingSymlinksInPath().standardizedFileURL
        let file = canonicalRoot.appendingPathComponent(relativePath)
            .resolvingSymlinksInPath().standardizedFileURL
        guard file.path.hasPrefix(canonicalRoot.path + "/") else { return nil }
        return file
    }

    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        if let url = urlSchemeTask.request.url, url.path == "/catalogue-image" {
            guard (urlSchemeTask.request.httpMethod ?? "GET") == "GET", let source = Self.catalogueSource(for: url) else {
                urlSchemeTask.didFailWithError(URLError(.unsupportedURL)); return
            }
            let id = ObjectIdentifier(urlSchemeTask)
            imageTasks[id] = Task { [weak self] in
                guard let self else { return }
                defer { self.imageTasks[id] = nil }
                do {
                    let data = try await self.images.data(for: source)
                    guard !Task.isCancelled else { return }
                    let response = URLResponse(url: url, mimeType: "image/jpeg", expectedContentLength: data.count, textEncodingName: nil)
                    urlSchemeTask.didReceive(response)
                    urlSchemeTask.didReceive(data)
                    urlSchemeTask.didFinish()
                } catch {
                    if !Task.isCancelled { urlSchemeTask.didFailWithError(error) }
                }
            }
            return
        }
        guard let url = urlSchemeTask.request.url,
              (urlSchemeTask.request.httpMethod ?? "GET") == "GET",
              let root = Bundle.main.url(forResource: "Web", withExtension: nil),
              let file = Self.resourceURL(for: url, root: root) else {
            urlSchemeTask.didFailWithError(URLError(.unsupportedURL))
            return
        }
        do {
            let data = try Data(contentsOf: file)
            let mimeTypes = [
                "html": "text/html; charset=utf-8", "js": "text/javascript; charset=utf-8",
                "css": "text/css; charset=utf-8", "json": "application/json",
                "webmanifest": "application/manifest+json", "png": "image/png",
                "webp": "image/webp", "svg": "image/svg+xml", "jpg": "image/jpeg",
                "jpeg": "image/jpeg", "txt": "text/plain; charset=utf-8"
            ]
            let headers = [
                "Content-Type": mimeTypes[file.pathExtension.lowercased()] ?? "application/octet-stream",
                "Content-Length": String(data.count), "Cache-Control": "no-cache",
                "X-Content-Type-Options": "nosniff", "Content-Security-Policy": Self.contentPolicy
            ]
            guard let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: headers) else {
                urlSchemeTask.didFailWithError(URLError(.badServerResponse))
                return
            }
            urlSchemeTask.didReceive(response)
            urlSchemeTask.didReceive(data)
            urlSchemeTask.didFinish()
        } catch {
            urlSchemeTask.didFailWithError(URLError(.fileDoesNotExist))
        }
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {
        imageTasks.removeValue(forKey: ObjectIdentifier(urlSchemeTask))?.cancel()
    }
}
