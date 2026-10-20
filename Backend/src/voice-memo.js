export const MAX_VOICE_BYTES = 512_000;
export const MAX_VOICE_BODY_BYTES = 8_685_000;
export const MAX_VOICE_SECONDS = 60;
export const MAX_TRANSCRIPT_CHARACTERS = 4000;
export const VOICE_MODEL = 'gpt-4o-mini-transcribe';
export const VOICE_TIMEOUT_MS = 15_000;
export const VOICE_TRANSCRIPTION_PROMPT = 'A spoken food or recipe note. Transcribe all spoken ingredient names and quantities, including small seeds, nuts, herbs and spices. Preserve corrections, negations, units and numbers. Do not summarise the ingredient list or add foods that were not spoken.';
export class VoiceError extends Error {
  constructor(message, status, code) { super(message); this.status = status; this.code = code; }
}

// Validate a bounded, canonical base64 M4A container before any paid request.
// OpenAI's decoder remains the authority for compressed audio validity.
export function validateVoiceMemo(value) {
  const invalid = () => new VoiceError('Record the voice note again, or remove it and analyse the photos.', 400, 'voice_invalid');
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'audioBase64,durationSeconds,mimeType'
    || value.mimeType !== 'audio/mp4' || typeof value.audioBase64 !== 'string'
    || typeof value.durationSeconds !== 'number' || !Number.isFinite(value.durationSeconds)
    || value.durationSeconds <= 0 || value.durationSeconds > MAX_VOICE_SECONDS) throw invalid();
  const encoded = value.audioBase64;
  if (encoded.length > Math.ceil(MAX_VOICE_BYTES / 3) * 4) throw new VoiceError('Voice notes must be at most 60 seconds and 512 KB.', 413, 'voice_too_large');
  if (!encoded.length || encoded.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw invalid();
  let binary; try { binary = atob(encoded); } catch { throw invalid(); }
  if (btoa(binary) !== encoded || binary.length < 40) throw invalid();
  if (binary.length > MAX_VOICE_BYTES) throw new VoiceError('Voice notes must be at most 60 seconds and 512 KB.', 413, 'voice_too_large');
  const bytes = Uint8Array.from(binary, c => c.charCodeAt(0)), view = new DataView(bytes.buffer);
  const boxes = (start, end) => {
    const result = []; let offset = start;
    while (offset < end) {
      if (offset + 8 > end) throw invalid();
      let size = view.getUint32(offset), header = 8;
      if (size === 1) {
        if (offset + 16 > end || view.getUint32(offset + 8) !== 0) throw invalid();
        size = view.getUint32(offset + 12); header = 16;
      } else if (size === 0) size = end - offset;
      if (size < header || offset + size > end) throw invalid();
      result.push({ type: binary.slice(offset + 4, offset + 8), start: offset + header, end: offset + size });
      offset += size;
    }
    return result;
  };
  const top = boxes(0, bytes.length), ftyp = top[0];
  if (ftyp?.type !== 'ftyp' || ftyp.end - ftyp.start < 8
    || !['M4A ', 'isom', 'mp42'].includes(binary.slice(ftyp.start, ftyp.start + 4))
    || !top.some(b => b.type === 'mdat' && b.end > b.start)) throw invalid();
  const moov = top.find(b => b.type === 'moov'); if (!moov) throw invalid();
  const mvhd = boxes(moov.start, moov.end).find(b => b.type === 'mvhd'); if (!mvhd) throw invalid();
  const version = bytes[mvhd.start], timeOffset = version === 0 ? 12 : version === 1 ? 20 : -1;
  if (timeOffset < 0 || mvhd.start + timeOffset + (version === 1 ? 12 : 8) > mvhd.end) throw invalid();
  const timescale = view.getUint32(mvhd.start + timeOffset);
  let duration = view.getUint32(mvhd.start + timeOffset + 4);
  if (version === 1) { if (duration !== 0) throw invalid(); duration = view.getUint32(mvhd.start + timeOffset + 8); }
  if (!timescale || !duration || duration / timescale > MAX_VOICE_SECONDS) throw invalid();
  return bytes;
}

export async function transcribeVoiceMemo(value, env, signal, readJSON, {onResponse=()=>{}} = {}) {
  const bytes = validateVoiceMemo(value), controller = new AbortController();
  const cancel = () => controller.abort(); signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(cancel, VOICE_TIMEOUT_MS);
  try {
    signal?.throwIfAborted();
    const form = new FormData();
    form.set('file', new Blob([bytes], { type: 'audio/mp4' }), 'nudge-voice.m4a');
    form.set('model', VOICE_MODEL); form.set('response_format', 'json');
    form.set('prompt', VOICE_TRANSCRIPTION_PROMPT);
    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST', signal: controller.signal, redirect: 'manual',
      headers: { authorization: `Bearer ${env.OPENAI_API_KEY}` }, body: form
    });
    onResponse(null,response);
    if (!response.ok) { void response.body?.cancel().catch(() => {}); throw new VoiceError('The voice note could not be transcribed. Retry, or remove it to analyse the photos.', 502, 'voice_transcription_failed'); }
    const payload = await readJSON(response, 16_384, controller.signal);
    onResponse(payload,response);
    controller.signal.throwIfAborted();
    if (typeof payload?.text !== 'string' || payload.text.length > MAX_TRANSCRIPT_CHARACTERS
      || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\p{Cf}\p{Cs}]/u.test(payload.text)) throw new VoiceError('The voice note could not be read. Record it again, or remove it.', 502, 'voice_transcription_failed');
    const text = payload.text.normalize('NFC').replace(/\s+/gu, ' ').trim();
    if (!text) throw new VoiceError('No speech was heard. Record the voice note again, or remove it.', 422, 'voice_transcription_empty');
    return { text, source: 'user_voice', model: VOICE_MODEL };
  } catch (error) {
    if (controller.signal.aborted) throw new VoiceError('Voice transcription timed out. Retry, or remove the note to analyse the photos.', 504, 'voice_transcription_timeout');
    if (error instanceof VoiceError) throw error;
    throw new VoiceError('The voice note could not be transcribed. Retry, or remove it to analyse the photos.', 502, 'voice_transcription_failed');
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
}
