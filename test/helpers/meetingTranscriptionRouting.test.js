const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const load = () => import("../../src/helpers/meetingTranscriptionRouting.js");

const baseOptions = {
  transcriptionMode: "local",
  language: "en",
  localProvider: "whisper",
  whisperModel: "small",
  parakeetModel: "parakeet-tdt-0.6b-v3",
  cohereModel: "cohere-transcribe-03-2026",
};

test("local mode runs the selected local engine and model", async () => {
  const { resolveMeetingTranscriptionOptions } = await load();

  assert.deepEqual(resolveMeetingTranscriptionOptions(baseOptions), {
    provider: "local",
    localProvider: "whisper",
    localModel: "small",
    language: "en",
  });
  assert.equal(
    resolveMeetingTranscriptionOptions({ ...baseOptions, localProvider: "nvidia" }).localModel,
    "parakeet-tdt-0.6b-v3"
  );
  assert.equal(
    resolveMeetingTranscriptionOptions({ ...baseOptions, localProvider: "cohere" }).localModel,
    "cohere-transcribe-03-2026"
  );
});

test("each local engine falls back to its default model when none is chosen", async () => {
  const { resolveMeetingTranscriptionOptions } = await load();
  const unset = { ...baseOptions, whisperModel: "", parakeetModel: "", cohereModel: "" };

  assert.equal(resolveMeetingTranscriptionOptions(unset).localModel, "base");
  assert.equal(
    resolveMeetingTranscriptionOptions({ ...unset, localProvider: "nvidia" }).localModel,
    "parakeet-tdt-0.6b-v3"
  );
  assert.equal(
    resolveMeetingTranscriptionOptions({ ...unset, localProvider: "cohere" }).localModel,
    "cohere-transcribe-03-2026"
  );
});

test("self-hosted mode fails closed with a sentinel the mount translates", async () => {
  const { resolveMeetingTranscriptionOptions } = await load();

  assert.throws(
    () => resolveMeetingTranscriptionOptions({ ...baseOptions, transcriptionMode: "self-hosted" }),
    { message: "unsupportedSelfHosted" }
  );

  const translation = JSON.parse(
    fs.readFileSync(path.join(__dirname, "../../src/locales/en/translation.json"), "utf8")
  );
  const mount = fs.readFileSync(
    path.join(__dirname, "../../src/components/MeetingRecordingMount.tsx"),
    "utf8"
  );
  assert.equal(typeof translation.notes.meeting.unsupportedSelfHosted, "string");
  assert.ok(mount.includes('unsupportedSelfHosted: "notes.meeting.unsupportedSelfHosted"'));
});
