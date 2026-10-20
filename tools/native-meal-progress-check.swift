import Foundation

@main
struct MealProgressChecks {
    static func main() {
        let cases: [(String, [String: Any]?, Bool, String)] = [
            ("preparing local queue", ["processingState":"queued", "status":"pending"], true, "Queued for analysis"),
            ("processing", ["processingState":"processing", "status":"pending"], true, "Analysing…"),
            ("remote accepted", ["processingState":"queued", "status":"pending", "message":"Analysing…"], true, "Analysing…"),
            ("delivered result", ["processingState":"processing", "status":"ready"], false, "Analysis finished"),
            ("complete", ["processingState":"complete", "status":"ready"], false, "Analysis finished"),
            ("network retry", ["processingState":"retryableFailure", "status":"failed", "errorCode":"analysis_connection"], false, "waiting to retry"),
            ("permission or unsupported upload", ["processingState":"needsUserInput", "status":"unknown"], false, "needs your attention"),
            ("removed", nil, false, "no longer in History"),
            ("unrecognised state", ["processingState":"future-state"], false, "check this analysis")
        ]
        for (name, event, busy, text) in cases {
            let progress = NativeMealRefinementProgress(event: event)
            precondition(progress.isAnalysing == busy, name + " activity state")
            precondition(progress.message.contains(text), name + " honest status")
        }
        let historyCases: [(String, [String: Any], Bool?, String?)] = [
            ("queued history row", ["status":"pending", "processingState":"queued"], false, "Queued for analysis"),
            ("processing history row", ["status":"pending", "processingState":"processing"], true, "Analysing…"),
            ("slow actual request", ["status":"pending", "processingState":"processing", "note":"Still analysing — your photos are saved."], true, "Analysing…"),
            ("old pending request is not timed complete", ["status":"pending", "processingState":"processing", "createdAt":"2020-01-01T00:00:00Z"], true, "Analysing…"),
            ("ready beats stale processing", ["status":"ready", "processingState":"processing"], nil, nil),
            ("failure beats stale processing", ["status":"failed", "processingState":"processing"], nil, nil),
            ("unknown beats stale queued", ["status":"unknown", "processingState":"queued"], nil, nil),
            ("completed job", ["status":"pending", "processingState":"complete"], nil, nil),
            ("needs input", ["status":"pending", "processingState":"needsUserInput"], nil, nil),
            ("retry waits for a new attempt", ["status":"pending", "processingState":"retryableFailure"], nil, nil),
            ("draft is not dispatched", ["status":"pending", "processingState":"draft"], nil, nil),
            ("deleted job", ["status":"pending", "processingState":"deleted"], nil, nil),
            ("legacy pending without durable state", ["status":"pending"], nil, nil),
            ("future stage", ["status":"pending", "processingState":"future"], nil, nil),
            ("missing row", [:], nil, nil)
        ]
        for (name, row, processing, title) in historyCases {
            let progress = NativeHistoryAnalysisProgress(row: row)
            precondition(progress?.isProcessing == processing, name + " activity state")
            precondition(progress?.title == title, name + " honest phase")
        }
        let processing: [String: Any] = ["status":"pending", "processingState":"processing"]
        for stage in [NativeAnalysisStage.saved, .analysing, .saving] {
            let progress = NativeHistoryAnalysisProgress(row: processing, stage: stage)!
            precondition(progress.fraction == Double(stage.rawValue) / 4, "actual milestone fill")
            precondition(progress.title == stage.title, "actual milestone caption")
            precondition(progress.stepLabel == "Step \(stage.rawValue) of 4", "accessible milestone")
            precondition(NativeHistoryAnalysisProgress(row: ["status":"ready", "processingState":"processing"], stage: stage) == nil, "result beats stale live milestone")
        }
        precondition(NativeHistoryAnalysisProgress(row: processing, stage: .complete)?.fraction == 0.75, "pending row cannot claim durable completion")
        precondition(NativeHistoryAnalysisProgress(row: processing)?.fraction == 0.25, "relaunch cannot guess completed preparation")
        precondition(NativeAnalysisStage.complete.fraction == 1, "only completed result fills bar")
        print("Native meal and History progress: \(cases.count + historyCases.count + 15) cases passed")
    }
}
