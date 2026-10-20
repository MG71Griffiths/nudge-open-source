import Foundation

@main struct CloudImagePreparationChecks {
    @MainActor static func main() async throws {
        let root = URL(fileURLWithPath: CommandLine.arguments[1]).appendingPathComponent("captures")
        let owner = String(repeating: "a", count: 64), other = String(repeating: "b", count: 64)
        var checks: [String] = []
        func expect(_ name: String, _ value: Bool) { precondition(value, name); checks.append(name) }
        func manifest(_ record: NativeCaptureRecord, at directory: URL = root) -> URL {
            directory.appendingPathComponent(record.ownerKey).appendingPathComponent("PreparedCloud-v1")
                .appendingPathComponent(record.id.uuidString.lowercased()).appendingPathComponent("manifest.json")
        }
        func preparationFiles(_ record: NativeCaptureRecord, at directory: URL = root) -> [URL] {
            (try? FileManager.default.contentsOfDirectory(at: manifest(record, at: directory).deletingLastPathComponent(), includingPropertiesForKeys: nil)) ?? []
        }
        let store = NativeCaptureOutbox(directory: root)
        let full = Data(repeating: 17, count: 20_000), crop = Data(repeating: 29, count: 8_000)
        var record = NativeCaptureRecord(eventID: "synthetic-cloud-input", ownerKey: owner)
        record.photoIDs = ["one", "two"]; record.status = .processing; record.captureRevision = 2; record.cloudPreparationVersion = 1
        record = try store.save(record, images: [full, full])
        expect("no snapshot before first dispatch", try await store.preparedCloudImages(for: record) == nil)
        expect("first freeze selects supplied image bytes in original order", try await store.freezeCloudImages(for: record, images: [crop, full]) == [crop, full])
        expect("saved original photos remain byte exact", try store.images(for: record) == [full, full])
        expect("only changed photo is copied", preparationFiles(record).filter { $0.pathExtension == "jpg" }.count == 1)
        let snapshotBytes = try Data(contentsOf: manifest(record))
        let marked = try store.record(eventID: record.eventID, owner: owner)!
        expect("wire-input marker is durable before freeze returns", marked.cloudPreparedSubmissionID == record.submissionID)
        _ = try store.save(record)
        expect("stale same-submission status save cannot clear marker", try store.record(eventID: record.eventID, owner: owner)?.cloudPreparedSubmissionID == record.submissionID)
        expect("retry cannot replace frozen bytes with later OCR outcome", try await store.freezeCloudImages(for: record, images: [full, full]) == [crop, full])
        expect("retry does not rewrite atomic snapshot", try Data(contentsOf: manifest(record)) == snapshotBytes)
        let reopened = NativeCaptureOutbox(directory: root)
        expect("restart loads identical prepared bytes", try await reopened.preparedCloudImages(for: record) == [crop, full])
        let legacy = try JSONDecoder().decode(NativeCaptureRecord.self, from: JSONEncoder().encode(NativeCaptureRecord(eventID: "legacy", ownerKey: owner)))
        expect("old manifests do not opt into cropping", legacy.cloudPreparationVersion == nil)
        var otherRecord = NativeCaptureRecord(eventID: record.eventID, ownerKey: other)
        otherRecord.photoIDs = ["one"]; otherRecord = try store.save(otherRecord, images: [full])
        expect("other owner cannot read first owner snapshot", try await store.preparedCloudImages(for: otherRecord) == nil)
        let blob = preparationFiles(record).first { $0.pathExtension == "jpg" }!
        try Data(repeating: 30, count: crop.count).write(to: blob, options: .atomic)
        do { _ = try await reopened.preparedCloudImages(for: record); preconditionFailure("tampered prepared bytes accepted") }
        catch NativeCaptureOutbox.Failure.missingOriginal { checks.append("changed prepared bytes fail closed") }
        try crop.write(to: blob, options: .atomic)
        let originalURL = root.appendingPathComponent(owner).appendingPathComponent(record.photoFiles[0])
        try Data(repeating: 18, count: full.count).write(to: originalURL, options: .atomic)
        do { _ = try await reopened.preparedCloudImages(for: record); preconditionFailure("tampered source bytes accepted") }
        catch NativeCaptureOutbox.Failure.missingOriginal { checks.append("original byte digest is verified even when a crop exists") }
        try full.write(to: originalURL, options: .atomic)
        try FileManager.default.removeItem(at: blob)
        do { _ = try await reopened.preparedCloudImages(for: record); preconditionFailure("missing prepared bytes fell back") }
        catch NativeCaptureOutbox.Failure.missingOriginal { checks.append("missing prepared file cannot fall back to different wire bytes") }
        try crop.write(to: blob, options: .atomic)
        try Data("bad".utf8).write(to: manifest(record), options: .atomic)
        do { _ = try await reopened.freezeCloudImages(for: record, images: [full, full]); preconditionFailure("invalid manifest replaced") }
        catch { checks.append("invalid preparation manifest blocks dispatch") }
        try snapshotBytes.write(to: manifest(record), options: .atomic)
        try FileManager.default.removeItem(at: manifest(record))
        do { _ = try await reopened.freezeCloudImages(for: record, images: [full, full]); preconditionFailure("missing manifest changed wire input") }
        catch NativeCaptureOutbox.Failure.missingOriginal { checks.append("missing marked sidecar cannot change wire bytes") }
        try snapshotBytes.write(to: manifest(record), options: .atomic)
        var wrongSubmission = try JSONSerialization.jsonObject(with: snapshotBytes) as! [String: Any]
        wrongSubmission["submissionID"] = UUID().uuidString
        try JSONSerialization.data(withJSONObject: wrongSubmission).write(to: manifest(record), options: .atomic)
        do { _ = try await reopened.preparedCloudImages(for: record); preconditionFailure("mismatched marked sidecar accepted") }
        catch NativeCaptureOutbox.Failure.invalidRecord { checks.append("marked sidecar cannot refer to another submission") }
        try snapshotBytes.write(to: manifest(record), options: .atomic)
        // Simulate interruption after sidecar write but before the durable marker.
        let recordFile = root.appendingPathComponent(owner).appendingPathComponent(record.id.uuidString.lowercased() + ".json")
        var unmarked = try JSONSerialization.jsonObject(with: Data(contentsOf: recordFile)) as! [String: Any]
        unmarked.removeValue(forKey: "cloudPreparedSubmissionID")
        try JSONSerialization.data(withJSONObject: unmarked).write(to: recordFile, options: .atomic)
        expect("unmarked committed sidecar recovers identical bytes", try await reopened.preparedCloudImages(for: record) == [crop, full])
        expect("recovered sidecar is marked before cloud bytes return", try store.record(eventID: record.eventID, owner: owner)?.cloudPreparedSubmissionID == record.submissionID)
        var undoCopy = marked
        undoCopy.id = UUID(); undoCopy.submissionID = UUID(); undoCopy.eventID = "synthetic-undo-copy"
        undoCopy = try store.save(undoCopy, images: [full, full])
        expect("Undo copy clears old capture preparation marker", undoCopy.cloudPreparedSubmissionID == nil)
        expect("Undo copy retains photos without inherited snapshot", try store.images(for: undoCopy) == [full, full] && preparationFiles(undoCopy).isEmpty)
        let old = record
        record.submissionID = UUID(); record = try store.save(record)
        expect("new submission purges previous preparation", preparationFiles(record).isEmpty)
        expect("new submission clears required marker", record.cloudPreparedSubmissionID == nil)
        expect("new submission has no inherited wire snapshot", try await store.preparedCloudImages(for: record) == nil)
        do { _ = try await store.freezeCloudImages(for: old, images: [crop, full]); preconditionFailure("stale submission prepared") }
        catch NativeCaptureOutbox.Failure.invalidRecord { checks.append("stale submission cannot create prepared data") }
        _ = try await store.freezeCloudImages(for: record, images: [full, full])
        expect("unchanged input references originals without JPEG copies", preparationFiles(record).filter { $0.pathExtension == "jpg" }.isEmpty)
        record.status = .deleted; record = try store.save(record)
        expect("capture deletion purges prepared data", preparationFiles(record).isEmpty)
        do { _ = try await store.freezeCloudImages(for: record, images: [full, full]); preconditionFailure("deleted capture recreated") }
        catch NativeCaptureOutbox.Failure.invalidRecord { checks.append("deleted capture cannot recreate preparation") }
        expect("deletion marker keeps originals available for Undo", try store.images(for: record) == [full, full])
        record.status = .queued; record.submissionID = UUID(); record = try store.save(record)
        _ = try await store.freezeCloudImages(for: record, images: [crop, full])
        record.captureRevision += 1; record.photoIDs = ["replacement"]; record = try store.save(record, images: [full])
        expect("replacement photos purge prior preparation", preparationFiles(record).isEmpty)
        _ = try await store.freezeCloudImages(for: record, images: [crop])
        try store.remove(record)
        expect("record removal purges prepared files", preparationFiles(record).isEmpty)
        expect("record removal leaves other owner photo intact", try store.images(for: otherRecord) == [full])
        // Writes are blocked before sidecar commit if the capture/owner disappears
        // during off-actor reads, hashing and file writes. Larger synthetic buffers
        // ensure the main actor gets its deletion turn before worker completion.
        for mode in ["delete", "owner", "revision", "cancel"] {
            let directory = root.appendingPathComponent("race-" + mode), outbox = NativeCaptureOutbox(directory: directory)
            var input = NativeCaptureRecord(eventID: "race-" + mode, ownerKey: owner)
            input.photoIDs = ["a", "b", "c", "d"]; input.status = .processing
            let images = Array(repeating: Data(repeating: 51, count: 1_400_000), count: 4)
            input = try outbox.save(input, images: images)
            let original = input
            let pending = Task { @MainActor in try await outbox.freezeCloudImages(for: original, images: Array(repeating: Data(repeating: 52, count: 1_000_000), count: 4)) }
            await Task.yield()
            switch mode {
            case "delete": input.status = .deleted; _ = try outbox.save(input)
            case "owner": try outbox.removeOwner(owner)
            case "revision": input.captureRevision += 1; _ = try outbox.save(input)
            default: pending.cancel()
            }
            do { _ = try await pending.value; preconditionFailure("late preparation completed after " + mode) }
            catch { checks.append(mode + " during preparation prevents delivery") }
            expect(mode + " during preparation leaves no committed snapshot", !FileManager.default.fileExists(atPath: manifest(original, at: directory).path))
            if mode == "owner" { expect("deleted owner directory is not recreated", !FileManager.default.fileExists(atPath: directory.appendingPathComponent(owner).path)) }
        }
        let smallRoot = root.appendingPathComponent("quota")
        let generous = NativeCaptureOutbox(directory: smallRoot)
        var small = NativeCaptureRecord(eventID: "quota", ownerKey: owner); small.photoIDs = ["q"]
        small = try generous.save(small, images: [full])
        let limited = NativeCaptureOutbox(directory: smallRoot, maximumBytes: 30_000)
        do { _ = try await limited.freezeCloudImages(for: small, images: [crop]); preconditionFailure("quota bypassed") }
        catch NativeCaptureOutbox.Failure.storageFull { checks.append("prepared bytes count against outbox byte budget") }
        expect("storage failure leaves originals intact and no dispatch snapshot", try generous.images(for: small) == [full] && !FileManager.default.fileExists(atPath: manifest(small, at: smallRoot).path))
        let receipt: [String: Any] = ["passed": true, "checkCount": checks.count, "checks": checks, "limits": ["Synthetic buffers only; no real photos, credentials, network or device operations.", "Exact production outbox implementation compiled; iOS recording value type extracted unchanged."]]
        try JSONSerialization.data(withJSONObject: receipt, options: [.prettyPrinted, .sortedKeys]).write(to: root.deletingLastPathComponent().appendingPathComponent("receipt.json"))
        print("Immutable cloud image checks passed: \(checks.count)")
    }
}
