// Route overrides for note-formatting ReasoningService.processText calls.
// Both modes pin their route: self-hosted must forward remoteUrl as lanUrl and
// local must name its runtime, or processText would use the dictation-cleanup
// scope instead of this one.
export function buildNoteFormattingOverrides(noteFormatting) {
  if (noteFormatting?.mode === "self-hosted") {
    return {
      inferenceScope: /** @type {const} */ ("noteFormatting"),
      provider: undefined,
      customApiKey: noteFormatting?.customApiKey || undefined,
      lanUrl: noteFormatting?.remoteUrl || undefined,
    };
  }

  return {
    inferenceScope: /** @type {const} */ ("noteFormatting"),
    provider: "local",
    customApiKey: undefined,
    lanUrl: undefined,
  };
}
