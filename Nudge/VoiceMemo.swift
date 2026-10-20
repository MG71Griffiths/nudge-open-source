import AVFoundation
import Foundation
import UIKit

/// Native-only request data. It is deliberately not Codable or a web event.
struct VoiceMemoPayload {
    static let maximumDuration: TimeInterval = 60
    static let maximumBytes = 512_000
    let audioData: Data
    let durationSeconds: TimeInterval

    init?(audioData: Data, durationSeconds: TimeInterval) {
        guard durationSeconds.isFinite, durationSeconds > 0, durationSeconds <= Self.maximumDuration,
              (12...Self.maximumBytes).contains(audioData.count),
              String(data: audioData.subdata(in: 4..<8), encoding: .ascii) == "ftyp" else { return nil }
        self.audioData = audioData
        self.durationSeconds = durationSeconds
    }
    var uploadObject: [String: Any] {
        ["mimeType": "audio/mp4", "audioBase64": audioData.base64EncodedString(), "durationSeconds": durationSeconds]
    }
}

/// Permission callbacks have a generation: releasing, closing or interrupting a
/// hold invalidates permission that arrives later. VoiceOver uses an explicit
/// start/stop activation, so it does not require maintaining a physical hold.
struct VoiceMemoInteraction {
    private(set) var pending: UUID?
    private(set) var recording = false
    var active: Bool { pending != nil || recording }
    mutating func begin() -> UUID? {
        guard !active else { return nil }
        let token = UUID(); pending = token; return token
    }
    mutating func permissionResolved(_ allowed: Bool, token: UUID) -> Bool {
        guard pending == token else { return false }
        pending = nil
        recording = allowed
        return allowed
    }
    @discardableResult mutating func end() -> Bool {
        let wasRecording = recording
        pending = nil; recording = false
        return wasRecording
    }
}

