export function resolveMeetingTranscriptionOptions({
  transcriptionMode,
  language,
  localProvider,
  whisperModel,
  parakeetModel,
  cohereModel,
}) {
  // A sentinel MeetingRecordingMount translates, not an English sentence: Note
  // Recording has no self-hosted route yet.
  if (transcriptionMode === "self-hosted") {
    throw new Error("unsupportedSelfHosted");
  }

  return {
    provider: "local",
    localProvider,
    localModel:
      localProvider === "nvidia"
        ? parakeetModel || "parakeet-tdt-0.6b-v3"
        : localProvider === "cohere"
          ? cohereModel || "cohere-transcribe-03-2026"
          : whisperModel || "base",
    language,
  };
}
