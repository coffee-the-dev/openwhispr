// Pure resolver for the "retention-settings-changed" IPC sync. The renderer
// re-syncs on mount, so the handler needs to know whether the incoming values
// actually differ before kicking off another cleanup sweep.
const DEFAULT_RETENTION_SETTINGS = {
  audioRetentionDays: 30, // dictation audio
  meetingAudioRetentionDays: 30, // 0 = don't keep meeting audio
  transcriptRetentionDays: 0, // 0 = keep transcripts forever
  // The renderer's "save dictation history" switch. Defaults to true so a renderer
  // that predates this field is never read as history-off, and so the value
  // only becomes trustworthy once hasSynced() says it is real.
  dataRetentionEnabled: true,
};

function toDays(value, fallback) {
  const days = Math.trunc(Number(value));
  return Number.isFinite(days) && days >= 0 ? days : fallback;
}

function applyRetentionSettings(current, incoming) {
  const settings = {
    audioRetentionDays: toDays(incoming?.audioRetentionDays, current.audioRetentionDays),
    meetingAudioRetentionDays: toDays(
      incoming?.meetingAudioRetentionDays,
      current.meetingAudioRetentionDays
    ),
    transcriptRetentionDays: toDays(
      incoming?.transcriptRetentionDays,
      current.transcriptRetentionDays
    ),
    dataRetentionEnabled:
      typeof incoming?.dataRetentionEnabled === "boolean"
        ? incoming.dataRetentionEnabled
        : current.dataRetentionEnabled,
  };
  const changed = Object.keys(settings).some((key) => settings[key] !== current[key]);
  return { changed, settings };
}

function createRetentionSettingsHandler({
  getCurrentSettings,
  getOwner,
  hasSynced,
  onSettingsChanged,
}) {
  return (event, incoming) => {
    const owner = getOwner();
    if (!owner || event.sender !== owner) return;

    const { changed, settings } = applyRetentionSettings(getCurrentSettings(), incoming);
    // Before the first sync the current values are defaults, not the user's, so
    // "unchanged" only means they happen to match the default — the consumer
    // still needs that first sync to know the settings are real (#1370).
    if (changed || !hasSynced()) onSettingsChanged(settings);
  };
}

module.exports = {
  DEFAULT_RETENTION_SETTINGS,
  applyRetentionSettings,
  createRetentionSettingsHandler,
};
