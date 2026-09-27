// The pill's command menu hides Ask assistant when it cannot run; the tray always
// shows it, and only this renderer can open the panel. This decides what it does
// with the request, and the message it explains a refusal with. Keys resolve
// through i18n in the renderer. The meeting entry needs none of this: it starts
// in the main process.
export const TRAY_REFUSAL_KEYS = Object.freeze({
  busy: "app.commandMenu.busyRecording",
});

const run = Object.freeze({ action: "run" });
const refuse = (messageKey) => Object.freeze({ action: "refuse", messageKey });

/** The pill menu hides Ask Assistant while a panel owns the pill. */
export function resolveTrayAssistantAction({ isRecording, liveTranscriptMounted }) {
  if (isRecording || liveTranscriptMounted) return refuse(TRAY_REFUSAL_KEYS.busy);
  return run;
}
