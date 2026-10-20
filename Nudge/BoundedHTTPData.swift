import Foundation

/// Accumulates URLSession's data chunks instead of awaiting every response byte.
/// The bound applies while downloading, including chunked responses without a
/// Content-Length. Each operation owns cancellation; the session can be reused.
final class BoundedHTTPData: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    enum Failure: Error { case invalidResponse, bodyTooLarge }
    private let maximumBytes: Int
    private let onResponse: ((HTTPURLResponse) -> Void)?
    private let lock = NSLock()
    private var continuation: CheckedContinuation<(Data, HTTPURLResponse), Error>?
    private var task: URLSessionDataTask?
    private var response: HTTPURLResponse?
    private var data = Data()
    private var finished = false

    private init(maximumBytes: Int, onResponse: ((HTTPURLResponse) -> Void)?) {
        self.maximumBytes = maximumBytes
        self.onResponse = onResponse
    }

    static func load(_ request: URLRequest, session: URLSession, maximumBytes: Int,
                     onResponse: ((HTTPURLResponse) -> Void)? = nil) async throws -> (Data, HTTPURLResponse) {
        let receiver = BoundedHTTPData(maximumBytes: maximumBytes, onResponse: onResponse)
        return try await withTaskCancellationHandler {
            try Task.checkCancellation()
            return try await withCheckedThrowingContinuation { receiver.start(request, session: session, continuation: $0) }
        } onCancel: { receiver.cancel() }
    }

    private func start(_ request: URLRequest, session: URLSession,
                       continuation: CheckedContinuation<(Data, HTTPURLResponse), Error>) {
        lock.lock()
        guard !finished else { lock.unlock(); continuation.resume(throwing: CancellationError()); return }
        self.continuation = continuation
        let task = session.dataTask(with: request)
        task.delegate = self
        self.task = task
        task.resume()
        lock.unlock()
    }

    private func cancel() { finish(.failure(CancellationError()), cancelTask: true) }

    private func finish(_ result: Result<(Data, HTTPURLResponse), Error>, cancelTask: Bool = false) {
        lock.lock()
        guard !finished else { lock.unlock(); return }
        finished = true
        let continuation = self.continuation, task = self.task
        self.continuation = nil; self.task = nil; data = Data()
        lock.unlock()
        if cancelTask { task?.cancel() }
        continuation?.resume(with: result)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        guard let http = response as? HTTPURLResponse else {
            completionHandler(.cancel); finish(.failure(Failure.invalidResponse)); return
        }
        guard http.expectedContentLength <= maximumBytes else {
            completionHandler(.cancel); finish(.failure(Failure.bodyTooLarge)); return
        }
        lock.lock()
        let active = !finished
        if active { self.response = http }
        lock.unlock()
        if active { onResponse?(http) }
        completionHandler(active ? .allow : .cancel)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive chunk: Data) {
        lock.lock()
        guard !finished else { lock.unlock(); return }
        guard chunk.count <= maximumBytes - data.count else {
            lock.unlock(); finish(.failure(Failure.bodyTooLarge), cancelTask: true); return
        }
        data.append(chunk)
        lock.unlock()
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        lock.lock()
        let result: Result<(Data, HTTPURLResponse), Error>
        if let error { result = .failure(error) }
        else if let response { result = .success((data, response)) }
        else { result = .failure(Failure.invalidResponse) }
        lock.unlock()
        finish(result)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        // Fixed provider endpoints never need to forward credentials or queries.
        completionHandler(nil)
    }
}