@MainActor
final class VoiceMemoDraft: NSObject, AVAudioRecorderDelegate, AVAudioPlayerDelegate {
    static let sharingNotice = "Optional voice note sent with photos to Nudge and OpenAI when you analyse."
    static let recordingSettings: [String: Any] = [
        AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 22_050,
        AVNumberOfChannelsKey: 1, AVEncoderBitRateKey: 32_000,
        AVEncoderAudioQualityKey: AVAudioQuality.medium.rawValue
    ]
    private static var cleanedAbandonedFiles = false
    private let directory: URL
    private(set) var fileURL: URL?
    private var recorder: AVAudioRecorder?
    private var player: AVAudioPlayer?
    private var timer: Timer?
    private var audioSessionActive = false
    private(set) var duration: TimeInterval = 0
    private(set) var elapsed: TimeInterval = 0
    var onChange: (() -> Void)?
    var onRecordingEnded: ((Bool) -> Void)?
    var recording: Bool { recorder != nil }
    var playing: Bool { player?.isPlaying == true }
    var hasMemo: Bool { fileURL != nil && recorder == nil && duration > 0 }
    var payload: VoiceMemoPayload? {
        guard hasMemo, let fileURL, let data = try? Data(contentsOf: fileURL, options: .uncached) else { return nil }
        return VoiceMemoPayload(audioData: data, durationSeconds: duration)
    }
    init(payload: VoiceMemoPayload? = nil, directory: URL? = nil) {
        self.directory = directory ?? FileManager.default.temporaryDirectory.appendingPathComponent("nudge-voice-memos", isDirectory: true)
        super.init()
        // Only this feature's abandoned temporary files; never app/user storage.
        if directory == nil && !Self.cleanedAbandonedFiles {
            Self.cleanedAbandonedFiles = true
            try? FileManager.default.removeItem(at: self.directory)
        }
        if let payload { try? restore(payload) }
    }
    private func makeFile() throws -> URL {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.protectionKey: FileProtectionType.complete])
        var url = directory.appendingPathComponent(UUID().uuidString + ".m4a")
        guard FileManager.default.createFile(atPath: url.path, contents: Data(), attributes: [.protectionKey: FileProtectionType.complete]) else { throw CocoaError(.fileWriteUnknown) }
        var values = URLResourceValues(); values.isExcludedFromBackup = true
        try url.setResourceValues(values)
        return url
    }
    private func restore(_ payload: VoiceMemoPayload) throws {
        let url = try makeFile()
        do { try payload.audioData.write(to: url, options: [.completeFileProtection]); fileURL = url; duration = payload.durationSeconds }
        catch { try? FileManager.default.removeItem(at: url); throw error }
    }
    func start() throws {
        guard recorder == nil else { return }
        remove()
        let url = try makeFile()
        fileURL = url
        do {
            let audio = AVAudioSession.sharedInstance()
            try audio.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker])
            CameraHapticAudioPolicy.prepare(audio)
            try audio.setActive(true)
            audioSessionActive = true
            let device = try AVAudioRecorder(url: url, settings: Self.recordingSettings)
            device.delegate = self
            guard device.prepareToRecord(), device.record(forDuration: VoiceMemoPayload.maximumDuration - 0.2) else { throw CocoaError(.fileWriteUnknown) }
            // Leave room for AAC frame padding while guaranteeing media stays within the duration limit.
            recorder = device; elapsed = 0
            timer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
                Task { @MainActor in
                    guard let self, let recorder = self.recorder else { return }
                    self.elapsed = min(VoiceMemoPayload.maximumDuration, recorder.currentTime)
                    if self.elapsed >= VoiceMemoPayload.maximumDuration - 0.2 { self.stopRecording() }
                    else { self.onChange?() }
                }
            }
            onChange?()
        } catch { remove(); throw error }
    }
    func stopRecording() {
        guard let device = recorder else { return }
        recorder = nil; timer?.invalidate(); timer = nil
        device.delegate = nil; device.stop()
        if let fileURL, let audio = try? AVAudioPlayer(contentsOf: fileURL),
           audio.duration >= 0.2, audio.duration <= VoiceMemoPayload.maximumDuration,
           let data = try? Data(contentsOf: fileURL, options: .uncached),
           VoiceMemoPayload(audioData: data, durationSeconds: audio.duration) != nil {
            duration = audio.duration; elapsed = duration
        } else { deleteFile() }
        deactivate()
        onChange?(); onRecordingEnded?(hasMemo)
    }
    func togglePlayback() throws {
        if playing { stopPlayback(); return }
        guard hasMemo, let fileURL else { return }
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playback, mode: .default)
        try session.setActive(true)
        audioSessionActive = true
        do {
            let audio = try AVAudioPlayer(contentsOf: fileURL)
            audio.delegate = self; player = audio
            guard audio.play() else { throw CocoaError(.fileReadUnknown) }
            onChange?()
        } catch { stopPlayback(); throw error }
    }
    func stopPlayback() { player?.stop(); player = nil; if recorder == nil { deactivate() }; onChange?() }
    func interrupt() { if recording { stopRecording() }; stopPlayback() }
    func remove() {
        recorder?.delegate = nil; recorder?.stop(); recorder = nil
        timer?.invalidate(); timer = nil
        player?.stop(); player = nil
        deleteFile(); deactivate(); onChange?()
    }
    private func deleteFile() {
        if let fileURL { try? FileManager.default.removeItem(at: fileURL) }
        fileURL = nil; duration = 0; elapsed = 0
    }
    private func deactivate() {
        guard audioSessionActive else { return }
        audioSessionActive = false
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
    nonisolated func audioRecorderDidFinishRecording(_ recorder: AVAudioRecorder, successfully flag: Bool) {
        Task { @MainActor [weak self] in
            guard let self, recorder === self.recorder else { return }
            if flag { self.stopRecording() } else { self.remove(); self.onRecordingEnded?(false) }
        }
    }
    nonisolated func audioRecorderEncodeErrorDidOccur(_ recorder: AVAudioRecorder, error: Error?) {
        Task { @MainActor [weak self] in
            guard let self, recorder === self.recorder else { return }
            self.remove(); self.onRecordingEnded?(false)
        }
    }
    nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        Task { @MainActor [weak self] in
            guard let self, player === self.player else { return }; self.stopPlayback()
        }
    }
    nonisolated func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: Error?) {
        Task { @MainActor [weak self] in
            guard let self, player === self.player else { return }; self.stopPlayback()
        }
    }
    deinit {
        timer?.invalidate(); recorder?.stop(); player?.stop()
        if let fileURL { try? FileManager.default.removeItem(at: fileURL) }
    }
}

@MainActor
final class VoiceHoldButton: UIButton {
    var accessibilityToggle: (() -> Void)?
    override func accessibilityActivate() -> Bool { accessibilityToggle?(); return true }
}
