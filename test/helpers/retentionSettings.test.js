const test = require("node:test");
const assert = require("node:assert/strict");

const {
  DEFAULT_RETENTION_SETTINGS,
  applyRetentionSettings,
  createRetentionSettingsHandler,
} = require("../../src/helpers/retentionSettings");

test("reports a change when a retention period is shortened", () => {
  assert.deepEqual(
    applyRetentionSettings(DEFAULT_RETENTION_SETTINGS, {
      audioRetentionDays: 1,
      transcriptRetentionDays: 1,
    }),
    {
      changed: true,
      settings: {
        audioRetentionDays: 1,
        meetingAudioRetentionDays: 30,
        transcriptRetentionDays: 1,
        dataRetentionEnabled: true,
      },
    }
  );
});

test("is idempotent when both values are unchanged — dual-window mount sync", () => {
  const { changed } = applyRetentionSettings(DEFAULT_RETENTION_SETTINGS, {
    audioRetentionDays: 30,
    transcriptRetentionDays: 0,
  });
  assert.equal(changed, false);
});

test("keeps the current value when an incoming value is missing or unusable", () => {
  const current = {
    audioRetentionDays: 7,
    meetingAudioRetentionDays: 14,
    transcriptRetentionDays: 1,
    dataRetentionEnabled: true,
  };
  for (const incoming of [
    undefined,
    {},
    { audioRetentionDays: "abc", meetingAudioRetentionDays: -1, transcriptRetentionDays: -5 },
  ]) {
    assert.deepEqual(applyRetentionSettings(current, incoming), {
      changed: false,
      settings: current,
    });
  }
});

test("only the main renderer can replace process-global retention settings", () => {
  const mainRenderer = {};
  const auxiliaryRenderers = [{}, {}, {}];
  const syncedSettings = {
    audioRetentionDays: 7,
    meetingAudioRetentionDays: 60,
    transcriptRetentionDays: 30,
    dataRetentionEnabled: true,
  };
  let current = { ...DEFAULT_RETENTION_SETTINGS };
  let cleanupRuns = 0;
  let synced = false;
  const handleRetentionSettingsChanged = createRetentionSettingsHandler({
    getCurrentSettings: () => current,
    getOwner: () => mainRenderer,
    hasSynced: () => synced,
    onSettingsChanged: (settings) => {
      current = settings;
      synced = true;
      cleanupRuns += 1;
    },
  });

  handleRetentionSettingsChanged({ sender: mainRenderer }, syncedSettings);
  assert.deepEqual(current, syncedSettings);
  assert.equal(cleanupRuns, 1);

  for (const auxiliaryRenderer of auxiliaryRenderers) {
    handleRetentionSettingsChanged(
      { sender: auxiliaryRenderer },
      { audioRetentionDays: 90, transcriptRetentionDays: 0 }
    );
    assert.deepEqual(current, syncedSettings);
    assert.equal(cleanupRuns, 1);
  }

  handleRetentionSettingsChanged(
    { sender: mainRenderer },
    { audioRetentionDays: 90, transcriptRetentionDays: 0 }
  );
  assert.deepEqual(current, {
    audioRetentionDays: 90,
    meetingAudioRetentionDays: 60,
    transcriptRetentionDays: 0,
    dataRetentionEnabled: true,
  });
  assert.equal(cleanupRuns, 2);
});

test("no sweep runs before the renderer has synced the persisted settings", () => {
  const IPCHandlers = require("../../src/helpers/ipcHandlers");
  const sweeps = [];
  const context = {
    _retentionCleanupInterval: null,
    _retentionSettingsSynced: false,
    _retentionSettings: { ...DEFAULT_RETENTION_SETTINGS },
    _runRetentionCleanup() {
      sweeps.push({ ...this._retentionSettings });
    },
  };

  IPCHandlers.prototype._setupRetentionCleanup.call(context);
  clearInterval(context._retentionCleanupInterval);

  // The 30-day default would have deleted audio a "Disabled" user asked to keep.
  assert.deepEqual(sweeps, []);
});

test("the first sync sweeps even when the user's settings match the defaults", () => {
  let current = { ...DEFAULT_RETENTION_SETTINGS };
  let synced = false;
  let cleanupRuns = 0;
  const owner = {};
  const handle = createRetentionSettingsHandler({
    getCurrentSettings: () => current,
    getOwner: () => owner,
    hasSynced: () => synced,
    onSettingsChanged: (settings) => {
      current = settings;
      synced = true;
      cleanupRuns += 1;
    },
  });

  handle({ sender: owner }, { ...DEFAULT_RETENTION_SETTINGS });
  assert.equal(cleanupRuns, 1);

  // A second window mounting must not sweep again.
  handle({ sender: owner }, { ...DEFAULT_RETENTION_SETTINGS });
  assert.equal(cleanupRuns, 1);
});

test("a disabled retention setting reaches the sweep before it can delete", () => {
  let current = { ...DEFAULT_RETENTION_SETTINGS };
  let synced = false;
  const sweptWith = [];
  const owner = {};
  const handle = createRetentionSettingsHandler({
    getCurrentSettings: () => current,
    getOwner: () => owner,
    hasSynced: () => synced,
    onSettingsChanged: (settings) => {
      current = settings;
      synced = true;
      sweptWith.push({ ...settings });
    },
  });

  handle(
    { sender: owner },
    { audioRetentionDays: 0, meetingAudioRetentionDays: 0, transcriptRetentionDays: 0 }
  );
  assert.deepEqual(sweptWith, [
    {
      audioRetentionDays: 0,
      meetingAudioRetentionDays: 0,
      transcriptRetentionDays: 0,
      dataRetentionEnabled: true,
    },
  ]);
});

test("carries the effective local-history switch, and reports it changing", () => {
  const current = { ...DEFAULT_RETENTION_SETTINGS, dataRetentionEnabled: true };

  const off = applyRetentionSettings(current, {
    audioRetentionDays: current.audioRetentionDays,
    transcriptRetentionDays: current.transcriptRetentionDays,
    dataRetentionEnabled: false,
  });
  assert.equal(off.settings.dataRetentionEnabled, false);
  assert.equal(off.changed, true, "turning local history off is a change worth acting on");

  // A renderer that predates this field must not be read as "history off".
  const legacy = applyRetentionSettings(current, {
    audioRetentionDays: current.audioRetentionDays,
    transcriptRetentionDays: current.transcriptRetentionDays,
  });
  assert.equal(legacy.settings.dataRetentionEnabled, true);
  assert.equal(legacy.changed, false);
});

test("the meeting audio timer changes on its own", () => {
  const { changed, settings } = applyRetentionSettings(DEFAULT_RETENTION_SETTINGS, {
    meetingAudioRetentionDays: 0,
  });
  assert.equal(changed, true);
  assert.equal(settings.meetingAudioRetentionDays, 0);
  assert.equal(settings.audioRetentionDays, DEFAULT_RETENTION_SETTINGS.audioRetentionDays);
});
