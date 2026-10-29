const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  isCallAudio,
  measurePcmAudio,
  resolveDiarizationInput,
} = require("../../src/helpers/meetingDiarizationInput");

const SYSTEM = "/tmp/ow-diarize-raw-1.pcm";
const MIC = "/tmp/ow-diarize-raw-mic-1.pcm";

test("a call diarizes the system capture and keeps the mic as the alternate", () => {
  const input = resolveDiarizationInput({
    systemPcmPath: SYSTEM,
    micPcmPath: MIC,
    systemIsCall: true,
    systemStartedAt: 1000,
    micStartedAt: 900,
  });

  assert.deepEqual(input, {
    pcmPath: SYSTEM,
    startedAt: 1000,
    diarizedSource: "system",
    alternate: { pcmPath: MIC, startedAt: 900, source: "mic" },
  });
});

test("a session that isn't a call diarizes the mic and keeps the system capture", () => {
  const input = resolveDiarizationInput({
    systemPcmPath: SYSTEM,
    micPcmPath: MIC,
    systemIsCall: false,
    systemStartedAt: 1000,
    micStartedAt: 900,
  });

  assert.deepEqual(input, {
    pcmPath: MIC,
    startedAt: 900,
    diarizedSource: "mic",
    alternate: { pcmPath: SYSTEM, startedAt: 1000, source: "system" },
  });
});

test("one capture diarizes alone; none skips", () => {
  assert.deepEqual(resolveDiarizationInput({ systemPcmPath: SYSTEM, systemStartedAt: 1000 }), {
    pcmPath: SYSTEM,
    startedAt: 1000,
    diarizedSource: "system",
    alternate: null,
  });
  // Linux "unsupported" system-audio mode never delivers a system chunk.
  assert.deepEqual(resolveDiarizationInput({ micPcmPath: MIC, micStartedAt: 900 }), {
    pcmPath: MIC,
    startedAt: 900,
    diarizedSource: "mic",
    alternate: null,
  });
  assert.deepEqual(resolveDiarizationInput({}), {
    pcmPath: null,
    startedAt: null,
    diarizedSource: "system",
    alternate: null,
  });
});

test("chimes on a speakerphone call are not a call; a remote voice is", () => {
  const minutes = (n) => n * 60_000;
  // The measured LoopNet phone call: 1.7 s audible in 22 min.
  assert.equal(isCallAudio({ audibleMs: 1700, durationMs: minutes(22) }), false);
  assert.equal(isCallAudio({ audibleMs: 9_900, durationMs: minutes(60) }), false);
  assert.equal(isCallAudio({ audibleMs: 10_000, durationMs: minutes(60) }), true);
  // A short session counts once a quarter of it is audible.
  assert.equal(isCallAudio({ audibleMs: 5_000, durationMs: 20_000 }), true);
  assert.equal(isCallAudio({ audibleMs: 4_000, durationMs: 20_000 }), false);
  assert.equal(isCallAudio({ audibleMs: 0, durationMs: 0 }), false);
});

test("measures audible time of a raw 24 kHz capture in 100 ms windows", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ow-diar-input-"));
  const file = path.join(dir, "system.pcm");
  // 3 s silence, 1.5 s tone, 2 s silence: windows straddle file reads.
  const samples = new Int16Array(24 * 6500);
  for (let i = 24 * 3000; i < 24 * 4500; i += 1) {
    samples[i] = Math.round(Math.sin(i / 10) * 8000);
  }
  fs.writeFileSync(file, Buffer.from(samples.buffer));

  assert.deepEqual(await measurePcmAudio(file), { audibleMs: 1500, durationMs: 6500 });
});
