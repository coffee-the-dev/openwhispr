import type { TranscriptionMode } from "../types/electron";

export function supportsLiveTranscriptionPreview(mode: TranscriptionMode): boolean {
  return mode === "local";
}

/**
 * Assistant-routed recordings stream their answer into the assistant panel;
 * the floating dictation preview must never appear for them. Single owner of
 * that rule for the local preview window (AudioManager's `display` flag).
 */
export function shouldDisplayDictationPreview(
  enabled: boolean,
  voiceAgentRequested: boolean
): boolean {
  return !!enabled && !voiceAgentRequested;
}
