const fs = require("fs");
const {
  MEETING_MIC_SILENCE_RMS,
  MEETING_MIC_SILENCE_PEAK,
  computeChunkStats,
} = require("./meetingMicGate");

/**
 * Pure input-selection policy for post-meeting diarization.
 *
 * A meeting session records two parallel raw PCM captures for its whole
 * length: the system-audio tap (calls) and the microphone (in-person and
 * speakerphone sessions). At stop, one of them feeds the diarizer and the
 * other is kept beside it, so re-detecting speakers can fall back to it.
 */

// 24 kHz mono s16le, the format both raw captures are written in.
const PCM_BYTES_PER_MS = 48;
const WINDOW_BYTES = PCM_BYTES_PER_MS * 100;

// A call's system audio carries the other side for minutes; a phone call on
// speakerphone only picks up notification chimes, a second or two (measured:
// 1.7 s in a 22 min call against 115 s+ for every real call).
const CALL_MIN_AUDIBLE_MS = 10_000;
const CALL_MIN_AUDIBLE_SHARE = 0.25;

function isCallAudio({ audibleMs = 0, durationMs = 0 } = {}) {
  return (
    audibleMs > 0 && audibleMs >= Math.min(CALL_MIN_AUDIBLE_MS, durationMs * CALL_MIN_AUDIBLE_SHARE)
  );
}

// Audible time in a raw capture, judged in 100 ms windows with the live gate's
// silence thresholds.
async function measurePcmAudio(pcmPath) {
  let audibleMs = 0;
  let bytes = 0;
  // A multiple of the window, so file reads never split one.
  const stream = fs.createReadStream(pcmPath, { highWaterMark: WINDOW_BYTES * 13 });
  for await (const chunk of stream) {
    bytes += chunk.length;
    for (let offset = 0; offset + 2 <= chunk.length; offset += WINDOW_BYTES) {
      const slice = chunk.subarray(offset, Math.min(offset + WINDOW_BYTES, chunk.length));
      // Int16Array views need an even byte offset.
      const window = slice.byteOffset % 2 ? Buffer.from(slice) : slice;
      const { rms, peak } = computeChunkStats(window);
      if (rms >= MEETING_MIC_SILENCE_RMS || peak >= MEETING_MIC_SILENCE_PEAK) {
        audibleMs += window.length / PCM_BYTES_PER_MS;
      }
    }
  }
  return { audibleMs, durationMs: bytes / PCM_BYTES_PER_MS };
}

function resolveDiarizationInput({
  systemPcmPath = null,
  micPcmPath = null,
  systemIsCall = false,
  systemStartedAt = null,
  micStartedAt = null,
} = {}) {
  const system = { pcmPath: systemPcmPath, startedAt: systemStartedAt, source: "system" };
  const mic = { pcmPath: micPcmPath, startedAt: micStartedAt, source: "mic" };
  const [primary, other] = systemIsCall || !micPcmPath ? [system, mic] : [mic, system];
  return {
    pcmPath: primary.pcmPath,
    startedAt: primary.startedAt,
    diarizedSource: primary.source,
    alternate: other.pcmPath ? other : null,
  };
}

module.exports = { isCallAudio, measurePcmAudio, resolveDiarizationInput };
