export function resolveMeetingTranscriptionOptions({
  transcriptionMode,
  language,
  localProvider,
  whisperModel,
  parakeetModel,
  cohereModel,
  remoteTranscriptionUrl,
  remoteTranscriptionModel,
}) {
  // Main re-resolves (and validates) the endpoint from these fields. A missing
  // URL fails here with a sentinel MeetingRecordingMount translates, not an
  // English sentence.
  if (transcriptionMode === "self-hosted") {
    const url = typeof remoteTranscriptionUrl === "string" ? remoteTranscriptionUrl.trim() : "";
    if (!url) throw new Error("selfHostedNotConfigured");
    const model =
      typeof remoteTranscriptionModel === "string" ? remoteTranscriptionModel.trim() : "";
    return {
      provider: "self-hosted",
      remoteTranscriptionUrl: url,
      remoteTranscriptionModel: model,
      language,
    };
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
