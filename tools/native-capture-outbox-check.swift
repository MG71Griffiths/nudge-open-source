import Foundation
@main struct CaptureStorageHarness {
 @MainActor static func main() async throws {
  let directory=URL(fileURLWithPath:CommandLine.arguments[1]).appendingPathComponent("captures")
  defer { try? FileManager.default.removeItem(at:directory) }
  let owner=String(repeating:"a",count:64), other=String(repeating:"b",count:64)
  let store=NativeCaptureOutbox(directory:directory)
  var record=NativeCaptureRecord(eventID:"capture-storage-test",ownerKey:owner)
  // Old manifests decode without silently opting anybody into eaten.
  let legacy=try JSONDecoder().decode(NativeCaptureRecord.self,from:JSONEncoder().encode(record))
  precondition(legacy.addToEaten == nil && legacy.diaryAddState == nil && legacy.chatGPTBinding == nil)
  record.addToEaten=true;record.diaryAddState="pending"
  record.photoIDs=[UUID().uuidString];record.status = .queued
  record.mealHints=NativeMealAnalysisHints(ingredients:["Kefir","Blueberries"],portion:.init(amount:500,unit:"ml"))
  record.loggingDay="2026-10-09";record.loggingMeal="Dinner";record.historyGeneration=3
  record.photoReferences=["nudge-photo:"+UUID().uuidString+".jpg"]
  let photo=Data([255,216,1,2,3,255,217])
  let voice=VoiceMemoPayload(audioData:Data([0,0,0,12]+Array("ftypM4A ".utf8)),durationSeconds:2)!
  // Voice-only writes use the same media budget as photos. Check the exact
  // boundary and error type so unrelated filesystem failures cannot pass.
  func expectStorageFull(_ operation: () throws -> Void) throws {
   do { try operation(); preconditionFailure("media write exceeded its quota") }
   catch NativeCaptureOutbox.Failure.storageFull { }
  }
  let voiceRecord=NativeCaptureRecord(eventID:"voice-only",ownerKey:owner)
  let tinyDirectory=directory.appendingPathComponent("voice-tiny")
  let tiny=NativeCaptureOutbox(directory:tinyDirectory,maximumBytes:1)
  try expectStorageFull { try tiny.save(voiceRecord,images:[],voiceMemo:voice) }
  let tinyRecords=try tiny.records(owner:owner);precondition(tinyRecords.isEmpty)
  precondition(!FileManager.default.fileExists(atPath:tinyDirectory.path))
  let voiceBoundary=1_000_000+voice.audioData.count
  let shortVoice=NativeCaptureOutbox(directory:directory.appendingPathComponent("voice-short"),maximumBytes:voiceBoundary-1)
  try expectStorageFull { try shortVoice.save(voiceRecord,images:[],voiceMemo:voice) }
  let exactVoiceDirectory=directory.appendingPathComponent("voice-exact")
  let exactVoice=NativeCaptureOutbox(directory:exactVoiceDirectory,maximumBytes:voiceBoundary)
  let savedVoice=try exactVoice.save(voiceRecord,images:[],voiceMemo:voice)
  let voiceReopened=NativeCaptureOutbox(directory:exactVoiceDirectory,maximumBytes:voiceBoundary)
  let persistedVoice=try voiceReopened.voiceMemo(for:savedVoice);precondition(persistedVoice?.audioData == voice.audioData)
  let originalVoiceManifest=exactVoiceDirectory.appendingPathComponent(owner).appendingPathComponent(savedVoice.id.uuidString.lowercased()+".json")
  let originalVoiceBytes=try Data(contentsOf:originalVoiceManifest)
  var revisedVoice=savedVoice;revisedVoice.status = .queued
  try expectStorageFull { try exactVoice.save(revisedVoice,images:[],voiceMemo:voice) }
  let retainedVoiceBytes=try Data(contentsOf:originalVoiceManifest);precondition(retainedVoiceBytes == originalVoiceBytes)
  let retainedVoiceMemo=try voiceReopened.voiceMemo(for:savedVoice);precondition(retainedVoiceMemo?.audioData == voice.audioData)
  // A status-only update does not create replacement media or reserve it again.
  let metadataOnly=try exactVoice.save(revisedVoice)
  precondition(metadataOnly.voiceFile == savedVoice.voiceFile && metadataOnly.status == .queued)
  let combinedBoundary=1_000_000+photo.count+voice.audioData.count
  let shortCombined=NativeCaptureOutbox(directory:directory.appendingPathComponent("combined-short"),maximumBytes:combinedBoundary-1)
  try expectStorageFull { try shortCombined.save(record,images:[photo],voiceMemo:voice) }
  let exactCombined=NativeCaptureOutbox(directory:directory.appendingPathComponent("combined-exact"),maximumBytes:combinedBoundary)
  let savedCombined=try exactCombined.save(record,images:[photo],voiceMemo:voice)
  let combinedInput=try await exactCombined.analysisInput(for:savedCombined)
  precondition(combinedInput.images == [photo] && combinedInput.voiceMemo?.audioData == voice.audioData)
  let blockedDirectory=directory.appendingPathComponent("blocked-directory")
  let sentinel=Data("existing file".utf8)
  try sentinel.write(to:blockedDirectory)
  let blockedStore=NativeCaptureOutbox(directory:blockedDirectory)
  do { try blockedStore.save(voiceRecord,images:[],voiceMemo:voice);preconditionFailure("filesystem failure was ignored") }
  catch is NativeCaptureOutbox.Failure { preconditionFailure("filesystem failure was changed to an outbox quota error") }
  catch { precondition((error as NSError).domain == NSCocoaErrorDomain) }
  let retainedSentinel=try Data(contentsOf:blockedDirectory);precondition(retainedSentinel == sentinel)
  record=try store.save(record,images:[photo],voiceMemo:voice)
  let reopened=NativeCaptureOutbox(directory:directory)
  guard let restored=try reopened.records(owner:owner).first else { fatalError("record lost") }
  precondition(restored.id == record.id && restored.submissionID == record.submissionID)
  precondition(restored.loggingDay == record.loggingDay && restored.loggingMeal == record.loggingMeal)
  precondition(restored.photoReferences == record.photoReferences && restored.historyGeneration == 3)
  precondition(restored.mealHints == record.mealHints)
  precondition(restored.addToEaten == true && restored.diaryAddState == "pending")
  let backgroundInput=try await reopened.analysisInput(for:restored)
  precondition(backgroundInput.images == [photo] && backgroundInput.voiceMemo?.audioData == voice.audioData)
  // An already-read cache must see another instance's atomic manifest update.
  var externallyChanged=record;externallyChanged.status = .processing
  try store.save(externallyChanged)
  let observed=try reopened.record(eventID:record.eventID,owner:owner)
  precondition(observed?.status == .processing)
  record=externallyChanged
  let verifiedImages = try reopened.images(for:restored); precondition(verifiedImages == [photo])
  let restoredVoice=try reopened.voiceMemo(for:restored);precondition(restoredVoice?.audioData == voice.audioData && restoredVoice?.durationSeconds == 2)
  let otherRecords = try reopened.records(owner:other); precondition(otherRecords.isEmpty)
  var changed=record;changed.repairContext=Data(repeating:1,count:1_100_000)
  var rejected=false;do { try store.save(changed,images:[Data([255,216,8,255,217])]) } catch { rejected=true }
  precondition(rejected)
  let retainedImages = try reopened.images(for:restored); precondition(retainedImages == [photo])
  let originalRecords = try reopened.records(owner:owner); precondition(originalRecords.first?.repairContext == nil)
  let start=Date(timeIntervalSince1970:100)
  precondition(NativeCaptureOutbox.retryDate(at:start,attempt:2,retryAfter:7200,jitter:1) == start.addingTimeInterval(7200))
  try reopened.remove(restored)
  let deletedRecords = try reopened.records(owner:owner); precondition(deletedRecords.isEmpty)
  var guest=NativeCaptureRecord(eventID:"guest-adopt",ownerKey:"local-guest")
  guest.photoIDs=[UUID().uuidString];guest.loggingDay="2026-10-09";guest.loggingMeal="Lunch";guest.historyGeneration=2
  let binding = ChatGPTCaptureBinding(profileID:"synthetic-client",subject:"synthetic-subject",connectionID:UUID(),modelID:"synthetic-model")
  guest.chatGPTBinding=binding
  guest.mealHints=record.mealHints;guest.addToEaten=true;guest.diaryAddState="pending"
  guest.photoReferences=["nudge-photo:"+UUID().uuidString+".jpg"];guest=try store.save(guest,images:[photo])
  let claimed=try store.adoptGuest(guest,owner:owner)
  let claimedImages=try store.images(for:claimed);precondition(claimedImages == [photo])
  let boundReopened=try NativeCaptureOutbox(directory:directory).record(eventID:claimed.eventID,owner:owner)
  precondition(boundReopened?.chatGPTBinding == binding)
  let boundBytes=try JSONEncoder().encode(claimed)
  precondition(!String(decoding:boundBytes,as:UTF8.self).contains("accessToken"))
  for mode in ["remote","barcode","voice","invalid"] {
   var bad=claimed
   if mode == "remote" { bad.remoteAccepted=true }
   if mode == "barcode" { bad.barcode="12345678" }
   if mode == "voice" { bad.voiceFile=UUID().uuidString.lowercased()+".m4a" }
   if mode == "invalid" { bad.chatGPTBinding=ChatGPTCaptureBinding(profileID:"",subject:"s",connectionID:UUID(),modelID:"m") }
   do { try store.save(bad);preconditionFailure("invalid ChatGPT route accepted") }
   catch NativeCaptureOutbox.Failure.invalidRecord {}
  }
  do { try store.save(claimed,images:[photo],voiceMemo:voice);preconditionFailure("direct voice accepted") }
  catch NativeCaptureOutbox.Failure.invalidRecord {}
  let boundUnchanged=try store.record(eventID:claimed.eventID,owner:owner)
  precondition(boundUnchanged?.chatGPTBinding == binding)

  precondition(claimed.loggingDay == guest.loggingDay && claimed.loggingMeal == guest.loggingMeal && claimed.photoReferences == guest.photoReferences && claimed.historyGeneration == 2)
  precondition(claimed.mealHints == guest.mealHints && claimed.chatGPTBinding == binding)
  precondition(claimed.addToEaten == true && claimed.diaryAddState == "pending")
  precondition(claimed.id == guest.id && claimed.createdAt == guest.createdAt && claimed.submissionID != guest.submissionID)
  let guestRecords=try store.records(owner:"local-guest");precondition(guestRecords.isEmpty)
  var transferRejected=false;do { _ = try store.adoptGuest(claimed,owner:other) } catch { transferRejected=true };precondition(transferRejected)
  // A failed adoption must leave the guest's original available for retry.
  let bounded=NativeCaptureOutbox(directory:directory.appendingPathComponent("bounded"),maximumBytes:1_001_500)
  var retained=NativeCaptureRecord(eventID:"failed-adoption",ownerKey:"local-guest");retained.photoIDs=[UUID().uuidString]
  let largerPhoto=Data(repeating:7,count:1_000);retained=try bounded.save(retained,images:[largerPhoto])
  var adoptionRejected=false;do { _ = try bounded.adoptGuest(retained,owner:owner) } catch { adoptionRejected=true };precondition(adoptionRejected)
  let retainedGuest=try bounded.record(eventID:retained.eventID,owner:"local-guest");precondition(retainedGuest?.id == retained.id)
  let retainedPhoto=try bounded.images(for:retained);precondition(retainedPhoto == [largerPhoto])
  // Account deletion removes exactly one owner's originals and fences callbacks.
  var untouched=NativeCaptureRecord(eventID:"other-owner",ownerKey:other);untouched.photoIDs=[UUID().uuidString]
  untouched=try store.save(untouched,images:[photo])
  try store.removeOwner(owner)
  let ownerRecords=try store.records(owner:owner);precondition(ownerRecords.isEmpty)
  let untouchedPhoto=try store.images(for:untouched);precondition(untouchedPhoto == [photo])
  var resurrectionRejected=false;do { try store.save(claimed,images:[photo]) } catch { resurrectionRejected=true };precondition(resurrectionRejected)
  let reopenedDeleted=try NativeCaptureOutbox(directory:directory).records(owner:owner);precondition(reopenedDeleted.isEmpty)
  for hints in [NativeMealAnalysisHints(ingredients:[]),NativeMealAnalysisHints(ingredients:["Milk","Milk"]),NativeMealAnalysisHints(ingredients:[" Milk"]),NativeMealAnalysisHints(ingredients:["Milk\n"]),NativeMealAnalysisHints(ingredients:["Milk"],portion:.init(amount:Double.infinity,unit:"ml")),NativeMealAnalysisHints(ingredients:["Milk"],portion:.init(amount:500,unit:"pints"))] {
   var invalid=untouched;invalid.mealHints=hints
   var rejected=false;do { try store.save(invalid) } catch { rejected=true };precondition(rejected)
  }
  let unaffected=try store.record(eventID:untouched.eventID,owner:other);precondition(unaffected?.mealHints == nil)
  print("PASS: voice-only and combined-media quota boundaries; rejected replacement preserves originals; filesystem errors remain distinct; background input matches immutable originals; manifest cache observes external atomic updates; meal hints survive restart/adoption and reject malformed values; failed adoption retains input; account deletion is scoped and rejects resurrection; guest adoption preserves originals and History identity; cross-account transfers rejected; originals, voice note, and idempotency identity survive reopen; account partitions; failed manifest retains originals; Retry-After; deletion")
 }
}
