import XCTest
import WebKit
import UIKit
import CryptoKit
@testable import Nudge

private actor CatalogueImageRequestRecorder {
    private var requests: [URL] = []
    func record(_ url: URL) { requests.append(url) }
    func values() -> [URL] { requests }
}

private final class TestLabelBridge: NSObject, WKScriptMessageHandler {
    var accountRequestID: String?
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let value = message.body as? [String: Any],
              let action = value["action"] as? String, action.hasPrefix("account-") else { return }
        accountRequestID = value["requestId"] as? String
    }
}

@MainActor
final class NudgeTests: XCTestCase, WKNavigationDelegate {
    private var loaded: XCTestExpectation?

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { loaded?.fulfill() }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        XCTFail("The bundled app failed to load: \(error)")
        loaded?.fulfill()
    }

    func testPhotoCrewRunsInsideActualNativeLoadingRouteAndStopsOnTerminalError() throws {
        let web = NudgeWebConfiguration.makeWebView(messageHandler:TestLabelBridge(),dataStore:.nonPersistent())
        web.frame = CGRect(x:0,y:0,width:390,height:844)
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap {$0 as? UIWindowScene}.first)
        let previous = scene.windows.first(where:\.isKeyWindow), window = UIWindow(windowScene:scene), controller = UIViewController()
        controller.view.addSubview(web); window.rootViewController = controller; window.makeKeyAndVisible()
        defer { web.stopLoading();window.isHidden=true;previous?.makeKeyAndVisible() }
        open(web)
        _ = try evaluate("""
            NudgeLabel.begin(''); window.crewDraft=NudgeLabel._state.confirmationId; window.crewRequest=NudgeLabel._state.requestId;
            NudgeLabel.receive({type:'capture-status',draftId:crewDraft,requestId:crewRequest,photoCount:1,captureRevision:1});
            NudgeLabel.receive({type:'loading',draftId:crewDraft,requestId:crewRequest,photoCount:1,captureRevision:1});
            """,in:web)
        XCTAssertEqual(try evaluate("document.querySelectorAll('.n-analysis-crew').length",in:web) as? Int,1)
        XCTAssertEqual(try evaluate("document.querySelectorAll('[data-crew-state=complete]').length",in:web) as? Int,0)
        XCTAssertEqual(try evaluate("getComputedStyle(document.querySelector('.nc-arm')).animationName",in:web) as? String,"nc-arm-swing")
        _ = try evaluate("document.querySelector('[data-crew-toggle]').click()",in:web)
        XCTAssertEqual(try evaluate("NudgeLabel._state.phase",in:web) as? String,"loading")
        XCTAssertEqual(try evaluate("NudgeLabel._state.requestId===crewRequest",in:web) as? Bool,true)
        XCTAssertEqual(try evaluate("getComputedStyle(document.querySelector('.nc-arm')).animationPlayState",in:web) as? String,"paused")
        _ = try evaluate("document.querySelector('[data-crew-toggle]').click(); window.dispatchEvent(new Event('pagehide'));",in:web)
        XCTAssertEqual(try evaluate("getComputedStyle(document.querySelector('.nc-arm')).animationPlayState",in:web) as? String,"paused")
        _ = try evaluate("window.dispatchEvent(new Event('pageshow'));",in:web)
        for style in [UIUserInterfaceStyle.light,.dark] {
            window.overrideUserInterfaceStyle=style;controller.overrideUserInterfaceStyle=style;web.overrideUserInterfaceStyle=style
            let appearance=expectation(description:"Native appearance propagated")
            DispatchQueue.main.asyncAfter(deadline:.now()+0.3){appearance.fulfill()};wait(for:[appearance],timeout:5)
            XCTAssertEqual(web.traitCollection.userInterfaceStyle,style)
            XCTAssertEqual(try evaluate("matchMedia('(prefers-color-scheme: dark)').matches",in:web) as? Bool,style == .dark)
            let paint=expectation(description:"Crew paints")
            web.callAsyncJavaScript("await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));",arguments:[:],in:nil,in:.page){_ in paint.fulfill()};wait(for:[paint],timeout:10)
            let shot=expectation(description:"Native photo analysis screenshot")
            web.takeSnapshot(with:nil){image,error in
                XCTAssertNil(error)
                if let image { let attachment=XCTAttachment(image:image);attachment.name="WKWebView photo crew pending \(style.rawValue) — isolated event";attachment.lifetime = .keepAlways;self.add(attachment) }
                shot.fulfill()
            };wait(for:[shot],timeout:20)
        }
        _ = try evaluate("NudgeLabel.receive({type:'error',draftId:crewDraft,requestId:crewRequest,message:'Could not read this label. Try another angle.',canRetryPhotos:true});",in:web)
        XCTAssertEqual(try evaluate("document.querySelectorAll('.n-analysis-crew').length",in:web) as? Int,0)
        XCTAssertEqual(try evaluate("NudgeLabel._state.photoCount",in:web) as? Int,1)
        XCTAssertEqual(try evaluate("NudgeLabel._state.confirmationId===crewDraft",in:web) as? Bool,true)
    }

    func testResourcesStayInsideWebFolder() throws {
        let root = URL(fileURLWithPath: "/app/Web", isDirectory: true)
        let good = try XCTUnwrap(URL(string: "nudge-local://localhost/assets/nudge.png?v=10"))
        XCTAssertEqual(BundledContentHandler.resourceURL(for: good, root: root)?.path, "/app/Web/assets/nudge.png")
        for value in ["nudge-local://localhost/../Info.plist", "nudge-local://other/index.html", "https://localhost/index.html"] {
            XCTAssertNil(BundledContentHandler.resourceURL(for: try XCTUnwrap(URL(string: value)), root: root))
        }
    }

    func testCatalogueImageRouteAllowsOnlyApprovedRasterSources() throws {
        let source = "https://images.openfoodfacts.org/images/products/123/front_en.2.400.jpg"
        XCTAssertNotNil(CatalogueProductImages.sourceURL(source))
        XCTAssertNotNil(CatalogueProductImages.sourceURL("https://images.openfoodfacts.net/product.png"))
        for value in ["http://images.openfoodfacts.org/x.jpg", "https://images.openfoodfacts.org.evil.test/x.jpg", "https://www.openfoodfacts.org/x.jpg", "https://images.openfoodfacts.org:443/x.jpg", "https://token@images.openfoodfacts.org/x.jpg", "https://images.openfoodfacts.org/x.svg", "https://images.openfoodfacts.org/../x.jpg", "https://images.openfoodfacts.org/%2e%2e/x.jpg", "https://images.openfoodfacts.org/x.jpg?private=1", "https://images.openfoodfacts.org/x.jpg#hash", "file:///tmp/x.jpg"] {
            XCTAssertNil(CatalogueProductImages.sourceURL(value), value)
        }
        var parts = URLComponents(string: "nudge-local://localhost/catalogue-image")!
        parts.queryItems = [URLQueryItem(name: "url", value: source)]
        XCTAssertEqual(BundledContentHandler.catalogueSource(for: try XCTUnwrap(parts.url))?.absoluteString, source)
        parts.queryItems?.append(URLQueryItem(name: "url", value: source))
        XCTAssertNil(BundledContentHandler.catalogueSource(for: try XCTUnwrap(parts.url)))
        parts.queryItems = [URLQueryItem(name: "url", value: source)]; parts.host = "other"
        XCTAssertNil(BundledContentHandler.catalogueSource(for: try XCTUnwrap(parts.url)))
        XCTAssertTrue(BundledContentHandler.contentPolicy.contains("img-src 'self' data:;"))
        XCTAssertTrue(BundledContentHandler.contentPolicy.contains("connect-src 'none'"))
    }

    func testCatalogueImagesPersistAcrossOfflineCacheInstancesAndStayBounded() async throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("nudge-image-test-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: folder) }
        let data = try XCTUnwrap(UIGraphicsImageRenderer(size: CGSize(width: 20, height: 30)).image { context in
            UIColor.orange.setFill(); context.fill(CGRect(x: 0, y: 0, width: 20, height: 30))
        }.jpegData(compressionQuality: 0.8))
        let cache = CatalogueProductImages(directory: folder, fetcher: { url in
            (data, HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "image/jpeg"])!)
        })
        let source = URL(string: "https://images.openfoodfacts.org/example.jpg")!
        let first = try await cache.data(for: source)
        let offline = CatalogueProductImages(directory: folder, fetcher: { _ in throw URLError(.notConnectedToInternet) })
        let restored = try await offline.data(for: source)
        XCTAssertEqual(first, restored)
        XCTAssertLessThanOrEqual(restored.count, CatalogueProductImages.maximumImageBytes)
        for i in 0..<CatalogueProductImages.maximumCacheCount + 2 {
            _ = try await cache.data(for: URL(string: "https://images.openfoodfacts.org/fixture-\(i).jpg")!)
        }
        let files = try FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: [.fileSizeKey])
        XCTAssertLessThanOrEqual(files.count, CatalogueProductImages.maximumCacheCount)
        XCTAssertLessThanOrEqual(try files.reduce(0) { total, file in total + (try file.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0) }, CatalogueProductImages.maximumCacheBytes)
    }

    func testPublicCatalogueFrontImageSurvivesParsingAndLoadsIntoNativeImageCache() async throws {
        // Public OFF revision URL returned by the real catalogue contract probe.
        let source = "https://images.openfoodfacts.org/images/products/022/715/200/1161/front_en.6.400.jpg"
        let payload: [String: Any] = ["product": ["code": "0227152001161", "product_name": "Public catalogue fixture",
            "image_front_url": source, "image_front_small_url": source.replacingOccurrences(of: ".400.jpg", with: ".200.jpg")]]
        let product = try OpenFoodFactsParser.parse(data: JSONSerialization.data(withJSONObject: payload), barcode: "0227152001161")
        XCTAssertEqual(product.imageURL, source.replacingOccurrences(of: ".400.jpg", with: ".200.jpg"))
        let url = try XCTUnwrap(product.imageURL.flatMap(CatalogueProductImages.sourceURL))
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("nudge-public-image-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: folder) }
        let fixture = try XCTUnwrap(UIGraphicsImageRenderer(size: CGSize(width: 24, height: 36)).image { context in
            UIColor.orange.setFill(); context.fill(CGRect(x: 0, y: 0, width: 24, height: 36))
        }.jpegData(compressionQuality: 0.8))
        let cache = CatalogueProductImages(directory: folder, fetcher: { request in
            XCTAssertEqual(request, CatalogueProductImages.mirrorURL(for: url))
            return (fixture, HTTPURLResponse(url: request, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "image/jpeg"])!)
        })
        let loaded = try await cache.data(for: url)
        XCTAssertNotNil(UIImage(data: loaded), "The parsed source image must be usable by the SwiftUI image view")
        let offline = CatalogueProductImages(directory: folder, fetcher: { _ in throw URLError(.notConnectedToInternet) })
        let restored = try await offline.data(for: url)
        XCTAssertEqual(restored, loaded)
    }

    func testCatalogueThumbnailsUseOneCanonicalRevisionAndRestrictedCloudflareRoute() throws {
        let canonical = URL(string: "https://images.openfoodfacts.org/images/products/022/715/200/1161/front_en.6.200.jpg")!
        for host in ["images.openfoodfacts.org", "images.openfoodfacts.net"] {
            for size in ["100", "200", "400", "full"] {
                let supplied = URL(string: "https://" + host + "/images/products/022/715/200/1161/front_en.6." + size + ".jpg")!
                XCTAssertEqual(CatalogueProductImages.thumbnailURL(for: supplied), canonical)
                let proxy = try XCTUnwrap(CatalogueProductImages.mirrorURL(for: supplied))
                XCTAssertEqual(proxy.host, "configure-nudge-backend.invalid")
                XCTAssertEqual(proxy.path, "/v1/catalogue/image")
                XCTAssertEqual(URLComponents(url: proxy, resolvingAgainstBaseURL: false)?.queryItems,
                               [URLQueryItem(name: "source", value: canonical.absoluteString)])
            }
        }
        XCTAssertEqual(CatalogueProductImages.thumbnailURL(for: URL(string: "https://images.openfoodfacts.org/images/products/1001/7.jpg")!)?.lastPathComponent, "7.100.jpg")
        for invalid in ["https://other.example/images/products/1001/front_en.1.400.jpg",
                        "https://images.openfoodfacts.org/images/products/1001/nutrition_en.1.400.jpg",
                        "https://images.openfoodfacts.org/images/products/1001/front_en.1.400.jpg?x=1",
                        "https://images.openfoodfacts.org/images/products/1001/front_en.1.400.jpg#x",
                        "https://images.openfoodfacts.org/images/products/abc/front_en.1.400.jpg",
                        "https://images.openfoodfacts.org/images/products/1001/front_en.1.400.png",
                        "https://images.openfoodfacts.org/images/products/1001/front_en.1.%34%30%30.jpg"] {
            XCTAssertNil(CatalogueProductImages.mirrorURL(for: try XCTUnwrap(URL(string: invalid))), invalid)
        }
    }

    func testCatalogueImageConcurrentVariantsShareCloudflareFetchAndMemoryCache() async throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("nudge-image-concurrent-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: folder) }
        let format = UIGraphicsImageRendererFormat(); format.scale = 1
        let fixture = try XCTUnwrap(UIGraphicsImageRenderer(size: CGSize(width: 800, height: 600), format: format).image { context in
            UIColor.purple.setFill(); context.fill(CGRect(x: 0, y: 0, width: 800, height: 600))
        }.jpegData(compressionQuality: 0.8))
        let recorder = CatalogueImageRequestRecorder()
        let source = URL(string: "https://images.openfoodfacts.org/images/products/1001/front_en.2.400.jpg")!
        let small = URL(string: "https://images.openfoodfacts.net/images/products/1001/front_en.2.200.jpg")!
        let cache = CatalogueProductImages(directory: folder, fetcher: { request in
            await recorder.record(request)
            try await Task.sleep(nanoseconds: 20_000_000)
            return (fixture, HTTPURLResponse(url: request, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "image/jpeg"])!)
        })
        async let one = cache.data(for: source)
        async let two = cache.data(for: small)
        let (first, second) = try await (one, two)
        XCTAssertEqual(first, second)
        let decoded = try XCTUnwrap(UIImage(data: first)?.cgImage)
        XCTAssertLessThanOrEqual(max(decoded.width, decoded.height), CatalogueProductImages.thumbnailPixels)
        var requests = await recorder.values()
        XCTAssertEqual(requests, [try XCTUnwrap(CatalogueProductImages.mirrorURL(for: source))])
        try FileManager.default.removeItem(at: folder)
        let memoryHit = try await cache.data(for: source)
        XCTAssertEqual(memoryHit, first)
        requests = await recorder.values()
        XCTAssertEqual(requests.count, 1, "A RAM hit must not reread disk or redownload the photograph")
    }

    func testCatalogueImageMirrorFailureFallsBackToSmallOFFImageAndCachesIt() async throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("nudge-image-fallback-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: folder) }
        let format = UIGraphicsImageRendererFormat(); format.scale = 1
        let fixture = try XCTUnwrap(UIGraphicsImageRenderer(size: CGSize(width: 60, height: 40), format: format).image { context in
            UIColor.orange.setFill(); context.fill(CGRect(x: 0, y: 0, width: 60, height: 40))
        }.jpegData(compressionQuality: 0.8))
        let recorder = CatalogueImageRequestRecorder()
        let source = URL(string: "https://images.openfoodfacts.org/images/products/1001/front_en.2.400.jpg")!
        let small = try XCTUnwrap(CatalogueProductImages.thumbnailURL(for: source))
        let cache = CatalogueProductImages(directory: folder, fetcher: { request in
            await recorder.record(request)
            if request.host?.hasSuffix("workers.dev") == true {
                return (Data(), HTTPURLResponse(url: request, statusCode: 503, httpVersion: nil, headerFields: [:])!)
            }
            return (fixture, HTTPURLResponse(url: request, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "image/jpeg"])!)
        })
        let first = try await cache.data(for: source)
        let second = try await cache.data(for: small)
        XCTAssertEqual(first, second)
        let requests = await recorder.values()
        XCTAssertEqual(requests, [try XCTUnwrap(CatalogueProductImages.mirrorURL(for: source)), small])
        let offline = CatalogueProductImages(directory: folder, fetcher: { _ in throw URLError(.notConnectedToInternet) })
        let restored = try await offline.data(for: source)
        XCTAssertEqual(restored, first)
    }

    func testCatalogueImageCancellationDoesNotStartOFFFallback() async throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("nudge-image-cancel-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: folder) }
        let recorder = CatalogueImageRequestRecorder()
        let source = URL(string: "https://images.openfoodfacts.org/images/products/1001/front_en.2.400.jpg")!
        let cache = CatalogueProductImages(directory: folder, fetcher: { request in
            await recorder.record(request)
            throw URLError(.cancelled)
        })
        do { _ = try await cache.data(for: source); XCTFail("Cancelled image request succeeded") }
        catch { XCTAssertEqual((error as? URLError)?.code, .cancelled) }
        let requests = await recorder.values()
        XCTAssertEqual(requests.count, 1)
        XCTAssertFalse(FileManager.default.fileExists(atPath: folder.path))
    }

    func testCatalogueImageUpgradeRetainsPreviouslyCachedDisplayImageOffline() async throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("nudge-image-upgrade-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: folder) }
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let format = UIGraphicsImageRendererFormat(); format.scale = 1
        let fixture = try XCTUnwrap(UIGraphicsImageRenderer(size: CGSize(width: 400, height: 600), format: format).image { context in
            UIColor.green.setFill(); context.fill(CGRect(x: 0, y: 0, width: 400, height: 600))
        }.jpegData(compressionQuality: 0.8))
        let oldSource = "https://images.openfoodfacts.org/images/products/1001/front_en.2.400.jpg"
        let oldKey = SHA256.hash(data: Data(oldSource.utf8)).map { String(format: "%02x", $0) }.joined()
        try fixture.write(to: folder.appendingPathComponent(oldKey + ".jpg"))
        let offline = CatalogueProductImages(directory: folder, fetcher: { _ in throw URLError(.notConnectedToInternet) })
        let source = URL(string: oldSource.replacingOccurrences(of: ".400.jpg", with: ".200.jpg"))!
        let restored = try await offline.data(for: source)
        let image = try XCTUnwrap(UIImage(data: restored)?.cgImage)
        XCTAssertLessThanOrEqual(max(image.width, image.height), 200)
        XCTAssertTrue(FileManager.default.fileExists(atPath: folder.appendingPathComponent(oldKey + ".jpg").path), "Migrating display cache must not remove the original as if it were food history")
    }

    func testCatalogueImageMemoryCacheEvictsOldEntriesAtItsBound() async throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("nudge-image-memory-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: folder) }
        let fixture = try XCTUnwrap(UIGraphicsImageRenderer(size: CGSize(width: 20, height: 30)).image { context in
            UIColor.blue.setFill(); context.fill(CGRect(x: 0, y: 0, width: 20, height: 30))
        }.jpegData(compressionQuality: 0.8))
        let recorder = CatalogueImageRequestRecorder()
        let cache = CatalogueProductImages(directory: folder, fetcher: { request in
            await recorder.record(request)
            return (fixture, HTTPURLResponse(url: request, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "image/jpeg"])!)
        })
        let total = CatalogueProductImages.maximumMemoryCount + 1
        for index in 0..<total { _ = try await cache.data(for: URL(string: "https://images.openfoodfacts.org/fixture-\(index).jpg")!) }
        try FileManager.default.removeItem(at: folder)
        _ = try await cache.data(for: URL(string: "https://images.openfoodfacts.org/fixture-\(total - 1).jpg")!)
        var requests = await recorder.values()
        XCTAssertEqual(requests.count, total)
        _ = try await cache.data(for: URL(string: "https://images.openfoodfacts.org/fixture-0.jpg")!)
        requests = await recorder.values()
        XCTAssertEqual(requests.count, total + 1, "The oldest RAM image must have been evicted")
    }

    func testCatalogueImageCacheRejectsRedirectsNonImagesAndOversizedBodies() async throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("nudge-image-invalid-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: folder) }
        let source = URL(string: "https://images.openfoodfacts.org/example.jpg")!
        for (body, mime, status, url) in [
            (Data("<html>not a photo</html>".utf8), "image/jpeg", 200, source),
            (Data(repeating: 0, count: 600_001), "image/jpeg", 200, source),
            (Data("<svg></svg>".utf8), "image/svg+xml", 200, source),
            (Data(), "image/jpeg", 302, source),
            (Data(), "image/jpeg", 200, URL(string: "https://other.example/x.jpg")!)
        ] {
            let cache = CatalogueProductImages(directory: folder, fetcher: { _ in
                (body, HTTPURLResponse(url: url, statusCode: status, httpVersion: nil, headerFields: ["Content-Type": mime])!)
            })
            do { _ = try await cache.data(for: source); XCTFail("Invalid catalogue response accepted") } catch { }
        }
        XCTAssertFalse(FileManager.default.fileExists(atPath: folder.path))
    }

    func testCatalogueImageRendersThroughLocalRouteInActualWebKit() throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("nudge-image-webkit-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: folder) }
        let format = UIGraphicsImageRendererFormat(); format.scale = 1
        let fixture = try XCTUnwrap(UIGraphicsImageRenderer(size: CGSize(width: 24, height: 36), format: format).image { context in
            UIColor.purple.setFill(); context.fill(CGRect(x: 0, y: 0, width: 24, height: 36))
        }.jpegData(compressionQuality: 0.8))
        let cache = CatalogueProductImages(directory: folder, fetcher: { url in
            if url.lastPathComponent == "missing.jpg" { throw URLError(.fileDoesNotExist) }
            return (fixture, HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "image/jpeg"])!)
        })
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.setURLSchemeHandler(BundledContentHandler(images: cache), forURLScheme: NudgeWebConfiguration.scheme)
        let web = WKWebView(frame: CGRect(x: 0, y: 0, width: 390, height: 844), configuration: configuration)
        open(web)
        let rendered = expectation(description: "Catalogue image renders without relaxing the bundled CSP")
        web.callAsyncJavaScript("""
            const image = new Image(); image.className = 'nf-product-photo';
            const ready = new Promise((resolve, reject) => { image.onload = resolve; image.onerror = () => reject(new Error('Catalogue image did not load')); });
            image.src = NudgeResults.productImage({imageURL: 'https://images.openfoodfacts.org/fixture.jpg'}).src;
            document.body.append(image); await ready;
            const external = new Image();
            const denied = new Promise(resolve => { external.onload = () => resolve(false); external.onerror = () => resolve(true); });
            external.src = 'https://images.openfoodfacts.org/direct-request-is-blocked.jpg';
            const blocked = await denied;
            const fallback = new Image(); fallback.className = 'n-history-photo';
            fallback.dataset.nudgeFallback = captured;
            const recovered = new Promise((resolve, reject) => { fallback.onload = resolve; setTimeout(() => reject(new Error('Capture fallback did not load')), 5000); });
            fallback.src = NudgeResults.productImage({imageURL: 'https://images.openfoodfacts.org/missing.jpg'}).src;
            document.body.append(fallback); await recovered;
            return {width: image.naturalWidth, height: image.naturalHeight, src: image.getAttribute('src'), blocked, fallbackWidth: fallback.naturalWidth, fallbackSrc: fallback.getAttribute('src')};
            """, arguments: ["captured": "data:image/jpeg;base64," + fixture.base64EncodedString()], in: nil, in: .page) { result in
                switch result {
                case .success(let value):
                    let image = value as? [String: Any]
                    XCTAssertEqual(image?["width"] as? Int, 24)
                    XCTAssertEqual(image?["height"] as? Int, 36)
                    XCTAssertTrue((image?["src"] as? String)?.hasPrefix("/catalogue-image?url=") == true)
                    XCTAssertEqual(image?["blocked"] as? Bool, true)
                    XCTAssertEqual(image?["fallbackWidth"] as? Int, 24)
                    XCTAssertTrue((image?["fallbackSrc"] as? String)?.hasPrefix("data:image/jpeg;base64,") == true)
                case .failure(let error): XCTFail("Catalogue image failed in WKWebView: \(error)")
                }
                rendered.fulfill()
            }
        wait(for: [rendered], timeout: 20)
    }

    func testAppCanvasStaysAtOneScaleWhileLargerTextReflows() throws {
        let webView = NudgeWebConfiguration.makeWebView(dataStore: .nonPersistent())
        open(webView)
        webView.layoutSubviews()
        XCTAssertEqual(webView.scrollView.minimumZoomScale, 1)
        XCTAssertFalse(webView.scrollView.bouncesZoom)
        XCTAssertEqual(webView.scrollView.maximumZoomScale, 1)
        // An offscreen WKWebView may not create its recognizer; neither absent nor disabled can pinch.
        XCTAssertNotEqual(webView.scrollView.pinchGestureRecognizer?.isEnabled, true)
        webView.scrollView.setZoomScale(2, animated: false)
        webView.layoutSubviews()
        XCTAssertEqual(webView.scrollView.zoomScale, 1, accuracy: 0.01)
        webView.scrollView.setZoomScale(0.5, animated: false)
        webView.layoutSubviews()
        XCTAssertEqual(webView.scrollView.zoomScale, 1, accuracy: 0.01)
        webView.pageZoom = 0.5
        webView.layoutSubviews()
        XCTAssertEqual(webView.pageZoom, 1)
        let viewport = try evaluate("document.querySelector('meta[name=viewport]').content", in: webView) as? String
        XCTAssertTrue(viewport?.contains("minimum-scale=1") == true)
        XCTAssertFalse(viewport?.contains("user-scalable=no") == true)
        _ = try evaluate("document.documentElement.style.setProperty('--n-text-scale', '2');", in: webView)
        XCTAssertEqual(try evaluate("getComputedStyle(document.documentElement).getPropertyValue('--n-text-scale').trim()", in: webView) as? String, "2")
    }

    func testAccountStatusNeverChangesTheDeviceDiary() throws {
        let bridge = TestLabelBridge()
        let webView = NudgeWebConfiguration.makeWebView(messageHandler: bridge, dataStore: .nonPersistent())
        open(webView)
        let fixture = "{\"fixture\":\"isolated existing diary\",\"records\":[1,2,3]}"
        _ = try evaluate("localStorage.setItem('wmd-nudge-prototype-v1', '\(fixture)'); NudgeAccount.handleAction('account-show');", in: webView)
        let requestID = try XCTUnwrap(bridge.accountRequestID)
        _ = try evaluate("NudgeAccount.receive({type:'status',requestId:'\(requestID)',status:{state:'signedIn',available:true,email:'fixture@example.test'}});", in: webView)
        XCTAssertTrue((try evaluate("document.getElementById('app').textContent", in: webView) as? String)?.contains("fixture@example.test") == true)
        XCTAssertEqual(try evaluate("localStorage.getItem('wmd-nudge-prototype-v1')", in: webView) as? String, fixture)
        _ = try evaluate("NudgeAccount.receive({type:'status',requestId:'\(requestID)',status:{state:'signedOut',available:true}});", in: webView)
        XCTAssertEqual(try evaluate("localStorage.getItem('wmd-nudge-prototype-v1')", in: webView) as? String, fixture)
        XCTAssertFalse((try evaluate("document.getElementById('app').textContent", in: webView) as? String)?.contains("fixture@example.test") == true)
    }

    func testCustomerAnalysisErrorsDoNotRequestDeveloperCredentials() throws {
        let body = Data(#"{"code":"upstream_auth","message":"paste an API key"}"#.utf8)
        let failure = NutritionLabelService.errorForAccountHTTPResponse(statusCode: 502, data: body)
        XCTAssertTrue(failure?.errorDescription?.contains("temporarily unavailable") == true)
        XCTAssertFalse(failure?.errorDescription?.contains("API key") == true)
        XCTAssertEqual(NutritionLabelService.errorForAccountHTTPResponse(statusCode: 401, data: body)?.code, "signInRequired")
        XCTAssertNil(NutritionLabelService.errorForAccountHTTPResponse(statusCode: 200, data: body))
    }

    func testBundledScreensAndStorageAcrossWebViews() throws {
        let first = NudgeWebConfiguration.makeWebView()
        open(first)
        XCTAssertEqual(try evaluate("document.querySelectorAll('.bottom-nav button').length", in: first) as? Int, 5)
        XCTAssertEqual(try evaluate("document.getElementById('app').innerText.includes('loading.')", in: first) as? Bool, false)
        // Isolated probe key: this test never erases or rewrites a personal diary.
        let key = "nudge-ios-test-" + UUID().uuidString
        _ = try evaluate("localStorage.setItem('\(key)', 'saved'); location.hash = '#you';", in: first)
        let second = NudgeWebConfiguration.makeWebView()
        open(second)
        XCTAssertEqual(try evaluate("localStorage.getItem('\(key)')", in: second) as? String, "saved")
        _ = try evaluate("localStorage.removeItem('\(key)')", in: second)
    }

    func testBarcodeDiaryCleaningPreventsDuplicatesAndPreservesProvenance() throws {
        let webView = NudgeWebConfiguration.makeWebView(messageHandler: TestLabelBridge(), dataStore: .nonPersistent())
        open(webView)
        let productScript = """
        (() => {
          NudgeLabel.begin('');
          NudgeLabel.receive({type:'barcode-product',draftId:NudgeLabel._state.confirmationId,requestId:NudgeLabel._state.requestId,product:{
            barcode:'5012345678900', name:'Exact scanned product', brand:'Actual Brand', packSize:'250 g',
            ingredients:null, allergens:null, traces:null, basisUnit:'g', servingAmount:null, servingUnit:'g',
            nutrients:{energyKcal:{value:120,unit:'kcal',status:'supplied'},protein:{value:null,unit:'g',status:'unknown'}},
            sourceName:'Open Food Facts', sourceURL:'https://world.openfoodfacts.org/product/5012345678900',
            retrievedAt:'2026-09-30T12:00:00Z', licenceName:'Open Database Licence (ODbL)',
            licenceURL:'https://opendatacommons.org/licenses/odbl/1-0/'
          }});
          return document.getElementById('app').textContent;
        })()
        """
        let text = try XCTUnwrap(try evaluate(productScript, in: webView) as? String)
        XCTAssertTrue(text.contains("Exact scanned product"))
        XCTAssertTrue(text.contains("Actual Brand"))
        XCTAssertTrue(text.contains("Allergen information unavailable"))
        XCTAssertTrue(text.contains("Unavailable"))
        XCTAssertTrue(text.contains("Checking product facts…"))
        XCTAssertEqual(try evaluate("NudgeBarcode.detail().score.status", in: webView) as? String, "unrated")
        XCTAssertEqual(try evaluate("NudgeBarcode.detail().scoreLoading", in: webView) as? Bool, true)
        try assertProductFactsRemainOpen(in: webView)
        XCTAssertEqual(try evaluate("NudgeHistory.items().filter(item=>item.kind==='product').length", in: webView) as? Int, 1)
        XCTAssertEqual(try evaluate("JSON.parse(localStorage.getItem('wmd-nudge-prototype-v1')||'{}').foodLog?.entries?.length||0", in: webView) as? Int, 0)
        XCTAssertFalse(text.contains("Full-fat Greek yoghurt"))
        XCTAssertFalse(text.contains("Tomato ketchup"))

        let script = """
        (() => {
          const base = {
            day: '2026-09-30',
            slot: 'Snack',
            portions: 1,
            name: 'Scanned food',
            barcode: '5012345678900',
            portionAmount: 125,
            portionUnit: 'g',
            nutritionSnapshot: {
              protein: {per100: 4, portion: 5, unit: 'g', per100Status: 'supplied', portionStatus: 'calculated'},
              fibre: {per100: null, portion: null, unit: 'g', per100Status: 'unknown', portionStatus: 'unknown'}
            },
            sourceMeta: {
              provider: 'Open Food Facts',
              retrievedAt: '2026-09-30T12:00:00Z',
              confirmationId: 'same-confirmation'
            }
          };
          return JSON.stringify(WmdFoodLog.clean({entries:[
            {...base,id:'barcode-one'},
            {...base,id:'barcode-two'}
          ]}).entries);
        })()
        """
        let result = try XCTUnwrap(try evaluate(script, in: webView) as? String)
        let data = try XCTUnwrap(result.data(using: .utf8))
        let entries = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [[String: Any]])
        XCTAssertEqual(entries.count, 1)
        XCTAssertEqual(entries[0]["barcode"] as? String, "5012345678900")
        XCTAssertEqual(entries[0]["portionAmount"] as? Double, 125)
        XCTAssertEqual(entries[0]["nutritionStatus"] as? String, "incomplete")
        let snapshot = try XCTUnwrap(entries[0]["nutritionSnapshot"] as? [String: Any])
        let fibre = try XCTUnwrap(snapshot["fibre"] as? [String: Any])
        XCTAssertTrue(fibre["portion"] is NSNull)
        let source = try XCTUnwrap(entries[0]["sourceMeta"] as? [String: Any])
        XCTAssertEqual(source["provider"] as? String, "Open Food Facts")
        XCTAssertEqual(try evaluate("WmdFoodLog.summarise(WmdFoodLog.initial().entries).plants.length", in: webView) as? Int, 0)

        let labelScript = """
        (() => {
          NudgeLabel.begin('');
          const draftId=NudgeLabel._state.confirmationId;
          const checkboxAbsent=!document.getElementById('label-upload-consent');
          const requestId=NudgeLabel._state.requestId;
          NudgeLabel.receive({type:'capture-status',draftId,requestId,photoCount:2});
          NudgeLabel.receive({type:'loading',draftId,requestId});
          NudgeLabel.receive({type:'result',draftId,requestId,result:{extraction:{
            productName:'Exact scanned product',brand:'Actual Brand',
            basis:'per100g',servingSize:null,needsClearerPhoto:true,message:'Retake for fibre.',
            nutrients:{
              energyKcal:{value:619,unit:'kcal'},protein:{value:26.4,unit:'g'},
              carbohydrate:{value:10.1,unit:'g'},sugars:{value:5.5,unit:'g'},fat:{value:50.5,unit:'g'},
              saturatedFat:{value:6,unit:'g'},fibre:null,salt:{value:0.9,unit:'g'}
            }
          }}});
          const product=NudgeBarcode._scan.product;
          return JSON.stringify({checkboxAbsent,reviewText:document.getElementById('app').textContent,
            phase:NudgeBarcode._scan.phase,
            energyValue:product.nutrients.energyKcal.value,
            fibreUnknown:product.nutrients.fibre?.value==null,
            diaryEmpty:(JSON.parse(localStorage.getItem('wmd-nudge-prototype-v1')||'{}').foodLog?.entries||[]).length===0});
        })()
        """
        let labelResult = try XCTUnwrap(try evaluate(labelScript, in: webView) as? String)
        let labelData = try XCTUnwrap(labelResult.data(using: .utf8))
        let label = try XCTUnwrap(JSONSerialization.jsonObject(with: labelData) as? [String: Any])
        XCTAssertEqual(label["checkboxAbsent"] as? Bool, true)
        XCTAssertEqual(label["phase"] as? String, "product")
        XCTAssertEqual(label["energyValue"] as? Double, 619)
        XCTAssertEqual(label["fibreUnknown"] as? Bool, true)
        XCTAssertEqual(label["diaryEmpty"] as? Bool, true)
        try assertProductFactsRemainOpen(in: webView)
    }

    func testPrivateBackendValidationAndPhotoPixelLimit() throws {
        XCTAssertNotNil(BackendConfiguration.validatedURL("https://private-nudge.workers.dev"))
        for value in ["http://private-nudge.workers.dev", "https://example.invalid", "https://user:pass@example.com", "https://example.com/upload", "https://example.com?token=secret", "https://example.com#secret", "https://example.com:8443"] {
            XCTAssertNil(BackendConfiguration.validatedURL(value))
        }
        XCTAssertTrue(BackendConfiguration.validToken(String(repeating: "a", count: 64)))
        XCTAssertFalse(BackendConfiguration.validToken("sk-test-not-a-device-token"))
        XCTAssertFalse(BackendConfiguration.validToken(String(repeating: "A", count: 64)))
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let original = UIGraphicsImageRenderer(size: CGSize(width: 3000, height: 1500), format: format).image { context in
            UIColor.white.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 3000, height: 1500))
        }
        let data = try XCTUnwrap(NutritionLabelPickerController.resizedJPEG(from: original))
        let image = try XCTUnwrap(UIImage(data: data)?.cgImage)
        XCTAssertEqual(image.width, 2400)
        XCTAssertEqual(image.height, 1200)
        XCTAssertLessThanOrEqual(data.count, 6_000_000)
        let productData = try XCTUnwrap(NutritionLabelPickerController.resizedJPEG(from: original, maximumBytes: 1_500_000, maxDimension: 1_600))
        let productImage = try XCTUnwrap(UIImage(data: productData)?.cgImage)
        XCTAssertEqual(productImage.width, 1600)
        XCTAssertEqual(productImage.height, 800)
        XCTAssertLessThanOrEqual(productData.count, 1_500_000)
        XCTAssertNil(NutritionLabelPickerController.resizedJPEG(from: original, maximumBytes: 1, maxDimension: 100))
    }

    func testLabelUploadBodyPreservesPhotoRolesAndLegacyRequests() throws {
        // Distinct synthetic bytes verify role assignment without photos or credentials.
        let label = Data(repeating: 0xff, count: 48)
        let product = Data([0, 1, 2, 3, 4, 5])
        let legacyBody = try NutritionLabelService.uploadBody(jpegData: label)
        let legacy = try XCTUnwrap(JSONSerialization.jsonObject(with: legacyBody) as? [String: Any])
        XCTAssertEqual(Set(legacy.keys), Set(["mimeType", "imageBase64"]))
        XCTAssertEqual(legacy["mimeType"] as? String, "image/jpeg")
        let legacyEncoded = try XCTUnwrap(legacy["imageBase64"] as? String)
        XCTAssertTrue(Data(base64Encoded: legacyEncoded) == label)

        let pairBody = try NutritionLabelService.uploadBody(jpegData: label, productJPEGData: product)
        let pair = try XCTUnwrap(JSONSerialization.jsonObject(with: pairBody) as? [String: Any])
        XCTAssertEqual(Set(pair.keys), Set(["mimeType", "imageBase64", "productImage"]))
        XCTAssertEqual(pair["mimeType"] as? String, "image/jpeg")
        let labelEncoded = try XCTUnwrap(pair["imageBase64"] as? String)
        let productSlot = try XCTUnwrap(pair["productImage"] as? [String: String])
        XCTAssertEqual(Set(productSlot.keys), Set(["mimeType", "imageBase64"]))
        XCTAssertEqual(productSlot["mimeType"], "image/jpeg")
        let productEncoded = try XCTUnwrap(productSlot["imageBase64"])
        XCTAssertTrue(Data(base64Encoded: labelEncoded) == label)
        XCTAssertTrue(Data(base64Encoded: productEncoded) == product)
        XCTAssertFalse(String(decoding: pairBody, as: UTF8.self).contains(#"\/"#), "Base64 slash escaping must not inflate the bounded upload")
    }

    func testLabelUploadBodyHonoursCombinedLimitAndRejectsEmptySlots() throws {
        // Slash-heavy base64 reproduces the worst JSON escaping overhead at the limit.
        let label = Data(repeating: 0xff, count: 4_500_000)
        let product = Data(repeating: 0xff, count: 1_500_000)
        let pairBody = try NutritionLabelService.uploadBody(jpegData: label, productJPEGData: product)
        XCTAssertLessThanOrEqual(pairBody.count, 8_001_024)
        let pair = try XCTUnwrap(JSONSerialization.jsonObject(with: pairBody) as? [String: Any])
        let labelEncoded = try XCTUnwrap(pair["imageBase64"] as? String)
        let productSlot = try XCTUnwrap(pair["productImage"] as? [String: String])
        let productEncoded = try XCTUnwrap(productSlot["imageBase64"])
        XCTAssertTrue(Data(base64Encoded: labelEncoded) == label)
        XCTAssertTrue(Data(base64Encoded: productEncoded) == product)
        XCTAssertLessThanOrEqual(try NutritionLabelService.uploadBody(jpegData: Data(repeating: 0xff, count: 6_000_000)).count, 8_001_024)
        XCTAssertThrowsError(try NutritionLabelService.uploadBody(jpegData: label, productJPEGData: Data(repeating: 0xff, count: 1_500_001)))
        XCTAssertThrowsError(try NutritionLabelService.uploadBody(jpegData: Data(repeating: 0xff, count: 6_000_001)))
        XCTAssertThrowsError(try NutritionLabelService.uploadBody(jpegData: Data()))
        XCTAssertThrowsError(try NutritionLabelService.uploadBody(jpegData: Data(), productJPEGData: Data([1])))
        XCTAssertThrowsError(try NutritionLabelService.uploadBody(jpegData: Data([1]), productJPEGData: Data()))
    }

    func testMealHintUploadPreservesOnlyConfirmedContextAndRejectsInvalidValues() throws {
        let images = [Data([255, 216, 255, 217])]
        let hints = NativeMealAnalysisHints(ingredients: ["Strawberries", "Kefir"], portion: .init(amount: 568.26125, unit: "ml"))
        let data = try NutritionLabelService.uploadBody(images: images, mealHints: hints)
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let context = try XCTUnwrap(body["mealHints"] as? [String: Any])
        XCTAssertEqual(context["ingredients"] as? [String], ["Strawberries", "Kefir"])
        let portion = try XCTUnwrap(context["portion"] as? [String: Any])
        XCTAssertEqual(portion["unit"] as? String, "ml")
        XCTAssertEqual(portion["amount"] as? Double, 568.26125)
        XCTAssertEqual(Set(body.keys), Set(["images", "mealHints"]))
        let legacy = try XCTUnwrap(JSONSerialization.jsonObject(with: NutritionLabelService.uploadBody(images: images)) as? [String: Any])
        XCTAssertNil(legacy["mealHints"])
        for invalid in [NativeMealAnalysisHints(ingredients: []),
                        NativeMealAnalysisHints(ingredients: ["Milk", "Milk"]),
                        NativeMealAnalysisHints(ingredients: ["Milk"], portion: .init(amount: 0, unit: "ml")),
                        NativeMealAnalysisHints(ingredients: ["Milk"], portion: .init(amount: 500, unit: "cups"))] {
            XCTAssertThrowsError(try NutritionLabelService.uploadBody(images: images, mealHints: invalid))
        }
    }

    func testLabelHTTPFailuresKeepPrivateAndOpenAIAuthenticationSeparate() throws {
        let classifications = [
            ("upstream_auth", "OPENAI_API_KEY server secret"),
            ("upstream_access", "API-key permissions"),
            ("upstream_model", "model name"),
            ("upstream_billing", "billing and credit"),
            ("upstream_rate_limit", "rate limiting"),
            ("upstream_image", "could not read this photo")
        ]
        for (code, guidance) in classifications {
            let data = try JSONSerialization.data(withJSONObject: ["code": code])
            let error = try XCTUnwrap(NutritionLabelService.errorForHTTPResponse(statusCode: 502, data: data))
            let message = try XCTUnwrap(error.errorDescription)
            XCTAssertTrue(message.contains(guidance), code)
            XCTAssertTrue(message.contains("HTTP 502"), code)
            XCTAssertFalse(message.contains("device token"), code)
            XCTAssertNotEqual(error.code, "unauthenticated", code)
        }
        for status in [401, 403] {
            // A contradictory classification must not hide private-device authentication.
            let data = Data(#"{"code":"upstream_billing"}"#.utf8)
            let error = try XCTUnwrap(NutritionLabelService.errorForHTTPResponse(statusCode: status, data: data))
            XCTAssertEqual(error.code, "unauthenticated")
            XCTAssertTrue(error.errorDescription?.contains("private backend device token") == true)
            XCTAssertTrue(error.errorDescription?.contains("HTTP \(status)") == true)
            XCTAssertFalse(error.errorDescription?.contains("billing") == true)
        }
    }

    func testLabelHTTPErrorsIgnoreUntrustedAndOversizedMessages() throws {
        // Synthetic hostile text only; no real credential or provider response is used.
        let privateText = "provider-private-diagnostic-never-display"
        let known = try JSONSerialization.data(withJSONObject: ["code": "upstream_billing", "message": privateText])
        let classified = try XCTUnwrap(NutritionLabelService.errorForHTTPResponse(statusCode: 502, data: known)?.errorDescription)
        XCTAssertTrue(classified.contains("billing and credit"))
        XCTAssertFalse(classified.contains(privateText))

        let unknown = try JSONSerialization.data(withJSONObject: ["code": privateText, "message": privateText])
        let oversized = Data((String(repeating: " ", count: 4_097) + #"{"code":"upstream_auth"}"#).utf8)
        for body in [unknown, oversized, Data(#"{"code":123}"#.utf8), Data("<html>\(privateText)</html>".utf8), Data()] {
            let message = try XCTUnwrap(NutritionLabelService.errorForHTTPResponse(statusCode: 502, data: body)?.errorDescription)
            XCTAssertTrue(message.contains("OpenAI configuration"))
            XCTAssertTrue(message.contains("HTTP 502"))
            XCTAssertFalse(message.contains(privateText))
            XCTAssertFalse(message.contains("OPENAI_API_KEY server secret"))
        }
        let wrongStatus = try XCTUnwrap(NutritionLabelService.errorForHTTPResponse(statusCode: 400, data: known)?.errorDescription)
        XCTAssertTrue(wrongStatus.contains("photo upload"))
        XCTAssertFalse(wrongStatus.contains("billing"))
    }

    func testLabelHTTPFallbacksIncludeStatusAndPreserveSuccess() throws {
        for status in [307, 400, 404, 413, 415, 418, 422, 429, 500, 502, 503, 504, 520] {
            let message = try XCTUnwrap(NutritionLabelService.errorForHTTPResponse(statusCode: status, data: Data())?.errorDescription)
            XCTAssertTrue(message.contains("HTTP \(status)"))
            XCTAssertFalse(message.contains("Check the connection and try again"))
        }
        let busy = Data(#"{"code":"quota_busy"}"#.utf8)
        let limit = Data(#"{"code":"quota_exceeded"}"#.utf8)
        XCTAssertTrue(NutritionLabelService.errorForHTTPResponse(statusCode: 429, data: busy)?.errorDescription?.contains("Another label") == true)
        XCTAssertTrue(NutritionLabelService.errorForHTTPResponse(statusCode: 429, data: limit)?.errorDescription?.contains("limit has been reached") == true)
        XCTAssertNil(NutritionLabelService.errorForHTTPResponse(statusCode: 200, data: Data(#"{"code":"upstream_auth"}"#.utf8)))
    }

    func testIngredientResultPreservesUnknownsAndExistingResponseLimit() throws {
        let result = try NutritionLabelService.decodedResult(from: ingredientResultData())
        let extraction = try XCTUnwrap(result["extraction"] as? [String: Any])
        XCTAssertEqual(extraction["labelKind"] as? String, "ingredients")
        XCTAssertEqual(extraction["basis"] as? String, "unknown")
        XCTAssertTrue(extraction["servingSize"] is NSNull)
        let nutrients = try XCTUnwrap(extraction["nutrients"] as? [String: Any])
        XCTAssertEqual(nutrients.count, 8)
        XCTAssertTrue(nutrients.values.allSatisfy { $0 is NSNull })
        let ingredients = try XCTUnwrap(extraction["ingredients"] as? [String: Any])
        XCTAssertEqual(ingredients["needsReview"] as? Bool, false)
        let plants = try XCTUnwrap(ingredients["plants"] as? [[String: String]])
        XCTAssertEqual(plants.map { $0["name"] }, ["Oats", "Almonds", "Pumpkin"])
        XCTAssertEqual(plants[0]["evidence"], "rolled oats (60%)")

        // The additive payload keeps the existing byte limit and never needs
        // an authenticated request, persistent store or camera to be decoded.
        var bounded = Data(#"{"extraction":{}}"#.utf8)
        bounded.append(Data(repeating: 0x20, count: 65_536 - bounded.count))
        XCTAssertNoThrow(try NutritionLabelService.decodedResult(from: bounded))
        bounded.append(0x20)
        XCTAssertThrowsError(try NutritionLabelService.decodedResult(from: bounded))
        for invalid in ["[]", "{}", "{\"extraction\":null}", "not JSON"] {
            XCTAssertThrowsError(try NutritionLabelService.decodedResult(from: Data(invalid.utf8)))
        }
    }

    func testLongMealResultRetainsFortyComponentsAndVoiceReviewWithinBound() throws {
        let components = (0..<40).map { ["name": "Food \($0)", "sourceEvidence": String(repeating: "x", count: 2000)] }
        let meal: [String: Any] = ["components": components, "voiceIngredientReview": ["mentionedCount": 20, "needsReview": true]]
        let data = try JSONSerialization.data(withJSONObject: ["extraction": ["type": "meal", "meal": meal], "audioBase64": "must not reach web"])
        XCTAssertGreaterThan(data.count, 65_536)
        let result = try NutritionLabelService.decodedResult(from: data)
        let extraction = try XCTUnwrap(result["extraction"] as? [String: Any])
        let retained = try XCTUnwrap(extraction["meal"] as? [String: Any])
        XCTAssertEqual((retained["components"] as? [[String: Any]])?.count, 40)
        XCTAssertEqual((retained["voiceIngredientReview"] as? [String: Any])?["mentionedCount"] as? Int, 20)
        XCTAssertNil(result["audioBase64"])
        var over = data
        over.append(Data(repeating: 0x20, count: 262_145 - over.count))
        XCTAssertThrowsError(try NutritionLabelService.decodedResult(from: over))
    }

    func testIngredientResultReachesOpenProductDetailWithoutNutritionOrDiaryWrite() throws {
        let webView = NudgeWebConfiguration.makeWebView(messageHandler: TestLabelBridge(), dataStore: .nonPersistent())
        open(webView)
        // Decode the same native dictionary that the bridge serializes. Every
        // input is synthetic; this test cannot access the user's photos/diary.
        let result = try NutritionLabelService.decodedResult(from: ingredientResultData())
        let serialized = try JSONSerialization.data(withJSONObject: result)
        let resultJSON = try XCTUnwrap(String(data: serialized, encoding: .utf8))
        let script = """
        (() => {
          const diaryEntries=()=>JSON.stringify(JSON.parse(localStorage.getItem('wmd-nudge-prototype-v1')||'{}').foodLog?.entries||[]);
          const before=diaryEntries();
          NudgeLabel.begin('');
          const draftId=NudgeLabel._state.confirmationId;
          const checkboxAbsent=!document.getElementById('label-upload-consent');
          const cameraOpened=NudgeLabel._state.phase==='capturing';
          NudgeLabel.receive({type:'capture-status',draftId,requestId:NudgeLabel._state.requestId,photoCount:2});
          NudgeLabel.receive({type:'loading',draftId,requestId:NudgeLabel._state.requestId});
          NudgeLabel.receive({type:'result',draftId,requestId:NudgeLabel._state.requestId,result:\(resultJSON)});
          const product=NudgeBarcode._scan.product,detail=NudgeBarcode.detail();
          return JSON.stringify({
            checkboxAbsent,cameraOpened,phase:NudgeBarcode._scan.phase,
            reviewText:document.getElementById('app').textContent,
            name:product.name,ingredients:product.ingredients,
            plants:detail.plants.names,plantCount:detail.plants.names.length,
            historySaved:NudgeHistory.find(draftId)?.status==='ready',
            logAvailableForConfirmation:!document.querySelector('[data-action="detail-log"]').disabled,
            nutritionControlsAbsent:!document.getElementById('label-basis')&&!document.getElementById('label-energyKcal'),
            nutritionUnknown:Object.values(detail.nutrients).every(value=>value===null),
            diaryUnchanged:before===diaryEntries()
          });
        })()
        """
        let json = try XCTUnwrap(try evaluate(script, in: webView) as? String)
        let values = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])
        for flag in ["checkboxAbsent", "cameraOpened", "historySaved", "logAvailableForConfirmation", "nutritionControlsAbsent", "nutritionUnknown", "diaryUnchanged"] {
            XCTAssertEqual(values[flag] as? Bool, true, flag)
        }
        XCTAssertEqual(values["phase"] as? String, "product")
        try assertProductFactsRemainOpen(in: webView)
        XCTAssertEqual(values["name"] as? String, "Synthetic oat & seed mix")
        XCTAssertEqual(values["ingredients"] as? String, "Ingredients: rolled oats (60%), almonds (25%), pumpkin seeds (15%).")
        XCTAssertEqual(Set(try XCTUnwrap(values["plants"] as? [String])), Set(["oats", "almond", "pumpkin"]))
        XCTAssertEqual(values["plantCount"] as? Int, 3)
        let text = try XCTUnwrap(values["reviewText"] as? String)
        XCTAssertTrue(text.contains("Synthetic oat & seed mix"))
        XCTAssertTrue(text.contains("Unavailable"))
        XCTAssertTrue(text.contains("rolled oats (60%)"))
    }

    func testLabelConfirmationRepairTodayAndReloadInIsolatedStorage() throws {
        // This app instance uses an in-memory data store, never the user's diary.
        let webView = NudgeWebConfiguration.makeWebView(messageHandler: TestLabelBridge(), dataStore: .nonPersistent())
        open(webView)
        let script = """
        (() => {
          window.testLabelReview = (repairId,values) => {
            NudgeLabel.begin(repairId);
            const draftId=NudgeLabel._state.confirmationId;
            const requestId=NudgeLabel._state.requestId;
            NudgeLabel.receive({type:'capture-status',draftId,requestId,photoCount:repairId?1:2});
            NudgeLabel.receive({type:'loading',draftId,requestId});
            NudgeLabel.receive({type:'result',draftId,requestId,result:{extraction:{type:'product',labelKind:'nutrition',productName:repairId?'Different suggested name':'Isolated ManiLife test',brand:repairId?'Different suggested brand':'Test brand',basis:'per100g',servingSize:null,needsClearerPhoto:false,message:'',nutrients:values}}});
          };
          testLabelReview('',{energyKcal:{value:619,unit:'kcal'},protein:{value:26.4,unit:'g'}});
          const before=JSON.parse(localStorage.getItem('wmd-nudge-prototype-v1')||'{"foodLog":{"entries":[]}}').foodLog.entries.length;
          const autofilledName=NudgeBarcode._scan.product.name;
          const input=document.getElementById('detail-quantity');input.value='30';
          NudgeBarcode.handleChange(input);
          NudgeBarcode.handleAction('detail-log');
          NudgeBarcode.handleAction('detail-log');
          const saved=JSON.parse(localStorage.getItem('wmd-nudge-prototype-v1')).foodLog.entries;
          const diary=document.getElementById('app').textContent;
          testLabelReview(saved[0].id,{fibre:{value:9.1,unit:'g'}});
          NudgeLabel.handleAction('label-save');
          NudgeLabel.handleAction('label-save');
          const repaired=JSON.parse(localStorage.getItem('wmd-nudge-prototype-v1')).foodLog.entries;
          const hasConsumption=NudgeHistory.items().filter(item=>item.entry?.id===repaired[0].id).length===1;
          const scanPreserved=NudgeHistory.items().some(item=>item.kind==='product');
          document.querySelector('.bottom-nav [data-value="today"]').click();
          return JSON.stringify({before,count:repaired.length,sameId:saved[0].id===repaired[0].id,hasConsumption,scanPreserved,
            autofilledName,savedName:saved[0].name,savedBrand:saved[0].brand,
            repairedName:repaired[0].name,repairedBrand:repaired[0].brand,
            energy:repaired[0].energyPerPortion,protein:repaired[0].proteinPerPortion,
            fibre:repaired[0].fibrePerPortion,salt:repaired[0].nutritionSnapshot.salt.portion,
            diary,today:document.getElementById('app').textContent});
        })()
        """
        let json = try XCTUnwrap(try evaluate(script, in: webView) as? String)
        let values = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])
        XCTAssertEqual(values["before"] as? Int, 0)
        XCTAssertEqual(values["count"] as? Int, 1)
        XCTAssertEqual(values["sameId"] as? Bool, true)
        XCTAssertEqual(values["hasConsumption"] as? Bool, true)
        XCTAssertEqual(values["scanPreserved"] as? Bool, true)
        XCTAssertEqual(values["autofilledName"] as? String, "Isolated ManiLife test")
        XCTAssertEqual(values["savedName"] as? String, "Isolated ManiLife test")
        XCTAssertEqual(values["savedBrand"] as? String, "Test brand")
        XCTAssertEqual(values["repairedName"] as? String, "Isolated ManiLife test")
        XCTAssertEqual(values["repairedBrand"] as? String, "Test brand")
        XCTAssertEqual(values["energy"] as? Double, 185.7)
        XCTAssertEqual(try XCTUnwrap(values["protein"] as? Double), 7.92, accuracy: 0.000_001)
        XCTAssertEqual(try XCTUnwrap(values["fibre"] as? Double), 2.73, accuracy: 0.000_001)
        XCTAssertTrue(values["salt"] is NSNull)
        XCTAssertTrue((values["diary"] as? String)?.contains("30 g") == true)
        // Navigation handlers yield through async controllers; read after that JS turn.
        XCTAssertEqual(try evaluate("NudgeToday.model(JSON.parse(localStorage.getItem('wmd-nudge-prototype-v1')),new Date().toLocaleDateString('en-CA')).energy.value", in: webView) as? Double, 185.7)
        let todayText = try XCTUnwrap(try evaluate("document.getElementById('app').textContent", in: webView) as? String)
        XCTAssertTrue(todayText.contains("186"))
        XCTAssertTrue(todayText.contains("7.9"))
        open(webView)
        XCTAssertEqual(try evaluate("JSON.parse(localStorage.getItem('wmd-nudge-prototype-v1')).foodLog.entries.length", in: webView) as? Int, 1)
        XCTAssertEqual(try evaluate("JSON.parse(localStorage.getItem('wmd-nudge-prototype-v1')).foodLog.entries[0].name", in: webView) as? String, "Isolated ManiLife test")
        XCTAssertEqual(try evaluate("JSON.parse(localStorage.getItem('wmd-nudge-prototype-v1')).foodLog.entries[0].brand", in: webView) as? String, "Test brand")
    }

    func testFoodDetailHouseholdConversionsConfirmOnceAndUndoInRealWebKit() throws {
        let webView = NudgeWebConfiguration.makeWebView(messageHandler: TestLabelBridge(), dataStore: .nonPersistent())
        open(webView)
        let script = """
        (() => {
          const camera=document.querySelector('.bottom-nav [data-action="add-menu"]');
          const cameraLabel=camera.textContent.trim(),cameraName=camera.getAttribute('aria-label');
          NudgeLabel.begin('');
          const eventId=NudgeLabel._state.confirmationId;
          NudgeLabel.receive({type:'barcode-product',draftId:eventId,requestId:NudgeLabel._state.requestId,product:{
            barcode:'12345678',name:'Synthetic peanut butter',brand:'Test fixture',basisUnit:'g',nutritionPreparation:'as_sold',
            categories:['en:peanut-butters'],servingDescription:'1 level tablespoon (15 g)',servingAmount:15,servingUnit:'g',
            ingredients:'Peanuts, salt',allergens:['peanuts'],nutrients:{energyKcal:{value:619},protein:{value:26.4},fibre:{value:9.1}},
            sourceName:'Open Food Facts',sourceURL:'https://world.openfoodfacts.org/product/12345678'
          }});
          const key='wmd-nudge-prototype-v1',entries=()=>JSON.parse(localStorage.getItem(key)||'{}').foodLog?.entries||[];
          const countBefore=entries().length,start=NudgeBarcode.detail();
          for(let n=0;n<12;n++){
            NudgeBarcode.handleChange({id:'detail-measure',value:'teaspoon'});
            if(NudgeBarcode.detail().quantity!==3)throw Error('Tablespoon to teaspoons changed the amount');
            NudgeBarcode.handleChange({id:'detail-measure',value:'g'});
            NudgeBarcode.handleChange({id:'detail-measure',value:'tablespoon'});
          }
          const afterConversions=NudgeBarcode.detail().portion.canonicalAmount;
          NudgeBarcode.handleAction('detail-step','0.5');
          NudgeBarcode.handleAction('detail-step','0.5');
          const beforeConfirmation=NudgeBarcode.detail();
          NudgeBarcode.handleAction('detail-log');NudgeBarcode.handleAction('detail-log');
          const saved=entries()[0],countSaved=entries().length;
          NudgeHistory.reopen('diary:'+saved.id);
          const restored=NudgeBarcode.detail();NudgeBarcode.handleAction('detail-log');
          const countReopened=entries().length;
          NudgeBarcode.handleAction('detail-undo');NudgeBarcode.handleAction('detail-undo');
          return JSON.stringify({cameraLabel,cameraName,countBefore,afterConversions,
            startAmount:start.portion.canonicalAmount,scoreUnchanged:JSON.stringify(start.score)===JSON.stringify(beforeConfirmation.score),
            projectedProtein:beforeConfirmation.projection.protein.total,countSaved,countReopened,
            savedAmount:saved.portionAmount,savedProtein:saved.proteinPerPortion,savedFibre:saved.fibrePerPortion,
            savedMeasure:saved.sourceMeta.portionSelection.measureId,restoredAmount:restored.portion.canonicalAmount,
            countAfterUndo:entries().length,scanPreserved:NudgeHistory.find(eventId)?.kind==='product'});
        })()
        """
        let json = try XCTUnwrap(try evaluate(script, in: webView) as? String)
        let values = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])
        XCTAssertEqual(values["cameraLabel"] as? String, "Camera")
        XCTAssertEqual(values["cameraName"] as? String, "Open camera")
        XCTAssertEqual(values["countBefore"] as? Int, 0)
        XCTAssertEqual(values["startAmount"] as? Double, 15)
        XCTAssertEqual(values["afterConversions"] as? Double, 15)
        XCTAssertEqual(values["scoreUnchanged"] as? Bool, true)
        XCTAssertEqual(try XCTUnwrap(values["projectedProtein"] as? Double), 7.92, accuracy: 0.000_001)
        XCTAssertEqual(values["countSaved"] as? Int, 1)
        XCTAssertEqual(values["countReopened"] as? Int, 1)
        XCTAssertEqual(values["savedAmount"] as? Double, 30)
        XCTAssertEqual(values["restoredAmount"] as? Double, 30)
        XCTAssertEqual(try XCTUnwrap(values["savedProtein"] as? Double), 7.92, accuracy: 0.000_001)
        XCTAssertEqual(try XCTUnwrap(values["savedFibre"] as? Double), 2.73, accuracy: 0.000_001)
        XCTAssertEqual(values["savedMeasure"] as? String, "tablespoon")
        XCTAssertEqual(values["countAfterUndo"] as? Int, 0)
        XCTAssertEqual(values["scanPreserved"] as? Bool, true)
        try assertProductFactsRemainOpen(in: webView)
    }

    private func ingredientResultData() -> Data {
        Data(#"""
        {"extraction":{
          "productName":"Synthetic oat & seed mix","brand":"Synthetic fixture",
          "labelKind":"ingredients","basis":"unknown","servingSize":null,
          "needsClearerPhoto":false,"message":"",
          "ingredients":{"text":"Ingredients: rolled oats (60%), almonds (25%), pumpkin seeds (15%).","needsReview":false,
            "plants":[{"name":"Oats","evidence":"rolled oats (60%)"},{"name":"Almonds","evidence":"almonds (25%)"},{"name":"Pumpkin","evidence":"pumpkin seeds (15%)"}]},
          "nutrients":{"energyKcal":null,"protein":null,"carbohydrate":null,"sugars":null,"fat":null,"saturatedFat":null,"fibre":null,"salt":null}
        }}
        """#.utf8)
    }

    /// Product facts and logging controls stay open; only the scoring method
    /// explanation is an intentional disclosure in the current score UI.
    private func assertProductFactsRemainOpen(in webView: WKWebView, file: StaticString = #filePath, line: UInt = #line) throws {
        let script = """
        (() => {
          const detail=document.querySelector('.nf-detail');
          if(!detail)return null;
          const facts=['.nf-portion-fields','.nf-portion-actions','.nf-four','.nf-daily','.nf-risk-list','.nf-nutrition','.nf-ingredients','.nf-score-breakdown'];
          const visibleFacts=Object.fromEntries(facts.map(selector=>{
            const node=detail.querySelector(selector),style=node?getComputedStyle(node):null;
            return [selector,Boolean(node&&!node.closest('details')&&!node.hidden&&style.display!=='none'&&style.visibility!=='hidden')];
          }));
          return JSON.stringify({
            methodDisclosures:detail.querySelectorAll('details.nf-score-method').length,
            methodSummary:detail.querySelector('details.nf-score-method > summary')?.textContent.trim(),
            otherDisclosures:detail.querySelectorAll('details:not(.nf-score-method)').length,
            visibleFacts
          });
        })()
        """
        let json = try XCTUnwrap(try evaluate(script, in: webView) as? String, file: file, line: line)
        let values = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any], file: file, line: line)
        XCTAssertEqual(values["methodDisclosures"] as? Int, 1, file: file, line: line)
        XCTAssertEqual(values["methodSummary"] as? String, "How this rating works", file: file, line: line)
        XCTAssertEqual(values["otherDisclosures"] as? Int, 0, "Food facts must not be hidden behind another disclosure", file: file, line: line)
        let facts = try XCTUnwrap(values["visibleFacts"] as? [String: Bool], file: file, line: line)
        XCTAssertEqual(facts.count, 8, file: file, line: line)
        for (selector, visible) in facts {
            XCTAssertTrue(visible, "\(selector) must exist and remain open", file: file, line: line)
        }
    }

    private func open(_ webView: WKWebView) {
        loaded = expectation(description: "Bundled page loads")
        webView.navigationDelegate = self
        webView.load(URLRequest(url: NudgeWebConfiguration.startURL))
        // A cold simulator can take over a minute to launch WebKit processes.
        wait(for: [loaded!], timeout: 120)
        loaded = nil
    }

    private func evaluate(_ script: String, in webView: WKWebView) throws -> Any? {
        let finished = expectation(description: "JavaScript finishes")
        var value: Any?
        var failure: Error?
        webView.evaluateJavaScript(script) { result, error in
            value = result
            failure = error
            finished.fulfill()
        }
        wait(for: [finished], timeout: 30)
        if let failure = failure { throw failure }
        return value
    }
}

/// Opt-in replay of real, privately saved service responses in the iOS renderer.
/// No fixture food or credentials ship; this never uses the owner's data store.
@MainActor
final class LocalLivePhotoResponseTests: XCTestCase, WKNavigationDelegate {
    private var navigation: XCTestExpectation?
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { self.navigation?.fulfill() }

    func testRealMealAndLabelResponsesInIsolatedNativeWebView() throws {
        #if targetEnvironment(simulator)
        let folder = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent(".local/live-photo-checks/ios-replay", isDirectory: true)
        guard FileManager.default.fileExists(atPath: folder.appendingPathComponent("meal.json").path) else {
            throw XCTSkip("Opt-in real service responses are absent; normal tests make no paid requests.")
        }
        for kind in ["meal", "product"] {
            let data = try Data(contentsOf: folder.appendingPathComponent(kind + ".json"))
            let response = try NutritionLabelService.decodedResult(from: data)
            let trace = try XCTUnwrap(response["trace"] as? [String: Any])
            XCTAssertEqual(trace["visionInvoked"] as? Bool, true)
            XCTAssertEqual(trace["parseStatus"] as? String, "validated")
            let extraction = try XCTUnwrap(response["extraction"] as? [String: Any])
            XCTAssertEqual(extraction["type"] as? String, kind)
            let estimatedServing = (extraction["meal"] as? [String: Any])?["portionMode"] as? String == "estimated_serving"
            var photos = try [Data(contentsOf: folder.appendingPathComponent(kind + ".jpg"))]
            if kind == "product" { photos.append(try Data(contentsOf: folder.appendingPathComponent("product-label.jpg"))) }
            // Exercise the exact native upload serializer with the same real pixels.
            let upload = try NutritionLabelService.uploadBody(images: photos)
            let uploaded = try XCTUnwrap(JSONSerialization.jsonObject(with: upload) as? [String: Any])
            XCTAssertEqual((uploaded["images"] as? [[String: String]])?.first?["imageBase64"], photos[0].base64EncodedString())
            let image = try XCTUnwrap(UIImage(data: photos[0]))
            let jpeg = try XCTUnwrap(NutritionLabelPickerController.resizedJPEG(from: image, maximumBytes: 180_000, maxDimension: 1_000))
            XCTAssertLessThan(jpeg.base64EncodedString().count, 250_000)
            let web = NudgeWebConfiguration.makeWebView(messageHandler: TestLabelBridge(), dataStore: .nonPersistent())
            web.frame = CGRect(x: 0, y: 0, width: 390, height: 844)
            let controller = UIViewController(); controller.view.addSubview(web)
            let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
            let previousKeyWindow = scene.windows.first { $0.isKeyWindow }
            let window = UIWindow(windowScene: scene); window.frame = web.frame
            window.rootViewController = controller; window.makeKeyAndVisible()
            navigation = expectation(description: "Real app page loads")
            web.navigationDelegate = self; web.load(URLRequest(url: NudgeWebConfiguration.startURL))
            wait(for: [navigation!], timeout: 120); navigation = nil
            let event: [String: Any] = ["result": response, "photoPreview": "data:image/jpeg;base64," + jpeg.base64EncodedString(), "photoCount": kind == "product" ? 2 : 1, "thumbnail": CameraHistoryThumbnail.dataURL(from: photos[0]) ?? ""]
            let json = try XCTUnwrap(String(data: JSONSerialization.data(withJSONObject: event), encoding: .utf8))
            let ready = expectation(description: "Actual response renders")
            web.evaluateJavaScript("""
                (() => { NudgeLabel.begin(''); const e=\(json), s=NudgeLabel._state;
                NudgeLabel.receive({type:'loading',draftId:s.confirmationId,requestId:s.requestId,...e});
                NudgeLabel.receive({type:'result',draftId:s.confirmationId,requestId:s.requestId,...e});
                return {meal:document.querySelectorAll('.n-photo-review').length,
                  product:document.querySelectorAll('.nf-detail').length,
                  confirmDisabled:document.querySelector('[data-action="label-save"]')?.disabled,
                  mealScoreVisible:!!document.querySelector('.n-meal-score'),
                  numericMealMetrics:[...document.querySelectorAll('.n-meal-metrics strong')].filter(e=>/[0-9]/.test(e.textContent)).length,
                  entries:JSON.parse(localStorage.getItem('wmd-nudge-prototype-v1')||'{}').foodLog?.entries?.length||0,
                  width:document.documentElement.scrollWidth, viewport:innerWidth}; })()
                """) { result, error in
                XCTAssertNil(error)
                let values = result as? [String: Any]
                XCTAssertEqual(values?[kind] as? Int, 1)
                XCTAssertEqual(values?["entries"] as? Int, 0)
                if kind == "meal" {
                    // Legacy serving dishes require a share. New results propose
                    // an explicitly estimated serving that still needs Confirm.
                    XCTAssertEqual(values?["confirmDisabled"] as? Bool, !estimatedServing)
                    if estimatedServing {
                        XCTAssertEqual(values?["mealScoreVisible"] as? Bool, true)
                        XCTAssertEqual(values?["numericMealMetrics"] as? Int, 4)
                    }
                }
                XCTAssertEqual(values?["width"] as? Int, values?["viewport"] as? Int)
                ready.fulfill()
            }
            wait(for: [ready], timeout: 30)
            let painted = expectation(description: "Visible web content paints")
            web.callAsyncJavaScript("await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));", arguments: [:], in: nil, in: .page) { _ in painted.fulfill() }
            wait(for: [painted], timeout: 10)
            let snapshot = expectation(description: "Native result screenshot")
            web.takeSnapshot(with: nil) { image, error in
                XCTAssertNil(error)
                XCTAssertNotNil(image)
                if let image {
                    if let pixels = image.cgImage?.dataProvider?.data as Data? {
                        XCTAssertGreaterThan(Set(stride(from: 0, to: pixels.count, by: 97).map { pixels[$0] }).count, 16, "The renderer must produce visible content, not a blank snapshot")
                    }
                    let attachment = XCTAttachment(image: image); attachment.name = "Real service \(kind) response in Nudge WKWebView"; attachment.lifetime = .keepAlways; self.add(attachment)
                }
                snapshot.fulfill()
            }
            wait(for: [snapshot], timeout: 30)
            window.isHidden = true
            previousKeyWindow?.makeKeyAndVisible()
        }
        #else
        throw XCTSkip("Live-response replay is simulator-only.")
        #endif
    }
}

final class AppDiagnosticsTests: XCTestCase {
    func testWebEventsKeepOnlyTechnicalBucketsAndCannotImpersonateNativeResults() throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at:folder) }
        let diagnostics = AnalysisDiagnostics(directory:folder)
        XCTAssertTrue(diagnostics.recordWebEvent(["action":"app-diagnostic", "stage":"storage", "outcome":"quota_exceeded",
            "requestId":"private-correlation", "metadata":["store":"history", "operation":"write", "errorClass":"quota",
                "payloadBytes":12345, "durable":false, "screen":"history", "message":"private-food-description", "stack":"private-stack"]]))
        XCTAssertFalse(diagnostics.recordWebEvent(["action":"app-diagnostic", "stage":"http_response", "outcome":"received", "metadata":["httpStatus":200]]))
        XCTAssertFalse(diagnostics.recordWebEvent(["action":"app-diagnostic", "stage":"storage", "outcome":"private-text"]))
        let data = try diagnostics.exportData()
        let doc = try XCTUnwrap(JSONSerialization.jsonObject(with:data) as? [String:Any])
        let events = try XCTUnwrap(doc["events"] as? [[String:Any]])
        XCTAssertEqual(events.count,1)
        let metadata = try XCTUnwrap(events.first?["metadata"] as? [String:Any])
        XCTAssertEqual(metadata["store"] as? String,"history")
        XCTAssertEqual(metadata["requestHash"] as? String,AnalysisDiagnostics.fingerprint("private-correlation"))
        XCTAssertFalse(String(decoding:data,as:UTF8.self).contains("private-"))
        XCTAssertTrue(AnalysisDiagnostics.safeMetadata(["store":"private", "screen":"private", "errorClass":"private", "knownNutrientCount":true,
            "zeroNutrientCount":-1, "missingNutrientCount":9, "nativeElapsedMs":Double.infinity, "durable":1]).isEmpty)
    }

    func testSupportExportRevalidatesStoredEventsAndNeverSharesDiaryContent() throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at:folder) }
        try FileManager.default.createDirectory(at:folder,withIntermediateDirectories:true)
        let now = Date()
        let raw: [String:Any] = ["version":1, "diary":"private-diary", "events":[
            ["time":now.timeIntervalSince1970, "stage":"storage", "outcome":"save_failed", "metadata":["store":"main", "rawValue":"private-nutrients"]],
            ["time":now.timeIntervalSince1970, "stage":"private-food", "outcome":"saved", "metadata":[:]],
            ["time":now.timeIntervalSince1970 + 1, "stage":"storage", "outcome":"saved", "metadata":[:]]]]
        try JSONSerialization.data(withJSONObject:raw).write(to:folder.appendingPathComponent("events.json"))
        let data = try AnalysisDiagnostics(directory:folder).exportData(now:now)
        XCTAssertFalse(String(decoding:data,as:UTF8.self).contains("private"))
        let doc = try XCTUnwrap(JSONSerialization.jsonObject(with:data) as? [String:Any])
        XCTAssertEqual((doc["events"] as? [Any])?.count,1)
        try Data(repeating:65,count:AnalysisDiagnostics.maximumBytes + 1).write(to:folder.appendingPathComponent("events.json"))
        XCTAssertThrowsError(try AnalysisDiagnostics(directory:folder).exportData(now:now))
    }

    func testNativeAndBackendTimeoutsRemainDistinctWithEnoughDeliveryTime() throws {
        let local = NutritionLabelService.publicFailure(URLError(.timedOut))
        XCTAssertEqual(local.code,"analysis_timeout")
        XCTAssertTrue(local.message.contains("connection timed out"))
        let server = try XCTUnwrap(NutritionLabelService.errorForAccountHTTPResponse(statusCode:504,data:Data(#"{"code":"upstream_timeout"}"#.utf8)))
        XCTAssertEqual(NutritionLabelService.publicFailure(server).code,"upstream_timeout")
        XCTAssertEqual(NutritionLabelService.publicFailure(URLError(.notConnectedToInternet)).code,"analysis_connection")
        for includesVoice in [false,true] {
            let limits = NutritionLabelService.analysisTimeouts(includesVoiceMemo:includesVoice)
            XCTAssertGreaterThanOrEqual(limits.request,55)
            XCTAssertGreaterThan(limits.resource,limits.request)
            XCTAssertLessThanOrEqual(limits.resource,60)
        }
    }

    func testAnalysisConnectionsAreReusedWithoutSharedCredentialsOrResponseStorage() {
        XCTAssertTrue(NutritionLabelService.analysisSession === NutritionLabelService.analysisSession)
        XCTAssertTrue(NutritionLabelService.scoreSession === NutritionLabelService.scoreSession)
        XCTAssertTrue(NutritionLabelService.catalogueSession === NutritionLabelService.catalogueSession)
        for (session, timeout) in [(NutritionLabelService.analysisSession, 60.0),
                                   (NutritionLabelService.scoreSession, 45.0),
                                   (NutritionLabelService.catalogueSession, 7.0)] {
            let configuration = session.configuration
            XCTAssertNil(configuration.urlCache)
            XCTAssertNil(configuration.httpCookieStorage)
            XCTAssertNil(configuration.urlCredentialStorage)
            XCTAssertFalse(configuration.httpShouldSetCookies)
            XCTAssertEqual(configuration.requestCachePolicy, .reloadIgnoringLocalCacheData)
            XCTAssertEqual(configuration.timeoutIntervalForResource, timeout)
            XCTAssertNil(configuration.httpAdditionalHeaders?["Authorization"])
        }
    }

    func testAnalysisLatencyDiagnosticsRemainBoundedAndExcludePayloads() {
        let metadata = AnalysisDiagnostics.safeMetadata([
            "authorizationMs": 12, "responseHeadersMs": 1400, "downloadMs": 21,
            "transcriptionMs": 2300, "observationMs": 8000, "recheckMs": 0,
            "voiceText": "private food description", "photoBytes": "private image"])
        XCTAssertEqual(metadata.count, 6)
        XCTAssertEqual(metadata["observationMs"] as? Int, 8000)
        XCTAssertEqual(metadata["recheckMs"] as? Int, 0)
        XCTAssertTrue(AnalysisDiagnostics.safeMetadata(["observationMs": -1, "downloadMs": 600_001, "transcriptionMs": true]).isEmpty)
        XCTAssertFalse(String(describing: metadata).contains("private"))
    }

    func testRatingBatchDiagnosticsKeepOnlyBoundedTimingAndOutcomeMetadata() throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: folder) }
        let diagnostics = AnalysisDiagnostics(directory: folder)
        let fields: [String: Any] = ["route": "product_score", "ratingPath": "batch", "queueWaitMs": 4100,
            "lookupMs": 123, "calculationMs": 4, "batchSize": 20, "resolvedCount": 17, "missingCount": 3,
            "queueDepth": 40, "activeCount": 1, "waitReason": "read_budget", "cancelReason": "query_changed",
            "name": "private-food", "query": "private-search", "barcode": "private-barcode"]
        for outcome in ["queued", "started", "completed", "failed", "deferred", "cancelled", "cache_hit"] {
            diagnostics.record(stage: "rating_batch", outcome: outcome, metadata: fields)
        }
        let data = try diagnostics.exportData()
        XCTAssertFalse(String(decoding: data, as: UTF8.self).contains("private-"))
        let document = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let events = try XCTUnwrap(document["events"] as? [[String: Any]])
        XCTAssertEqual(events.count, 7)
        for event in events {
            XCTAssertEqual(event["stage"] as? String, "rating_batch")
            let metadata = try XCTUnwrap(event["metadata"] as? [String: Any])
            XCTAssertEqual(metadata.count, 12)
            XCTAssertEqual(metadata["queueWaitMs"] as? Int, 4100)
            XCTAssertEqual(metadata["ratingPath"] as? String, "batch")
        }
        XCTAssertTrue(AnalysisDiagnostics.safeMetadata([
            "queueWaitMs": -1, "lookupMs": 600001, "calculationMs": true, "batchSize": 101,
            "resolvedCount": "20", "missingCount": -1, "queueDepth": 401, "activeCount": 21,
            "ratingPath": "private-food", "waitReason": "private-search", "cancelReason": "private-text"
        ]).isEmpty)
        XCTAssertFalse(diagnostics.recordWebEvent(["action": "app-diagnostic", "stage": "rating_batch",
            "outcome": "completed", "metadata": fields]), "Web events cannot impersonate native rating retrieval")
    }

    func testCatalogueDiagnosticsDistinguishAnOutageGateFromANetworkRequest() {
        let gate = AnalysisDiagnostics.safeMetadata(["sourceRoute":"facts_batch", "gateReason":"route_outage", "requestSent":false, "barcode":"private product"])
        XCTAssertEqual(gate["sourceRoute"] as? String, "facts_batch")
        XCTAssertEqual(gate["gateReason"] as? String, "route_outage")
        XCTAssertEqual(gate["requestSent"] as? Bool, false)
        XCTAssertNil(gate["barcode"])
        let catalogue = AnalysisDiagnostics.safeMetadata(["sourceRoute":"catalogue_search", "requestSent":true, "ratingPath":"catalogue", "searchProvider":"nudge_catalogue"])
        XCTAssertEqual(catalogue.count, 4)
        XCTAssertTrue(AnalysisDiagnostics.safeMetadata(["sourceRoute":"private query", "gateReason":"private food", "requestSent":1]).isEmpty)
    }

    func testBarcodeDiagnosticsRetainRouteAndRatingOutcomeWithoutProductIdentity() throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: folder) }
        let diagnostics = AnalysisDiagnostics(directory: folder)
        diagnostics.record(stage: "barcode_lookup", outcome: "cache_hit", metadata: ["route":"product_lookup", "sourceRoute":"phone_cache", "requestSent":false, "elapsedMs":2, "barcode":"private barcode"])
        diagnostics.record(stage: "barcode_scan", outcome: "delivered", metadata: ["route":"product_lookup", "ratingAssigned":true, "hasCatalogueRating":false, "name":"private product"])
        let data = try diagnostics.exportData()
        XCTAssertFalse(String(decoding:data, as:UTF8.self).contains("private"))
        let document = try XCTUnwrap(JSONSerialization.jsonObject(with:data) as? [String:Any])
        let events = try XCTUnwrap(document["events"] as? [[String:Any]])
        XCTAssertEqual(events.count, 2)
        let lookup = try XCTUnwrap(events[0]["metadata"] as? [String:Any])
        XCTAssertEqual(lookup["sourceRoute"] as? String, "phone_cache")
        let scan = try XCTUnwrap(events[1]["metadata"] as? [String:Any])
        XCTAssertEqual(scan["ratingAssigned"] as? Bool, true)
        XCTAssertEqual(scan["hasCatalogueRating"] as? Bool, false)
        XCTAssertTrue(AnalysisDiagnostics.safeMetadata(["ratingAssigned":1, "hasCatalogueRating":"yes", "sourceRoute":"private"]).isEmpty)
    }

    func testNutritionDiagnosticsDistinguishUnknownFromExplicitZeroWithoutAmountsOrNames() {
        let extraction: [String:Any] = ["type":"meal", "meal":["name":"private-food", "nutrients":[
            "protein":["value":0,"status":"supplied"], "fat":12.5, "fibre":NSNull(), "carbohydrate":true,
            "salt":["value":0,"status":"unknown"]],
            "components":[["name":"private-ingredient","amountGrams":20,"sourceRecord":["id":"private-source"]], ["name":"private-ingredient-2","amountGrams":NSNull()]],
            "plants":["private-plant"]]]
        let metadata = NutritionLabelService.nutritionDiagnosticMetadata(extraction)
        XCTAssertEqual(metadata["knownNutrientCount"] as? Int,2)
        XCTAssertEqual(metadata["zeroNutrientCount"] as? Int,1)
        XCTAssertEqual(metadata["missingNutrientCount"] as? Int,6)
        XCTAssertEqual(metadata["componentCount"] as? Int,2)
        XCTAssertEqual(metadata["matchedComponentCount"] as? Int,1)
        XCTAssertEqual(metadata["missingAmountCount"] as? Int,1)
        XCTAssertEqual(metadata["plantCount"] as? Int,1)
        XCTAssertFalse(String(describing:metadata).contains("private"))
        XCTAssertEqual(NutritionLabelService.nutritionDiagnosticMetadata(["type":"meal"])["knownNutrientCount"] as? Int,0)
    }

    func testRecipeDiagnosticsDescribeMissingBasisWithoutPrivateRecipeContent() {
        let extraction: [String:Any] = ["type":"meal", "meal":["recipeCalculation":[
            "status":"needs_servings", "text":"private recipe", "batchComponents":[
                ["name":"private ingredient", "amountGrams":100], ["name":"private milk", "amountGrams":NSNull()]]],
            "nutrients":["protein":["value":NSNull(),"knownSubtotal":8,"knownContributions":1,"unknownContributions":1]]]]
        let metadata = AnalysisDiagnostics.safeMetadata(NutritionLabelService.nutritionDiagnosticMetadata(extraction))
        XCTAssertEqual(metadata["recipeStatus"] as? String,"needs_servings")
        XCTAssertEqual(metadata["recipeIngredientCount"] as? Int,2)
        XCTAssertEqual(metadata["recipeMissingAmountCount"] as? Int,1)
        XCTAssertEqual(metadata["partialNutrientCount"] as? Int,1)
        XCTAssertFalse(String(describing:metadata).contains("private"))
        XCTAssertNil(AnalysisDiagnostics.safeMetadata(["recipeStatus":"private recipe"])["recipeStatus"])
    }

    func testRecipeSchemaDiagnosticsKeepOnlyBoundedFieldPathsAndReasonCodes() throws {
        let keys = ["recipeValidationIssue", "recipeRecheckValidationIssue"]
        for key in keys {
            for codePoint in [0, 11, 12, 31] {
                let raw: [String: Any] = ["path":"$.recipeEvidence.text", "reason":"control_character", "codePoint":codePoint, "value":"private recipe"]
                let safe = try XCTUnwrap(AnalysisDiagnostics.safeMetadata([key:raw])[key] as? [String:Any])
                XCTAssertEqual(safe["codePoint"] as? Int,codePoint)
                XCTAssertEqual(safe.count,3)
            }
            for codePoint: Any in [-1, 32, 0.5, true, "31", Double.infinity] {
                let safe = try XCTUnwrap(AnalysisDiagnostics.safeMetadata([key:["path":"$", "reason":"control_character", "codePoint":codePoint]])[key] as? [String:Any])
                XCTAssertNil(safe["codePoint"])
                XCTAssertEqual(safe["reason"] as? String,"control_character")
            }
            let unrelated = try XCTUnwrap(AnalysisDiagnostics.safeMetadata([key:["path":"$", "reason":"type", "codePoint":31]])[key] as? [String:Any])
            XCTAssertNil(unrelated["codePoint"])
            for path in ["$", "$.recipeEvidence", "$.recipeEvidence.text", "$.recipeEvidence.ingredients", "$.recipeEvidence.ingredients[39].amount", "$.ingredients[0].evidence", "$.recipeEvidence.componentIndexes[39]", "$.components[39].photoIndex", "$.components[0].assumptions[3]"] {
                let issue: [String: Any] = ["path":path, "reason":"max_length", "value":"private recipe", "private ingredient":"private amount"]
                let safe = AnalysisDiagnostics.safeMetadata([key:issue])
                XCTAssertEqual(safe[key] as? [String:String], ["path":path, "reason":"max_length"])
                XCTAssertFalse(String(describing:safe).contains("private"))
            }
            for path in ["$.recipeEvidence.ingredients[40].name", "$.components[-1].name", "$.components[00].name", "$.components[0].assumptions[4]", "$.components[0].privateFood", "$.recipeEvidence.ingredients[0].value", "$.recipeEvidence.text.private", "$.recipeEvidence.text\n", "private recipe"] {
                XCTAssertNil(AnalysisDiagnostics.safeMetadata([key:["path":path, "reason":"type"]])[key], path)
            }
            for issue: Any in ["private text", ["path":"$", "reason":"private text"], ["path":true, "reason":"type"], ["path":"$", "reason":true]] {
                XCTAssertNil(AnalysisDiagnostics.safeMetadata([key:issue])[key])
            }
        }
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at:folder) }
        let store = AnalysisDiagnostics(directory:folder)
        store.record(stage:"http_response", outcome:"received", metadata:[
            "recipeValidationIssue":["path":"$.recipeEvidence.ingredients[2].evidence", "reason":"max_length", "value":"private recipe"],
            "recipeRecheckValidationIssue":["path":"$.components[0].privateFood", "reason":"type"]])
        let report = try store.exportData()
        let document = try XCTUnwrap(JSONSerialization.jsonObject(with:report) as? [String:Any])
        let events = try XCTUnwrap(document["events"] as? [[String:Any]])
        let metadata = try XCTUnwrap(events.first?["metadata"] as? [String:Any])
        XCTAssertEqual(metadata["recipeValidationIssue"] as? [String:String], ["path":"$.recipeEvidence.ingredients[2].evidence", "reason":"max_length"])
        XCTAssertNil(metadata["recipeRecheckValidationIssue"])
        XCTAssertFalse(String(decoding:report,as:UTF8.self).contains("private"))
    }
}

final class AnalysisDiagnosticsTests: XCTestCase {
    func testBackgroundDiagnosticsAcceptInteractionsWhileWriterIsBusyAndExportLatestBoundedEvents() throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: folder) }
        let queue = DispatchQueue(label: "diagnostics-test-paused-writer")
        queue.suspend()
        var resumed = false
        defer { if !resumed { queue.resume() } }
        let store = AnalysisDiagnostics(directory: folder, deferredWrites: true, writerQueue: queue)
        let accepted = expectation(description: "Interactions finish while the disk writer is unavailable")
        let now = Date()
        DispatchQueue.global().async {
            for index in 0...AnalysisDiagnostics.maximumEvents {
                store.record(stage: "navigation", outcome: "opened", metadata: [
                    "screen":"history", "captureRevision":index, "food":"private meal", "image":"private photo"], now: now)
            }
            accepted.fulfill()
        }
        wait(for: [accepted], timeout: 3)
        XCTAssertFalse(FileManager.default.fileExists(atPath: folder.appendingPathComponent("events.json").path))
        queue.resume(); resumed = true
        let data = try store.exportData(now: now)
        let document = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String:Any])
        let events = try XCTUnwrap(document["events"] as? [[String:Any]])
        XCTAssertEqual(events.count, AnalysisDiagnostics.maximumEvents)
        let revisions = events.compactMap { ($0["metadata"] as? [String:Any])?["captureRevision"] as? Int }
        XCTAssertEqual(revisions, Array(1...AnalysisDiagnostics.maximumEvents))
        XCTAssertFalse(String(decoding: data, as: UTF8.self).contains("private"))
        XCTAssertLessThanOrEqual(data.count, AnalysisDiagnostics.maximumBytes)
        XCTAssertEqual(try AnalysisDiagnostics(directory: folder).exportData(now: now), data)
    }

    func testSearchDiagnosticsDistinguishSourceAndFilterFailuresWithoutQueryContent() throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: folder) }
        let store = AnalysisDiagnostics(directory: folder)
        let metadata: [String: Any] = ["requestHash": AnalysisDiagnostics.fingerprint("search-request"),
            "httpStatus":503, "page":1, "queryLength":7, "queryTokenCount":1, "resultCount":20,
            "recipeCount":4, "productCount":20, "visibleCount":0, "filteredCount":20,
            "requirementsExcludedCount":4, "filterCount":2, "retryAfterSeconds":30,
            "cached":true, "stale":true, "spellingCorrected":false, "aliasMatched":true,
            "alternativeQuery":false, "savedOnly":false, "searchScope":"all", "searchProvider":"open_food_facts_search", "cacheState":"stale", "fallbackCode":"providerBusy",
            "query":"private food query", "support":"private health stage", "profile":"private profile", "barcode":"private barcode"]
        for (stage,outcome) in [("search_request","invoked"),("search_http","received"),("search_response","stale"),("search_delivery","delivered"),("search_ui","filtered_empty")] {
            store.record(stage:stage, outcome:outcome, metadata:metadata)
        }
        let data = try Data(contentsOf: folder.appendingPathComponent("events.json"))
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with:data) as? [String:Any])
        let events = try XCTUnwrap(object["events"] as? [[String:Any]])
        XCTAssertEqual(events.count,5)
        let safe = try XCTUnwrap(events.last?["metadata"] as? [String:Any])
        XCTAssertEqual(safe["recipeCount"] as? Int,4)
        XCTAssertEqual(safe["searchProvider"] as? String,"open_food_facts_search")
        XCTAssertEqual(safe["httpStatus"] as? Int,503)
        XCTAssertEqual(safe["retryAfterSeconds"] as? Int,30)
        XCTAssertEqual(safe["requirementsExcludedCount"] as? Int,4)
        XCTAssertEqual(safe["aliasMatched"] as? Bool,true)
        XCTAssertEqual(safe["stale"] as? Bool,true)
        XCTAssertFalse(String(decoding:data,as:UTF8.self).contains("private"))
        XCTAssertTrue(AnalysisDiagnostics.safeMetadata(["recipeCount":true,"page":21,"retryAfterSeconds":3601,"visibleCount":-1,"spellingCorrected":1,"searchScope":"private","searchProvider":"private","fallbackCode":"private"]).isEmpty)
    }

    func testDetailedMealValidationCodesSurviveWithoutFreeText() throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: folder) }
        let store = AnalysisDiagnostics(directory: folder)
        let codes = ["evidence_id_missing", "evidence_id_duplicate", "evidence_text_missing",
            "meal_shape", "meal_identity", "meal_portion_mode", "meal_subject", "meal_portion_selection",
            "meal_ingredients_shape", "meal_ingredient_text", "meal_plants_shape", "meal_plant_text",
            "meal_portion", "meal_nutrients", "meal_components", "meal_unused_product_shape"]
        for code in codes {
            store.record(stage: "http_response", outcome: "received", metadata: [
                "validationIssue": code, "message": "private-food-value",
                "normalizationIssues": ["meal_plant_evidence", "meal_unused_product_fields", "private-food-value"]])
        }
        let data = try Data(contentsOf: folder.appendingPathComponent("events.json"))
        let document = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let events = try XCTUnwrap(document["events"] as? [[String: Any]])
        XCTAssertEqual(events.compactMap { ($0["metadata"] as? [String: Any])?["validationIssue"] as? String }, codes)
        for event in events {
            let metadata = try XCTUnwrap(event["metadata"] as? [String: Any])
            XCTAssertEqual(metadata["normalizationIssues"] as? [String], ["meal_plant_evidence", "meal_unused_product_fields"])
        }
        XCTAssertFalse(String(decoding: data, as: UTF8.self).contains("private-food-value"))
        XCTAssertTrue(AnalysisDiagnostics.safeMetadata(["validationIssue": "meal_private-food-value"]).isEmpty)
    }

    func testAutomaticScoreRecheckDiagnosticsRemainBoundedAndPrivate() throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: folder) }
        let input: [String: Any] = ["automaticRecheck": true, "upstreamCallCount": 2,
            "recheckReason": "composition_unmatched", "recheckOutcome": "recovered",
            "recipeRecheckDetail": "evidence_or_mapping_invalid",
            "scoreReadiness": "available", "subjectStatus": "identified",
            "normalizationIssues": ["subject_uncertain", "subject_unidentified", "subject_type_mismatch"],
            "foodName": "private-food", "scoreInputs": "private-nutrients"]
        AnalysisDiagnostics(directory: folder).record(stage: "http_response", outcome: "received", metadata: input)
        let data = try Data(contentsOf: folder.appendingPathComponent("events.json"))
        let document = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let events = try XCTUnwrap(document["events"] as? [[String: Any]])
        let metadata = try XCTUnwrap(events.first?["metadata"] as? [String: Any])
        XCTAssertEqual(metadata["automaticRecheck"] as? Bool, true)
        XCTAssertEqual(metadata["upstreamCallCount"] as? Int, 2)
        XCTAssertEqual(metadata["recheckReason"] as? String, "composition_unmatched")
        XCTAssertEqual(metadata["recheckOutcome"] as? String, "recovered")
        XCTAssertEqual(metadata["recipeRecheckDetail"] as? String, "evidence_or_mapping_invalid")
        XCTAssertEqual(metadata["scoreReadiness"] as? String, "available")
        XCTAssertEqual(metadata["subjectStatus"] as? String, "identified")
        XCTAssertFalse(String(decoding: data, as: UTF8.self).contains("private-"))
        for bad in [3, -1, 1.5, true, "2"] as [Any] {
            XCTAssertNil(AnalysisDiagnostics.safeMetadata(["upstreamCallCount": bad])["upstreamCallCount"])
        }
        XCTAssertTrue(AnalysisDiagnostics.safeMetadata(["automaticRecheck": 1,
            "recheckReason": "private-food", "recheckOutcome": "private-food",
            "recipeRecheckDetail": "private-food",
            "scoreReadiness": "private-food", "subjectStatus": "private-food"]).isEmpty)
    }

    func testCatalogueFailuresAreRetainedAsKnownCodes() throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at:folder) }
        let errors: [BarcodeLookupError] = [.invalidBarcode, .notFound, .incompleteProduct, .offline, .timeout, .rateLimited, .server(503), .invalidResponse]
        let store = AnalysisDiagnostics(directory:folder)
        for error in errors { store.record(stage:"catalogue", outcome:error.code) }
        let data = try Data(contentsOf:folder.appendingPathComponent("events.json"))
        let document = try XCTUnwrap(JSONSerialization.jsonObject(with:data) as? [String:Any])
        let events = try XCTUnwrap(document["events"] as? [[String:Any]])
        XCTAssertEqual(events.compactMap { $0["outcome"] as? String },errors.map(\.code))
    }

    func testDiagnosticWhitelistNeverPersistsFoodImagesOrCredentials() throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at:folder) }
        let store = AnalysisDiagnostics(directory:folder)
        let attempt = UUID().uuidString
        let trace: [String:Any] = ["attemptId":attempt, "requestId":UUID().uuidString,
            "providerRequestId":"req_example", "httpStatus":502, "model":"gpt-4.1-mini",
            "outcome":"upstream_invalid_response", "validationIssue":"metadata_shape",
            "normalizationIssues":["allergen_evidence", "secret food description"],
            "Authorization":"Bearer secret-token", "imageBase64":"private-photo",
            "ingredients":"private-food", "message":"private-text", "email":"private@example.test",
            "endpoint":"https://private.example/token", "responseBytes":true]
        store.record(stage:"http_response", outcome:"received", metadata:trace)
        let data = try Data(contentsOf:folder.appendingPathComponent("events.json"))
        let text = try XCTUnwrap(String(data:data,encoding:.utf8))
        for forbidden in ["secret-token", "private-photo", "private-food", "private-text", "private@example", "private.example", "secret food"] { XCTAssertFalse(text.contains(forbidden)) }
        let document = try XCTUnwrap(JSONSerialization.jsonObject(with:data) as? [String:Any])
        let events = try XCTUnwrap(document["events"] as? [[String:Any]])
        let metadata = try XCTUnwrap(events.first?["metadata"] as? [String:Any])
        XCTAssertEqual(metadata["attemptId"] as? String, attempt)
        XCTAssertEqual(metadata["httpStatus"] as? Int, 502)
        XCTAssertEqual(metadata["normalizationIssues"] as? [String], ["allergen_evidence"])
        XCTAssertNil(metadata["responseBytes"])
        XCTAssertEqual(try folder.resourceValues(forKeys:[.isExcludedFromBackupKey]).isExcludedFromBackup, true)
    }

    func testDiagnosticsPersistAcrossInstancesAndPruneOldEvents() throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at:folder) }
        let now = Date()
        AnalysisDiagnostics(directory:folder).record(stage:"app", outcome:"started", now:now.addingTimeInterval(-AnalysisDiagnostics.retention - 1))
        let store = AnalysisDiagnostics(directory:folder)
        for index in 0...AnalysisDiagnostics.maximumEvents {
            store.record(stage:"http_response", outcome:"received", metadata:["httpStatus":200, "captureRevision":index], now:now)
        }
        let data = try Data(contentsOf:folder.appendingPathComponent("events.json"))
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with:data) as? [String:Any])
        let events = try XCTUnwrap(object["events"] as? [[String:Any]])
        XCTAssertEqual(events.count, AnalysisDiagnostics.maximumEvents)
        XCTAssertTrue(events.allSatisfy { $0["stage"] as? String == "http_response" })
        XCTAssertLessThanOrEqual(data.count, AnalysisDiagnostics.maximumBytes)
        let count = events.count
        store.record(stage:"private food text", outcome:"received", now:now)
        XCTAssertEqual(try Data(contentsOf:folder.appendingPathComponent("events.json")), data)
        XCTAssertEqual(count,200)
    }
    func testVoiceAndRoughScoreDiagnosticsNeverRetainContent() throws {
        let metadata: [String: Any] = ["voiceStatus":"transcribed", "scoreBasis":"food_pattern", "scoreReadiness":"estimated_rough", "transcriptionCallCount":1,
            "validationIssue":"meal_quality_estimate", "voiceMemo":["audioBase64":"private-audio"],
            "transcript":"private meal description", "text":"private words", "durationSeconds":19.2]
        let safe = AnalysisDiagnostics.safeMetadata(metadata)
        XCTAssertEqual(safe["voiceStatus"] as? String, "transcribed")
        XCTAssertEqual(safe["scoreBasis"] as? String, "food_pattern")
        XCTAssertEqual(safe["scoreReadiness"] as? String, "estimated_rough")
        XCTAssertEqual(safe["transcriptionCallCount"] as? Int, 1)
        XCTAssertEqual(safe["validationIssue"] as? String, "meal_quality_estimate")
        XCTAssertEqual(safe.count, 5)
        for invalid in [-1, 2, 1.5] {
            XCTAssertNil(AnalysisDiagnostics.safeMetadata(["transcriptionCallCount":invalid])["transcriptionCallCount"])
        }
        XCTAssertTrue(AnalysisDiagnostics.safeMetadata(["voiceStatus":"private words", "scoreBasis":"private words", "transcriptionCallCount":true]).isEmpty)
    }

}

@MainActor
final class UKProductSearchServiceTests: XCTestCase {
    func testUKMarketAndStoreAreServerSideAndInEveryPageCacheKey() throws {
        let uk = try ProductSearchQuery(literalText: "milk")
        XCTAssertEqual(uk.parameters["q"] as? String, #"milk AND countries_tags:"en:united-kingdom""#)
        let global = try ProductSearchQuery(literalText: "milk", market: .allCountries)
        XCTAssertEqual(global.parameters["q"] as? String, "milk")
        let tesco = try ProductSearchQuery(literalText: "milk", store: .tesco)
        let next = try ProductSearchQuery(literalText: "milk", page: 2, store: .tesco)
        XCTAssertEqual(tesco.parameters["q"] as? String, #"milk AND countries_tags:"en:united-kingdom" AND (stores:"Tesco" OR stores:"tesco")"#)
        XCTAssertEqual(tesco.parameters["q"] as? String, next.parameters["q"] as? String)
        XCTAssertEqual(Set([uk.key, global.key, tesco.key, next.key]).count, 4)
        XCTAssertThrowsError(try ProductSearchQuery(literalText: "milk", market: .allCountries, store: .tesco))
        let chocolate = try XCTUnwrap(ProductSearchCategory.all.first { $0.id == "chocolate" })
        let category = try ProductSearchQuery(category: chocolate, store: .sainsburys)
        let expression = try XCTUnwrap(category.parameters["q"] as? String)
        XCTAssertEqual(chocolate.tags, ["en:chocolates", "en:candies", "en:confectioneries", "en:sweets"])
        XCTAssertEqual(expression, #"((categories_tags:"en:chocolates" OR categories_tags:"en:candies" OR categories_tags:"en:confectioneries" OR categories_tags:"en:sweets")) AND countries_tags:"en:united-kingdom" AND (stores:"Sainsbury's" OR stores:"Sainsburys" OR stores:"Sainsbury" OR stores:"sainsbury's" OR stores:"sainsburys" OR stores:"sainsbury")"#)
        let fields = try XCTUnwrap(category.parameters["fields"] as? [String])
        XCTAssertTrue(fields.contains("countries_tags"))
        XCTAssertTrue(fields.contains("stores"))
        XCTAssertFalse(expression.contains("stores_tags:"))
        let literal = try ProductSearchQuery(literalText: "milk OR stores:asda", store: .tesco)
        XCTAssertTrue((literal.parameters["q"] as? String ?? "").contains(#"milk AND "OR" AND stores\:asda"#))
        let bakedBeans = try ProductSearchQuery(literalText: "baked beans", store: .sainsburys)
        XCTAssertTrue((bakedBeans.parameters["q"] as? String ?? "").hasPrefix(#"baked AND beans AND countries_tags:"en:united-kingdom" AND (stores:"Sainsbury's" OR "#))
        XCTAssertTrue(bakedBeans.key.contains("discovery:v3:"), "Invalidate earlier empty pages produced by the provider query bug")
    }

    func testScopeValidationRequiresRecordedCountryAndStoreNotBrand() throws {
        let scoped = try ProductSearchQuery(literalText: "milk", store: .tesco)
        var product = try fullProduct(code: "1001", modified: 200)
        product.countriesTags = ["en:united-kingdom"]
        product.stores = [" Tesco "]
        XCTAssertTrue(scoped.matchesScope(product))
        product.stores = ["Asda"]
        XCTAssertFalse(scoped.matchesScope(product))
        product.stores = []
        XCTAssertFalse(scoped.matchesScope(product))
        product.stores = ["Tesco"]
        product.countriesTags = ["en:france"]
        XCTAssertFalse(scoped.matchesScope(product))
        XCTAssertTrue(try ProductSearchQuery(literalText: "milk", market: .allCountries).matchesScope(product))
        XCTAssertTrue(ProductSearchStore.sainsburys.contains(sourceStore: "sainsbury-s"))
        XCTAssertTrue(ProductSearchStore.marksAndSpencer.contains(sourceStore: "Marks & Spencer"))
        XCTAssertTrue(ProductSearchStore.coOp.contains(sourceStore: "the co-operative"))
        XCTAssertFalse(ProductSearchStore.tesco.contains(sourceStore: "Tesco competitor"))
        let unknownScope = Data(#"{"hits":[{"code":"1001","product_name":"Milk","stores":["Tesco"]}],"page":1}"#.utf8)
        XCTAssertThrowsError(try ProductSearchPage.parse(unknownScope, query: scoped, retrievedAt: Date()))
        let correctScope = Data(#"{"hits":[{"code":"1001","product_name":"Milk","countries_tags":["en:united-kingdom"],"stores":["Tesco"]},{"code":"1002","product_name":"Other milk","countries_tags":["en:france"],"stores":["Tesco"]}],"page":1}"#.utf8)
        let parsed = try ProductSearchPage.parse(correctScope, query: scoped, retrievedAt: Date())
        XCTAssertEqual(parsed.products.map(\.barcode), ["1001"])
    }

    func testMarketAndStoreCachesCannotSatisfyAnotherScope() async throws {
        let state = ProductSearchState()
        let now = Date()
        let query = try ProductSearchQuery(literalText: "milk", store: .tesco)
        await state.save(ProductSearchPage(query: query, products: [try fullProduct(code: "1001", modified: 200)], hasMore: false), at: now)
        let hit = await state.cached(query, at: now)
        XCTAssertNotNil(hit)
        for other in [try ProductSearchQuery(literalText: "milk"), try ProductSearchQuery(literalText: "milk", market: .allCountries), try ProductSearchQuery(literalText: "milk", store: .asda)] {
            let missed = await state.cached(other, at: now)
            XCTAssertNil(missed)
        }
    }

    func testSearchRatingUsesFreshExactCacheWithoutCatalogueOrNetwork() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let cache = ProductLookupCache(directory: directory)
        let now = Date(timeIntervalSince1970: 1000)
        let product = try fullProduct(code: "1001", modified: 200)
        cache.write(product, now: now)
        var service = OpenFoodFactsService(now: { now }, cache: cache)
        service.catalogueLookup = { _ in XCTFail("Current exact cache should satisfy lookup"); throw BarcodeLookupError.offline }
        var snapshot = product
        snapshot.searchProvider = "open_food_facts_search"
        let result = try await service.lookupForSearchRating(snapshot: snapshot)
        XCTAssertEqual(result.lastModifiedAt, product.lastModifiedAt)
        XCTAssertNil(result.searchProvider)
    }

    func testStaleCacheAndCatalogueAreBypassedForExactCurrentRecord() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let cache = ProductLookupCache(directory: directory)
        let now = Date(timeIntervalSince1970: 1000)
        cache.write(try fullProduct(code: "1001", modified: 100), now: now)
        let session = lookupSession()
        defer { session.invalidateAndCancel() }
        var service = OpenFoodFactsService(productReadState: ProductReadState(), session: session, now: { now }, cache: cache)
        service.catalogueLookup = { code in
            (Data("{\"product\":{\"code\":\"\(code)\",\"product_name\":\"Older catalogue\",\"last_modified_t\":100}}".utf8), now)
        }
        var snapshot = try fullProduct(code: "1001", modified: 200)
        snapshot.searchProvider = "open_food_facts_search"
        let result = try await service.lookupForSearchRating(snapshot: snapshot)
        XCTAssertEqual(result.name, "Fresh exact product")
        XCTAssertEqual(result.lastModifiedAt, snapshot.lastModifiedAt)
        XCTAssertEqual(cache.read(barcode: "1001", now: now)?.name, "Fresh exact product")
    }

    func testUndatedOrOlderDirectFactsCannotBeRatedAsCurrentSearchProduct() async throws {
        let session = lookupSession()
        defer { session.invalidateAndCancel() }
        var service = OpenFoodFactsService(productReadState: ProductReadState(), session: session, cache: nil)
        service.catalogueLookup = { _ in throw BarcodeLookupError.offline }
        for code in ["1002", "1003", "1004"] {
            var snapshot = try fullProduct(code: code, modified: 200)
            snapshot.searchProvider = "open_food_facts_search"
            do {
                _ = try await service.lookupForSearchRating(snapshot: snapshot)
                XCTFail("Older, undated or mismatched record should not be used")
            } catch { XCTAssertTrue(error is BarcodeLookupError) }
        }
    }

    func testCancellingInflightRatingLookupPreservesCancellationAndDoesNotCache() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let cache = ProductLookupCache(directory: directory)
        let requestID = UUID().uuidString
        let started = expectation(forNotification: Notification.Name("UKSearchRatingLookupStarted"), object: nil) {
            $0.userInfo?["requestID"] as? String == requestID
        }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [UKSearchRatingURLProtocol.self]
        configuration.httpAdditionalHeaders = ["X-Nudge-Test-RequestID": requestID]
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel() }
        var service = OpenFoodFactsService(productReadState: ProductReadState(), session: session, cache: cache)
        service.catalogueLookup = { _ in throw BarcodeLookupError.offline }
        var snapshot = try fullProduct(code: "1005", modified: 200)
        snapshot.searchProvider = "open_food_facts_search"
        let request = Task { try await service.lookupForSearchRating(snapshot: snapshot) }
        await fulfillment(of: [started], timeout: 2)
        request.cancel()
        do {
            _ = try await request.value
            XCTFail("A cancelled visible-card request must not return a product")
        } catch { XCTAssertTrue(error is CancellationError) }
        XCTAssertNil(cache.read(barcode: "1005", now: Date()))
        XCTAssertFalse(FileManager.default.fileExists(atPath: directory.appendingPathComponent("1005.json").path))
    }

    private func fullProduct(code: String, modified: Int) throws -> BarcodeProduct {
        try OpenFoodFactsParser.parse(data: Data("{\"product\":{\"code\":\"\(code)\",\"product_name\":\"Test product\",\"last_modified_t\":\(modified),\"nutriments\":{\"proteins_100g\":4}}}".utf8), barcode: code, retrievedAt: Date(timeIntervalSince1970: 1000))
    }
    private func lookupSession() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [UKSearchRatingURLProtocol.self]
        return URLSession(configuration: configuration)
    }
}

private final class UKSearchRatingURLProtocol: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let url = request.url!
        let code = url.deletingPathExtension().lastPathComponent
        let valid = url.host == "world.openfoodfacts.org" && url.path.hasPrefix("/api/v3.6/product/")
            && request.value(forHTTPHeaderField: "User-Agent")?.hasPrefix("Nudge/") == true
        let response = HTTPURLResponse(url: url, statusCode: valid ? 200 : 400, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        if code == "1005" {
            // Keep the response in flight until URLSession receives task cancellation.
            NotificationCenter.default.post(name: Notification.Name("UKSearchRatingLookupStarted"), object: nil,
                userInfo: ["requestID": request.value(forHTTPHeaderField: "X-Nudge-Test-RequestID") ?? ""])
            return
        }
        let modified = code == "1003" ? "" : ",\"last_modified_t\":\(code == "1002" ? 100 : 200)"
        let returnedCode = code == "1004" ? "1009" : code
        let body = "{\"product\":{\"code\":\"\(returnedCode)\",\"product_name\":\"Fresh exact product\"\(modified)}}"
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() { }
}
