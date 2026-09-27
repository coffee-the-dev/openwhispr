const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/trayActionPolicy.js");

// The pill's command menu hides Ask assistant instead of refusing; the tray always
// shows it, so every path here must answer rather than swallow the click.
test("the tray's assistant action refuses a busy pill, and runs otherwise", async () => {
  const { resolveTrayAssistantAction, TRAY_REFUSAL_KEYS } = await load();
  const idle = { isRecording: false, liveTranscriptMounted: false };

  assert.deepEqual(resolveTrayAssistantAction(idle), { action: "run" });
  assert.deepEqual(resolveTrayAssistantAction({ ...idle, isRecording: true }), {
    action: "refuse",
    messageKey: TRAY_REFUSAL_KEYS.busy,
  });
  // The transcript panel owns the pill just as a live recording does.
  assert.deepEqual(resolveTrayAssistantAction({ ...idle, liveTranscriptMounted: true }), {
    action: "refuse",
    messageKey: TRAY_REFUSAL_KEYS.busy,
  });
});
