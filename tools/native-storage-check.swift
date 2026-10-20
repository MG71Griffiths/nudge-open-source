import Foundation

@main
struct NativeStorageCheck {
    static var checks = 0
    static func expect(_ result: Bool, _ message: String) { checks += 1; precondition(result, message) }
    static func decoded(_ value: String) throws -> [String: Any] { try JSONSerialization.jsonObject(with: Data(value.utf8)) as! [String: Any] }
    static func request(_ store: NudgeDataStore, _ operation: String, _ key: String, _ value: String? = nil) throws -> [String: Any] {
        var body: [String: Any] = ["operation":operation,"key":key]
        if let value { body["value"] = value }
        return try decoded(store.handle(String(data: JSONSerialization.data(withJSONObject: body), encoding: .utf8)!))
    }
    static func main() throws {
        let root = URL(fileURLWithPath: CommandLine.arguments[1])
        let key = "nudge-scan-history-v1", store = NudgeDataStore(directory: root)
        let file = root.appendingPathComponent(key + ".json")
        let original = "{\"version\":3,\"events\":[],\"unicode\":\"🍓 é \\\"\\n\"}"
        expect(try decoded(store.setValue(original, for: key))["ok"] as? Bool == true, "Direct write must acknowledge durable bytes")
        let firstBytes = try Data(contentsOf: file)
        for _ in 0..<3 { expect(try request(store, "get", key)["value"] as? String == original, "Warm reads preserve exact Unicode/escapes") }
        expect(try Data(contentsOf: file) == firstBytes, "Reads must not rewrite files")
        for invalid in ["[]", "broken", "{\"bad\":NaN}"] {
            expect(try decoded(store.setValue(invalid, for: key))["ok"] as? Bool == false, "Invalid direct input is rejected")
            expect(try Data(contentsOf: file) == firstBytes, "Invalid input cannot change the prior record")
        }
        expect(try decoded(store.setValue("{}", for: "../outside"))["ok"] as? Bool == false, "Invalid keys are rejected")
        let second = NudgeDataStore(directory: root)
        let replacement = original.replacingOccurrences(of: "version\":3", with: "version\":4")
        let oldDate = try FileManager.default.attributesOfItem(atPath: file.path)[.modificationDate] as! Date
        expect(try decoded(second.setValue(replacement, for: key))["ok"] as? Bool == true, "Second writer commits")
        try FileManager.default.setAttributes([.modificationDate:oldDate],ofItemAtPath:file.path)
        expect(try request(store, "get", key)["value"] as? String == replacement, "Equal-size atomic replacement with restored mtime invalidates cache")
        var broken = try Data(contentsOf: file); broken[0] = 0x21
        let priorDate = try FileManager.default.attributesOfItem(atPath: file.path)[.modificationDate] as! Date
        try broken.write(to:file)
        try FileManager.default.setAttributes([.modificationDate:priorDate],ofItemAtPath:file.path)
        expect(try request(store, "get", key)["error"] as? String == "corrupt_store", "ctime detects equal-size in-place corruption even when mtime is restored")
        expect(try decoded(store.setValue("{}", for:key))["ok"] as? Bool == false, "Warm direct write cannot overwrite corrupt evidence")
        expect(try request(store,"set",key,"{}")["ok"] as? Bool == false, "Envelope write cannot overwrite corrupt evidence")
        expect(try Data(contentsOf:file) == broken, "Corrupt bytes stay untouched")
        try FileManager.default.removeItem(at:file)
        expect(try request(store,"get",key)["exists"] as? Bool == false, "Removed files invalidate cache")
        expect(try decoded(store.setValue(original,for:key))["ok"] as? Bool == true, "Explicit new writes after removal work")
        expect(try request(store,"remove",key)["ok"] as? Bool == true, "Reset tombstone commits")
        let imported=try request(second,"import",key,original)
        expect(imported["exists"] as? Bool == true && imported["value"] is NSNull, "Tombstone cannot resurrect older records")
        for (i, otherKey) in NudgeDataStore.keys.sorted().enumerated() {
            let large="{\"index\":\(i),\"payload\":\"" + String(repeating:"x",count:3_000_000) + "\"}"
            expect(try decoded(store.setValue(large,for:otherKey))["ok"] as? Bool == true,"Bounded cache does not limit valid storage")
        }
        for (i, otherKey) in NudgeDataStore.keys.sorted().enumerated() {
            let text=try request(store,"get",otherKey)["value"] as! String
            expect(try decoded(text)["index"] as? Int == i,"Evicted values are reread without loss")
        }
        let blocked=root.appendingPathComponent("blocked")
        try Data("not a folder".utf8).write(to:blocked)
        expect(try decoded(NudgeDataStore(directory:blocked).setValue("{}",for:key))["ok"] as? Bool == false,"Failed writes cannot acknowledge success")
        let photo=Data([0xff,0xd8,1,2,0xff,0xd9]), refs=try store.savePhotos([photo])
        expect(NudgeDataStore(directory:root).photoData(for:refs[0]) == photo,"Original media remains unchanged")
        print("Native private storage: \(checks) checks passed (direct/envelope parity, durable acknowledgement, external replacement/corruption, tombstones, cache eviction, write failures and photos).")
    }
}
