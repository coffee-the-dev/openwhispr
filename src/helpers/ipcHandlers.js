const { ipcMain, app, shell, BrowserWindow, systemPreferences, net } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { isRestorablePasteTarget } = require("./windowsPasteTarget");
const crypto = require("crypto");
const debugLogger = require("./debugLogger");
const { ANALYTICS_HISTORY_BACKFILL_VERSION } = require("./analytics");
const { PARAKEET_UNSUPPORTED_OS_CODE } = require("./parakeetCapability");
const { getModelType, isSherpaLocalProvider } = require("./parakeetModelInfo");
const { broadcastToWindows } = require("./windowBroadcast");
const { openExternalUrl } = require("./externalUrlOpener");
const { resolveFailedGpuBackends } = require("./whisper");
const { WHISPER_GPU_FAILURE_REASON_KEYS } = require("./whisperGpuFailureReason");
const { SCOPE_API_KEYS } = require("../config/secretKeys");
const { resolveSystemDefaultMicrophone } = require("./systemDefaultMicrophone");
const { ipcErrorFields } = require("./ipcErrorFields");
const {
  isProviderSettingsTarget,
  providerHttpError,
  asProviderError,
  redactProviderBody,
} = require("./providerHttpErrors");
// Local engines resolve a failed decode instead of throwing. Retry turns that
// into a coded error so the toast says what went wrong rather than blaming a
// missing engine.
function localTranscriptionFailure(result) {
  const error = new Error(result.message || result.error || "Local transcription failed");
  if (result.code === "NO_SPEECH_DETECTED" || result.message === "No audio detected") {
    error.code = "NO_SPEECH_DETECTED";
  } else if (result.error === "invalid_response") {
    error.code = "INVALID_RESPONSE";
    error.messageKey = "controlPanel.history.retryErrors.invalidResponse";
  }
  return error;
}
const { resolveLocalServerNeeds, shouldStopLocalServer } = require("./localServerPolicy");
const autoStart = require("./autoStart");
const { getRelaunchOptions, getRelaunchWaiter } = require("./autoStartPolicy");
const HyprlandShortcutManager = require("./hyprlandShortcut");
const { i18nMain, changeLanguage } = require("./i18nMain");
const { ONBOARDING_DEMO_KINDS, ONBOARDING_DEMO_STATUSES } = require("./onboardingInputPolicy");
const { focusWindowsHotkeyCaptureWindow } = require("./hotkeyCaptureFocus");
const AudioStorageManager = require("./audioStorage");
const {
  archiveMeetingAudio,
  listMeetingAudioForNote,
  deleteMeetingAudioForNote,
  deleteExpiredMeetingAudio,
  deleteAllMeetingAudio,
  getMeetingAudioUsage,
} = require("./meetingAudioArchive");
const { NoteFilesSync } = require("./noteFilesSync");
const LocalModelDownloadStatus = require("./localModelDownloadStatus");
const createMeetingTranscriptionLifecycle = require("./meetingTranscriptionLifecycle");
const liveSpeakerIdentifier = require("./liveSpeakerIdentifier");
const { supportsLiveSpeakerIdentification } = require("./liveSpeakerIdPolicy");
const MeetingEchoLeakDetector = require("./meetingEchoLeakDetector");
const createMeetingSystemAudioWatchdog = require("./meetingSystemAudioWatchdog");
const createMeetingSystemAudioHandover = require("./meetingSystemAudioHandover");
const {
  partitionPendingMicFinals,
  isRiskyMicDuplicateProfile,
  isDuplicateMicSegment,
  selectRacingMicEntryIndices,
  partitionOverlappingPendingMicFinals,
} = require("./meetingMicHoldback");
const {
  computeChunkStats,
  resolveMicChunkAction,
  MEETING_MIC_SILENCE_RMS,
  MEETING_MIC_SILENCE_PEAK,
} = require("./meetingMicGate");
const { deriveDetectorPreferences } = require("./meetingDetectionPreferencePolicy");
const {
  isCallAudio,
  measurePcmAudio,
  resolveDiarizationInput,
} = require("./meetingDiarizationInput");
const { applySmartSpacing } = require("./smartSpacing");
const { applyAutoLearnSetting } = require("./autoLearnSetting");
const {
  DEFAULT_RETENTION_SETTINGS,
  createRetentionSettingsHandler,
} = require("./retentionSettings");
const {
  transcriptsOverlap,
  transcriptsLooselyOverlap,
  buildMergedCandidates,
} = require("./transcriptText");
const {
  applyConfirmedSpeaker,
  applySuggestedSpeaker,
  canAutoRelabelSpeaker,
  isSpeakerLocked,
} = require("./speakerAssignmentPolicy");
const { normalizeStoredSpeakerCount } = require("./speakerCount");
const {
  buildSpeakerRenumber,
  normalizeSpeakerIndexBase,
  resolveSpeakerIndexBase,
} = require("./speakerIndexBase");
const { downsample24kTo16k, pcm16ToWav } = require("../utils/audioUtils");
const postMigrationDetector = require("./postMigrationDetector");
const screenContextCapture = require("./screenContextCapture");
const { classifyToneAppCategory } = require("./toneAppCategories");
const {
  DEFAULT_EXPECTED_SPEAKER_COUNT,
  LIVE_SPEAKER_LIMIT,
} = require("../constants/speakerDetection.json");
const {
  resolveClusterThreshold,
  dropNegligibleClusters,
  isCollapsedDiarization,
} = require("./diarizationPolicy");
const { PCM16_MONO_16K_BYTES_PER_SECOND } = require("./transcriptionTimeout");
const { UPLOAD_AUDIO_EXTENSIONS } = require("../constants/uploadAudioFormats.json");
const { providerContentType, prepareProviderUpload } = require("./providerUploadAudio");
const {
  DEFAULT_WHISPER_VAD_CONFIG,
  sanitizeWhisperVadConfig,
  resolveContextSileroEnabled,
} = require("./whisperVadConfig");

const { getCalendarAvailability } = require("./calendarAvailabilityService");

// The 25 MB request cap OpenAI-compatible transcription servers commonly enforce.
const WAV_UPLOAD_LIMIT_BYTES = 25 * 1024 * 1024;

// Debounce delay: wait for user to stop typing before processing corrections
const AUTO_LEARN_DEBOUNCE_MS = 1500;

const { testProviderConnection, listRemoteModels } = require("./providerConnectionTest");
const { searxngSearch } = require("./searxngSearch");
const {
  SELF_HOSTED_CHUNK_SECONDS,
  SELF_HOSTED_UPLOAD_LIMIT_BYTES,
  requestTranscription,
  stitchTranscriptionChunks,
} = require("./selfHostedFileTranscription");
const {
  capMeetingBacklog,
  createSelfHostedChunkTranscriber,
} = require("./selfHostedMeetingTranscriber");
const { diarizeViaServer } = require("./selfHostedDiarization");
const { createConnectionCheckCache } = require("./connectionCheckCache");
const { createUploadCancelRegistry } = require("./uploadCancelRegistry");
const {
  consolidateSpeakerRuns,
  formatSpeakerTranscript,
  labelSpeakers,
  mergeSpeakersWithSegments,
  mergeSpeakersWithText,
} = require("./speakerMerge");
const { listLocalTranscriptionModels } = require("./localTranscriptionModels");

// Canonicalize allowed dirs so realpath'd inputs match on macOS (/var -> /private/var).
// Deliberately narrow: user-picked paths anywhere else are approved individually via
// approvedAudioPaths, so a compromised renderer can't read arbitrary files.
function getCanonicalAllowedAudioDirs() {
  const os = require("os");
  const { getSafeTempDir } = require("./safeTempDir");
  const dirs = [os.tmpdir(), getSafeTempDir(), app.getPath("userData")];
  return dirs.map((d) => {
    try {
      return fs.realpathSync(d);
    } catch {
      return d;
    }
  });
}

// User-picked paths (OS file dialog, real drag-dropped files) may live outside the
// static dirs (external volumes, /mnt, D:\) and are approved individually.
const approvedAudioPaths = new Set();

function approveAudioPath(filePath) {
  if (typeof filePath !== "string" || !filePath) return;
  try {
    approvedAudioPaths.add(fs.realpathSync(path.resolve(filePath)));
  } catch {
    // File vanished or unreadable; nothing to approve.
  }
}

// Returns the realpath'd file path if it lives under an allowed dir, else null.
function resolveAllowedAudioPath(filePath) {
  const real = fs.realpathSync(path.resolve(filePath));
  if (approvedAudioPaths.has(real)) {
    return real;
  }
  const allowed = getCanonicalAllowedAudioDirs();
  if (allowed.some((dir) => real === dir || real.startsWith(dir + path.sep))) {
    return real;
  }
  return null;
}

function buildMultipartBody(fileBuffer, fileName, contentType, fields = {}) {
  const boundary = `----OpenWhispr${Date.now()}`;
  const parts = [];

  parts.push(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n` +
      `Content-Type: ${contentType}\r\n\r\n`
  );
  parts.push(fileBuffer);
  parts.push("\r\n");

  for (const [name, value] of Object.entries(fields)) {
    if (value != null) {
      parts.push(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="${name}"\r\n\r\n` +
          `${value}\r\n`
      );
    }
  }

  parts.push(`--${boundary}--\r\n`);

  const bodyParts = parts.map((p) => (typeof p === "string" ? Buffer.from(p) : p));
  return { body: Buffer.concat(bodyParts), boundary };
}

async function postMultipart(
  url,
  body,
  boundary,
  headers = {},
  { signal, session: fetchSession } = {}
) {
  const response = await (fetchSession ?? net).fetch(url.toString(), {
    method: "POST",
    headers: {
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
      ...headers,
    },
    body,
    useSessionCookies: false,
    signal,
  });
  const text = await response.text();
  try {
    return { statusCode: response.status, data: JSON.parse(text) };
  } catch {
    // Proxies and servers in front of the endpoint can answer with non-JSON bodies.
    throw Object.assign(new Error(`Server error ${response.status}: ${text.slice(0, 120)}`), {
      code: "SERVER_ERROR",
      statusCode: response.status,
    });
  }
}

const {
  isMeetingFolderRef,
  resolveMeetingDestination,
  rememberMeetingDestination,
  meetingDestinationContext,
} = require("./meetingNotificationDestination");

class IPCHandlers {
  constructor(managers) {
    this.environmentManager = managers.environmentManager;
    this.databaseManager = managers.databaseManager;
    this.clipboardManager = managers.clipboardManager;
    this.whisperManager = managers.whisperManager;
    this.parakeetManager = managers.parakeetManager;
    this.diarizationManager = managers.diarizationManager;
    this.windowManager = managers.windowManager;
    this.windowsKeyManager = managers.windowsKeyManager;
    this.linuxKeyManager = managers.linuxKeyManager;
    this.textEditMonitor = managers.textEditMonitor;
    this.selectionManager = managers.selectionManager;
    this.getTrayManager = managers.getTrayManager;
    this.whisperCudaManager = managers.whisperCudaManager;
    this.whisperVulkanManager = managers.whisperVulkanManager;
    this.appleCalendarManager = managers.appleCalendarManager;
    this.meetingDetectionEngine = managers.meetingDetectionEngine;
    this.audioTapManager = managers.audioTapManager;
    this.linuxPortalAudioManager = managers.linuxPortalAudioManager;
    this.windowsLoopbackAudioManager = managers.windowsLoopbackAudioManager;
    this.meetingAecManager = managers.meetingAecManager;
    this.getSemanticSearch = managers.getSemanticSearch;
    this.sessionId = crypto.randomUUID();
    // requestId -> AbortControllers for in-flight audio-upload work (self-hosted
    // upload, or local transcription + diarization sharing one id), so a
    // cancel can abort the exact job.
    this._uploadCancelRegistry = createUploadCancelRegistry();
    // webContents id -> its release listener, for renderers holding the mic open.
    this._micHoldSenders = new Map();
    this._hotkeyCaptureMode = false;
    this._autoLearnEnabled = true; // Default on, synced from renderer
    this._autoLearnDebounceTimer = null;
    this._autoLearnLatestData = null;
    this._textEditHandler = null;
    this._activeRecordingPipeline = null;
    this._onboardingDemoSession = null;
    this.audioStorageManager = new AudioStorageManager();
    this.localModelDownloadStatus = new LocalModelDownloadStatus();
    this._retentionCleanupInterval = null;
    this._retentionSettings = { ...DEFAULT_RETENTION_SETTINGS }; // Synced from renderer
    this._retentionSettingsSynced = false;
    this.noteFilesSync = new NoteFilesSync({
      databaseManager: this.databaseManager,
      stateFilePath: () => path.join(app.getPath("userData"), "note-files-state.json"),
      translate: (key, options) => i18nMain.t(key, options),
      onImport: ({ created, updated }) => {
        setImmediate(() => {
          for (const note of created) broadcastToWindows("note-added", note);
          for (const note of updated) broadcastToWindows("note-updated", note);
        });
        this.notifyVectorChanges();
      },
    });
    this._granolaImportPending = null;
    this._analyticsHistoryBackfillPromise = null;
    this.speakerDiarizationEnabled = true;
    this.databaseManager?.addNoteChangeListener?.((change) => {
      if (change?.type === "delete") void deleteMeetingAudioForNote(change.noteId);
    });
    // Where meetings and uploads diarize; the renderer syncs it via set-diarization-endpoint.
    this.diarizationRoute = { transport: "local" };
    // Default for the saved process-detection toggle. The engine keeps both detectors
    // off until the renderer syncs (see meetingDetectionPreferencePolicy.js).
    this.meetingProcessDetection = true;
    this.activeMeetingSpeakerConfig = null;
    // Diarization session id → { noteId, ceiling }: speaker ids a stopped session's
    // diarization may still write to its note (see _resolveMeetingSpeakerIndexBase).
    this._diarizationSpeakerReservations = new Map();
    this.whisperVadSettings = {
      dictationSileroEnabled: false,
      noteRecordingSileroEnabled: true,
      meetingSileroEnabled: true,
      ...DEFAULT_WHISPER_VAD_CONFIG,
    };
    liveSpeakerIdentifier.setDiarizationManager(this.diarizationManager);
    this._setupTextEditMonitor();
    this._setupRetentionCleanup();
    this._logDetectedGpus();
    // Warm the OS default mic answer before the first hotkey press (~2s on Windows).
    resolveSystemDefaultMicrophone();
    this.setupHandlers();

    if (this.whisperManager?.serverManager) {
      this._attachWhisperServerListeners(this.whisperManager.serverManager);
    }
  }

  createFolderWithEffects(name, spaceId) {
    const result = this.databaseManager.createFolder(name, spaceId);
    if (result?.success && result?.folder) {
      setImmediate(() => {
        broadcastToWindows("folder-created", result.folder);
        this.noteFilesSync?.ensureFolder(result.folder.name);
      });
    }
    return result;
  }

  getMeetingNotificationDestination(owner) {
    if (!this.windowManager.isMeetingNotificationOwner(owner))
      return { success: false, code: "STALE_NOTIFICATION" };
    try {
      const context = meetingDestinationContext(
        this.databaseManager,
        owner,
        this.windowManager.meetingRecentDestinations
      );
      this.windowManager.meetingRecentDestinations = context.recentDestinations;
      return { success: true, value: context };
    } catch (error) {
      return {
        success: false,
        code: error.code === "NOTE_UNAVAILABLE" ? error.code : "FOLDERS_UNAVAILABLE",
      };
    }
  }

  selectMeetingNotificationFolder(owner, ref) {
    const result = this.getMeetingNotificationDestination(owner);
    if (!result.success) return result;
    if (result.value.existingNote)
      return { success: false, code: "LINKED_NOTE_CHANGED", context: result.value };
    if (!isMeetingFolderRef(ref)) return { success: false, code: "INVALID_REQUEST" };
    const folder = result.value.folders.find(
      (f) => f.id === ref.folderId && f.space_id === ref.spaceId
    );
    if (!folder) return { success: false, code: "FOLDER_UNAVAILABLE" };
    owner.selectedDestination = { folderId: folder.id, spaceId: folder.space_id };
    this.windowManager.meetingRecentDestinations = rememberMeetingDestination(
      this.windowManager.meetingRecentDestinations,
      owner.selectedDestination
    );
    return {
      success: true,
      value: {
        ...result.value,
        selectedDestination: owner.selectedDestination,
        recentDestinations: this.windowManager.meetingRecentDestinations,
      },
    };
  }

  createMeetingNotificationFolder(owner, request) {
    if (!this.windowManager.isMeetingNotificationOwner(owner))
      return { success: false, code: "STALE_NOTIFICATION" };
    if (
      !request ||
      typeof request.requestId !== "string" ||
      !request.requestId.trim() ||
      request.requestId.length > 128 ||
      typeof request.name !== "string" ||
      !Number.isSafeInteger(request.spaceId) ||
      request.spaceId <= 0
    )
      return { success: false, code: "INVALID_REQUEST" };
    const name = request.name.trim();
    if (!name) return { success: false, code: "FOLDER_NAME_REQUIRED" };
    const cached = owner.createRequests.get(request.requestId);
    if (cached && (cached.name !== name || cached.spaceId !== request.spaceId))
      return { success: false, code: "INVALID_REQUEST" };
    // Bound per-prompt retry bookkeeping. Successful IDs stay stable for the prompt's lifetime.
    if (!cached && owner.createRequests.size >= 32)
      return { success: false, code: "INVALID_REQUEST" };
    const contextResult = this.getMeetingNotificationDestination(owner);
    if (!contextResult.success) return contextResult;
    if (contextResult.value.existingNote)
      return { success: false, code: "LINKED_NOTE_CHANGED", context: contextResult.value };
    if (!contextResult.value.spaces.some((space) => space.id === request.spaceId))
      return { success: false, code: "SPACE_UNAVAILABLE" };
    try {
      let ref = cached?.ref;
      if (ref) {
        if (!resolveMeetingDestination(this.databaseManager, ref))
          return { success: false, code: "FOLDER_UNAVAILABLE" };
      } else {
        const result = this.createFolderWithEffects(name, request.spaceId);
        if (!result?.success || !result.folder)
          return {
            success: false,
            code:
              result?.error === "A folder with that name already exists"
                ? "FOLDER_NAME_TAKEN"
                : result?.error === "Space not found"
                  ? "SPACE_UNAVAILABLE"
                  : "CREATE_FAILED",
          };
        ref = { folderId: result.folder.id, spaceId: result.folder.space_id };
        owner.createRequests.set(request.requestId, { name, spaceId: request.spaceId, ref });
        this.windowManager.sendToControlPanel("meeting-notification-folder-created", {
          folderId: ref.folderId,
        });
      }
      const refreshed = this.getMeetingNotificationDestination(owner);
      return refreshed.success
        ? { success: true, value: { ...refreshed.value, createdFolder: ref } }
        : refreshed;
    } catch {
      return { success: false, code: "CREATE_FAILED" };
    }
  }

  // Reconstructing counters from the transcripts already on disk records exactly
  // what "keep local history" turns off, so it answers to the same switch the
  // live path checks in audioManager.saveTranscription. The main process boots
  // with defaults rather than the user's choice, so an unsynced setting is not
  // consent either -- the renderer's first sync is what starts this (#1370).
  _canReconstructAnalyticsHistory() {
    return this._retentionSettingsSynced && this._retentionSettings.dataRetentionEnabled;
  }

  // Reconciliation is best-effort. Analytics reads await it so later-eligible
  // history shows up before the numbers are read, which means a failure here
  // must never fail the read itself: a broken scan would otherwise blank an
  // Insights summary that SQLite could have answered perfectly well.
  async _ensureAnalyticsHistoryBackfilled() {
    if (!this._canReconstructAnalyticsHistory()) return { inserted: 0, scanned: 0 };
    if (this._analyticsHistoryBackfillPromise) return this._analyticsHistoryBackfillPromise;
    // The failure is absorbed inside this promise rather than around the
    // creator's await, because callers that join an in-flight pass are handed
    // this promise directly and would otherwise receive the raw rejection --
    // which is every analytics read that arrives while the startup pass is
    // still scanning.
    const backfillPromise = (async () => {
      let inserted = 0;
      let scanned = 0;
      let skipped = 0;
      let stoppedEarly = false;
      const state = this.databaseManager.getAnalyticsHistoryBackfillState(
        ANALYTICS_HISTORY_BACKFILL_VERSION
      );
      if (state.scannedThroughId >= state.targetId) return { inserted, scanned };
      while (true) {
        // The database reads its persisted cursor again for every batch. An
        // older row made eligible while this pass yields can move that cursor
        // backward without being overwritten by stale in-memory progress.
        const batch = this.databaseManager.backfillAnalyticsHistoryBatch({
          throughId: state.targetId,
          checkpointVersion: ANALYTICS_HISTORY_BACKFILL_VERSION,
        });
        inserted += batch.inserted;
        scanned += batch.scanned;
        skipped += batch.skipped;
        if (batch.complete) break;
        await new Promise((resolve) => setImmediate(resolve));
        // The user can turn the switch off while this pass yields. Re-reading it
        // here stops the scan at the next batch boundary instead of mining the
        // rest of a history the user has just opted out of.
        if (!this._canReconstructAnalyticsHistory()) {
          stoppedEarly = true;
          break;
        }
      }
      if (inserted > 0) broadcastToWindows("analytics-changed");
      if (scanned > 0) {
        debugLogger.info(
          stoppedEarly
            ? "Analytics history backfill stopped: local history was turned off mid-scan"
            : "Analytics history backfill complete",
          { inserted, skipped, scanned },
          "analytics"
        );
      }
      return { inserted, scanned };
    })().catch((error) => {
      debugLogger.error("Analytics history backfill failed", { error: error.message }, "analytics");
      return { inserted: 0, scanned: 0 };
    });
    this._analyticsHistoryBackfillPromise = backfillPromise;
    // Cleared after the assignment above, never inside the pass: a scan that
    // finishes without ever awaiting would otherwise strand its own resolved
    // promise here and every later read would join a pass that already ended.
    void backfillPromise.then(() => {
      if (this._analyticsHistoryBackfillPromise === backfillPromise) {
        this._analyticsHistoryBackfillPromise = null;
      }
    });
    return backfillPromise;
  }

  // The dictation slot reports its own changes from the renderer. Slots
  // registered through IPC have to announce theirs here so macOS can re-derive
  // which keys the native Globe listener owns.
  _notifyHotkeyChanged(hotkey) {
    ipcMain.emit("hotkey-changed", null, hotkey);
  }

  _releaseMicHold(sender) {
    const release = this._micHoldSenders.get(sender.id);
    if (!release) return;
    this._micHoldSenders.delete(sender.id);
    sender.off("destroyed", release);
    sender.off("did-finish-load", release);
    this.meetingDetectionEngine?.setMicWarmHold(this._micHoldSenders.size > 0);
  }

  _getWhisperVadSettings() {
    const current = this.whisperVadSettings || {};
    return {
      dictationSileroEnabled: current.dictationSileroEnabled === true,
      noteRecordingSileroEnabled: current.noteRecordingSileroEnabled !== false,
      meetingSileroEnabled: current.meetingSileroEnabled !== false,
      ...sanitizeWhisperVadConfig(current),
    };
  }

  _updateNativeModelDownloadStatus(modelType, modelId, progressData) {
    if (progressData.type === "complete") {
      return this.localModelDownloadStatus.finish(modelType, modelId);
    }

    if (progressData.type === "installing") {
      return this.localModelDownloadStatus.update(modelType, modelId, {
        phase: "installing",
        progress: progressData.percentage || 100,
      });
    }

    return this.localModelDownloadStatus.update(modelType, modelId, {
      phase: "downloading",
      progress: progressData.percentage || 0,
      downloadedBytes: progressData.downloaded_bytes || 0,
      totalBytes: progressData.total_bytes || 0,
    });
  }

  _setWhisperVadSettings(update = {}) {
    const ALLOWED_KEYS = new Set([
      "dictationSileroEnabled",
      "noteRecordingSileroEnabled",
      "meetingSileroEnabled",
      ...Object.keys(require("../constants/whisperVad.json").DEFAULTS),
    ]);
    const filtered = {};
    for (const [k, v] of Object.entries(update)) {
      if (ALLOWED_KEYS.has(k)) filtered[k] = v;
    }
    this.whisperVadSettings = { ...this._getWhisperVadSettings(), ...filtered };
    return this._getWhisperVadSettings();
  }

  // Shared by the upload IPC handler and the CLI bridge. `filePath` must
  // already have passed resolveAllowedAudioPath (or approveAudioPath).
  async transcribeLocalFile(filePath, options = {}) {
    const audioBuffer = fs.readFileSync(filePath);
    if (isSherpaLocalProvider(options.provider)) {
      return this.parakeetManager.transcribeLocalParakeet(audioBuffer, options);
    }
    return this.whisperManager.transcribeLocalWhisper(audioBuffer, {
      ...options,
      ...this._resolveWhisperVadOptions("noteRecording"),
    });
  }

  approveAudioPath(filePath) {
    approveAudioPath(filePath);
  }

  listLocalTranscriptionModels() {
    return listLocalTranscriptionModels({
      whisperManager: this.whisperManager,
      parakeetManager: this.parakeetManager,
    });
  }

  _resolveWhisperVadOptions(context) {
    const settings = this._getWhisperVadSettings();
    const {
      dictationSileroEnabled,
      noteRecordingSileroEnabled,
      meetingSileroEnabled,
      ...vadConfig
    } = settings;
    return {
      vadEnabled: resolveContextSileroEnabled(settings, context),
      vadConfig,
    };
  }

  // Note writes are journaled by SQLite triggers (pending_vector_changes); this
  // only wakes an active semantic index to drain them.
  notifyVectorChanges() {
    this.getSemanticSearch?.()?.notifyChanges();
  }

  _buildSpeakerMappings(noteId) {
    const arr = this.databaseManager.getSpeakerMappings(noteId);
    const map = {};
    for (const m of arr) {
      map[m.speaker_id] = m.display_name;
    }
    return map;
  }

  _parseNonSelfParticipants(participantsJson) {
    if (!participantsJson) return [];
    let participants;
    try {
      participants = JSON.parse(participantsJson);
    } catch (_) {
      return [];
    }
    if (!Array.isArray(participants) || participants.length === 0) return [];
    return participants.filter((p) => p && p.self !== true);
  }

  _getNoteNonSelfParticipants(noteId) {
    if (!noteId) return [];
    try {
      const note = this.databaseManager.getNote(noteId);
      return this._parseNonSelfParticipants(note?.participants);
    } catch (_) {
      return [];
    }
  }

  _resolveOneOnOneOtherParticipant(participantsJson) {
    const others = this._parseNonSelfParticipants(participantsJson);
    if (others.length !== 1) return null;
    const displayName = others[0].displayName || others[0].email;
    if (!displayName) return null;
    const email = (others[0].email || "").toLowerCase().trim() || null;
    return { displayName, email };
  }

  _noteExpectedSpeakerCountOrNull(note) {
    const stored = normalizeStoredSpeakerCount(note?.expected_speaker_count);
    if (stored != null) {
      return stored;
    }
    const others = this._parseNonSelfParticipants(note?.participants).length;
    if (others > 0) {
      return Math.min(others + 1, LIVE_SPEAKER_LIMIT);
    }
    return null;
  }

  _resolveNoteExpectedSpeakerCount(note) {
    return this._noteExpectedSpeakerCountOrNull(note) ?? DEFAULT_EXPECTED_SPEAKER_COUNT;
  }

  _resolveInitialMeetingSpeakerConfig(noteId) {
    let note = null;
    if (noteId != null) {
      try {
        note = this.databaseManager.getNote(noteId);
      } catch (_) {
        note = null;
      }
    }
    const enabled =
      (note?.diarization_enabled == null
        ? this.speakerDiarizationEnabled
        : note.diarization_enabled !== 0) !== false;
    return { enabled, expectedCount: this._resolveNoteExpectedSpeakerCount(note) };
  }

  // Participants added mid-meeting must raise the speaker cap that was derived
  // from the note at recording start. A count the user set via the stepper
  // (explicit) is never overridden.
  //
  // Raise-only: lowering the cap below the clusters already discovered would make
  // _assignOrForceCluster fold every later voice onto an existing speaker — the
  // exact identity collapse this refresh exists to prevent. A roster that shrinks
  // (or empties) mid-meeting therefore leaves the cap where it is.
  _refreshMeetingSpeakerConfigFromNote(noteId, note) {
    const config = this.activeMeetingSpeakerConfig;
    if (!config || config.explicit) return;
    if (noteId == null || this._activeMeetingNoteId !== noteId) return;

    const expectedCount = this._noteExpectedSpeakerCountOrNull(note);
    if (expectedCount == null || expectedCount <= config.expectedCount) return;

    this.activeMeetingSpeakerConfig = { ...config, expectedCount };
    liveSpeakerIdentifier.setMaxSpeakers(Math.max(1, expectedCount - 1));
    broadcastToWindows("meeting-session-speaker-config-updated", {
      enabled: config.enabled,
      expectedCount,
    });
    debugLogger.info(
      "Meeting speaker config refreshed from participants",
      { noteId, expectedCount },
      "speaker"
    );
  }

  _getDictionarySafe() {
    try {
      return this.databaseManager.getDictionary();
    } catch {
      return [];
    }
  }

  _cleanupTextEditMonitor() {
    if (this._autoLearnDebounceTimer) {
      clearTimeout(this._autoLearnDebounceTimer);
      this._autoLearnDebounceTimer = null;
    }
    this._autoLearnLatestData = null;
    if (this.textEditMonitor && this._textEditHandler) {
      this.textEditMonitor.removeListener("text-edited", this._textEditHandler);
      this._textEditHandler = null;
    }
  }

  async _logDetectedGpus() {
    const { listNvidiaGpus } = require("../utils/gpuDetection");
    const gpus = await listNvidiaGpus();
    if (gpus.length > 0) {
      debugLogger.info(
        "NVIDIA GPUs detected",
        {
          count: gpus.length,
          devices: gpus.map((g) => `[${g.index}] ${g.name} (${g.vramMb}MB) ${g.uuid}`),
        },
        "gpu"
      );
    } else {
      debugLogger.debug("No NVIDIA GPUs detected", {}, "gpu");
    }
  }

  _setupRetentionCleanup() {
    const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
    // No sweep at startup: _retentionSettings still holds the 30-day default
    // until the renderer syncs, so sweeping here deletes audio a user set to
    // keep for 60/90 days or forever (#1370). The first sync runs the first
    // sweep instead.
    this._retentionCleanupInterval = setInterval(() => {
      if (this._retentionSettingsSynced) this._runRetentionCleanup();
    }, SIX_HOURS_MS);
  }

  // Meeting audio has its own timer, independent of the dictation history switch.
  // Unsynced settings are defaults, not the user's choice (#1370).
  _keepsMeetingAudio() {
    return this._retentionSettingsSynced && this._retentionSettings.meetingAudioRetentionDays > 0;
  }

  _runRetentionCleanup() {
    const { audioRetentionDays, meetingAudioRetentionDays, transcriptRetentionDays } =
      this._retentionSettings;
    try {
      if (transcriptRetentionDays > 0) {
        const { ids, analyticsPurged } =
          this.databaseManager.deleteTranscriptionsExpiredBefore(transcriptRetentionDays);
        for (const id of ids) {
          this.audioStorageManager.deleteAudio(id);
          broadcastToWindows("transcription-deleted", { id });
        }
        if (analyticsPurged > 0) broadcastToWindows("analytics-changed");
      }
      if (audioRetentionDays > 0) {
        this.audioStorageManager.cleanupExpiredAudio(audioRetentionDays, this.databaseManager);
      }
      if (meetingAudioRetentionDays > 0) {
        void deleteExpiredMeetingAudio(meetingAudioRetentionDays).then((deleted) => {
          if (deleted > 0) debugLogger.info("Expired meeting audio deleted", { deleted });
        });
      }
    } catch (error) {
      debugLogger.error("Retention cleanup failed", { error: error.message }, "audio-storage");
    }
  }

  _setupTextEditMonitor() {
    if (!this.textEditMonitor) return;

    this._textEditHandler = (data) => {
      if (
        !data ||
        typeof data.originalText !== "string" ||
        typeof data.newFieldValue !== "string"
      ) {
        debugLogger.debug("[AutoLearn] Invalid event payload, skipping");
        return;
      }

      const { originalText, newFieldValue } = data;

      debugLogger.debug("[AutoLearn] text-edited event", {
        originalPreview: originalText.substring(0, 80),
        newValuePreview: newFieldValue.substring(0, 80),
      });

      this._autoLearnLatestData = { originalText, newFieldValue };

      if (this._autoLearnDebounceTimer) {
        clearTimeout(this._autoLearnDebounceTimer);
      }

      this._autoLearnDebounceTimer = setTimeout(() => {
        this._processCorrections();
      }, AUTO_LEARN_DEBOUNCE_MS);
    };

    this.textEditMonitor.on("text-edited", this._textEditHandler);
  }

  _processCorrections() {
    this._autoLearnDebounceTimer = null;
    if (!this._autoLearnLatestData) return;
    if (!this._autoLearnEnabled) {
      debugLogger.debug("[AutoLearn] Disabled, skipping correction processing");
      this._autoLearnLatestData = null;
      return;
    }

    const { originalText, newFieldValue } = this._autoLearnLatestData;
    this._autoLearnLatestData = null;

    try {
      const { extractCorrections } = require("../utils/correctionLearner");
      const currentDict = this._getDictionarySafe();
      const corrections = extractCorrections(originalText, newFieldValue, currentDict);
      debugLogger.debug("[AutoLearn] Corrections result", {
        corrections,
        dictSize: currentDict.length,
      });

      if (corrections.length > 0) {
        const saveResult = this.databaseManager.applyDictionaryChanges(
          { add: corrections },
          "learned"
        );

        if (saveResult?.success === false) {
          debugLogger.debug("[AutoLearn] Failed to save dictionary", { error: saveResult.error });
          return;
        }

        // Broadcast the post-save normalized list, not the raw input (which
        // still has case-variant dupes), so renderers don't flash ghost rows.
        broadcastToWindows("dictionary-updated", this.databaseManager.getDictionary());

        // Show the overlay so the toast is visible (it may have been hidden after dictation)
        this.windowManager.showDictationPanel();
        broadcastToWindows("corrections-learned", corrections);
        debugLogger.debug("[AutoLearn] Saved corrections", { corrections });
      }
    } catch (error) {
      debugLogger.debug("[AutoLearn] Error processing corrections", { error: error.message });
    }
  }

  _whisperGpuFailedBackends() {
    return resolveFailedGpuBackends(process.env.WHISPER_GPU_FAILED);
  }

  _attachWhisperServerListeners(serverManager) {
    serverManager.on("cuda-fallback", ({ reason }) => {
      this._recordWhisperGpuFailure("cuda", reason);
      broadcastToWindows("cuda-fallback-notification", {});
    });
    serverManager.on("gpu-fallback", ({ reason }) => {
      this._recordWhisperGpuFailure("vulkan", reason);
      broadcastToWindows("gpu-fallback-notification", {});
    });
    // Persist the discrete-GPU pin so later launches spawn pinned directly
    // instead of paying a second Vulkan cold start. See #1606.
    serverManager.on("vulkan-device-pinned", ({ index }) => {
      this._syncStartupEnv({ WHISPER_VULKAN_DEVICE: String(index) });
    });
    serverManager.on("vulkan-device-pin-cleared", () => {
      this._syncStartupEnv({}, ["WHISPER_VULKAN_DEVICE"]);
    });
  }

  // Remember the failed backend, and the error line that explains it, so the
  // backend isn't re-attempted (and its model reload re-paid) on every launch
  // and the settings card can say why (#1736). Cleared by retry, re-download,
  // delete, and the once-per-upgrade reset. The reason is written in the same
  // .env write as the flag. A failure with no readable reason clears the older
  // one, so a stale cause is never shown.
  _recordWhisperGpuFailure(backend, reason) {
    const failed = this._whisperGpuFailedBackends();
    if (!failed.includes(backend)) failed.push(backend);
    const reasonKey = WHISPER_GPU_FAILURE_REASON_KEYS[backend];
    this._syncStartupEnv(
      { WHISPER_GPU_FAILED: failed.join(","), ...(reason ? { [reasonKey]: reason } : {}) },
      reason ? [] : [reasonKey]
    );
  }

  _clearWhisperGpuFailure(backend) {
    const failed = this._whisperGpuFailedBackends().filter((b) => b !== backend);
    const reasonKey = WHISPER_GPU_FAILURE_REASON_KEYS[backend];
    if (failed.length > 0) {
      this._syncStartupEnv({ WHISPER_GPU_FAILED: failed.join(",") }, [reasonKey]);
    } else {
      this._syncStartupEnv({}, ["WHISPER_GPU_FAILED", reasonKey]);
    }
  }

  // The control panel shows the GPU pack notice. An app started to the tray
  // creates none, so there the dictation panel shows it instead (#2554).
  _gpuPackNoticeWindow() {
    const { controlPanelWindow, mainWindow, startedMinimized } = this.windowManager;
    if (controlPanelWindow && !controlPanelWindow.isDestroyed()) return controlPanelWindow;
    if (startedMinimized && mainWindow && !mainWindow.isDestroyed()) return mainWindow;
    return null;
  }

  _whisperGpuFailureStatus(backend) {
    const gpuFailed = this._whisperGpuFailedBackends().includes(backend);
    const reason = gpuFailed ? process.env[WHISPER_GPU_FAILURE_REASON_KEYS[backend]] : null;
    return { gpuFailed, gpuFailReason: reason || null };
  }

  // Captured before a handler stops the server to touch pack files (stopServer
  // clears currentServerModel); tells _applyWhisperGpuPreference what to reload.
  _whisperReloadModel() {
    return this.whisperManager.serverManager.isRemote
      ? null
      : this.whisperManager.currentServerModel;
  }

  // Apply a GPU pack change to the loaded server without blocking the caller's
  // IPC reply (a Vulkan cold start can take minutes); the renderer follows
  // progress by polling whisper-server-status. Returns whether a reload was
  // kicked off so the UI shows "activating" only when one is coming.
  _applyWhisperGpuPreference(modelName) {
    this.whisperManager.restartServerWithGpuPreference(modelName).catch((err) => {
      debugLogger.error("whisper-server GPU preference restart failed", { error: err.message });
    });
    // Every pack download or delete and every Retry ends here, already saved.
    // Tell every window, not just the caller's: Retry on the fallback pop-up
    // runs in the dictation window, and Settings keeps up to three GPU cards
    // mounted (#1736). A fallback is announced by its own notification.
    broadcastToWindows("whisper-gpu-status-changed");
    return !!modelName;
  }

  _syncStartupEnv(setVars, clearVars = []) {
    let changed = false;
    for (const [key, value] of Object.entries(setVars)) {
      if (process.env[key] !== value) {
        process.env[key] = value;
        changed = true;
      }
    }
    for (const key of clearVars) {
      if (process.env[key]) {
        delete process.env[key];
        changed = true;
      }
    }
    if (changed) {
      debugLogger.debug("Synced startup env vars", {
        set: Object.keys(setVars),
        cleared: clearVars.filter((k) => !process.env[k]),
      });
      // A swallowed .env write failure here left GPU enablement flags silently
      // out of sync with the packs on disk (#1340) — log which keys were lost.
      this.environmentManager.saveAllKeysToEnvFile().catch((err) => {
        debugLogger.error("Failed to persist startup env vars to .env", {
          set: Object.keys(setVars),
          clearRequested: clearVars,
          error: err.message,
        });
      });
    }
  }

  setupHandlers() {
    ipcMain.handle("onboarding-set-window-mode", (_event, mode) =>
      this.windowManager.setOnboardingWindowMode(mode)
    );

    ipcMain.handle("permission-guide-open", (event, state) =>
      this.windowManager.permissionGuide.open(event, state)
    );
    ipcMain.handle("permission-guide-close", (event) =>
      this.windowManager.permissionGuide.closeFromOwner(event)
    );
    ipcMain.handle("permission-guide-state", (event) =>
      this.windowManager.permissionGuide.stateFor(event)
    );
    ipcMain.on("permission-guide-action", (event, action) =>
      this.windowManager.permissionGuide.handleAction(event, action)
    );
    ipcMain.on("permission-guide-drag", (event, target) =>
      this.windowManager.permissionGuide.startDrag(event, target)
    );

    // WindowManager owns every teardown path for a demo (id-matched end,
    // onboarding-set-active(false), control panel closed); without this hook a
    // renderer crash mid-demo would leave the session set and broadcast every
    // later dictation's transcripts on onboarding-demo-event forever.
    this.windowManager.onOnboardingDemoTeardown = () => {
      this._onboardingDemoSession = null;
    };

    ipcMain.handle("onboarding-set-active", (_event, active) => {
      if (typeof active !== "boolean") return false;
      const result = this.windowManager.setOnboardingActive(active);
      // The dictation panel can show the GPU pack notice only once the normal
      // app is up: until then it stays hidden.
      const noticeWindow = this._gpuPackNoticeWindow();
      if (!active && noticeWindow && noticeWindow === this.windowManager.mainWindow) {
        noticeWindow.webContents.send("gpu-pack-migration-notice-ready");
      }
      return result;
    });

    ipcMain.handle("onboarding-demo-begin", (_event, session) => {
      if (
        !session ||
        typeof session.id !== "string" ||
        session.id.length > 128 ||
        !ONBOARDING_DEMO_KINDS.has(session.kind)
      ) {
        return false;
      }
      this._onboardingDemoSession = {
        id: session.id,
        kind: session.kind,
        startedAt: Date.now(),
      };
      return this.windowManager.beginOnboardingDemo(session.kind);
    });

    ipcMain.handle("onboarding-demo-end", (_event, id) => {
      if (this._onboardingDemoSession?.id === id) {
        // Session cleanup rides on the teardown hook above.
        this.windowManager.endOnboardingDemo();
      }
      return true;
    });

    ipcMain.handle("onboarding-demo-stop", (_event, id) => {
      if (this._onboardingDemoSession?.id !== id) return false;
      return this.windowManager.stopOnboardingDemoRecording();
    });

    ipcMain.handle("onboarding-demo-publish", (_event, event) => {
      const session = this._onboardingDemoSession;
      if (!session || !event || event.kind !== session.kind) return false;
      if (!ONBOARDING_DEMO_STATUSES.has(event.status)) return false;
      const text = typeof event.text === "string" ? event.text.slice(0, 20000) : undefined;
      const message = typeof event.message === "string" ? event.message.slice(0, 500) : undefined;
      const tool = typeof event.tool === "string" ? event.tool.slice(0, 64) : undefined;
      const level = Number.isFinite(event.level)
        ? Math.min(1, Math.max(0, event.level))
        : undefined;
      broadcastToWindows("onboarding-demo-event", {
        demoId: session.id,
        kind: session.kind,
        status: event.status,
        text,
        message,
        tool,
        level,
      });
      return true;
    });

    // Every panel showing the same credentials and model shares one answer.
    const cachedConnectionCheck = createConnectionCheckCache();
    ipcMain.handle("test-provider-connection", (_event, config) =>
      cachedConnectionCheck(config, () => testProviderConnection(config))
    );

    ipcMain.handle("list-remote-models", async (_event, config) => listRemoteModels(config));

    ipcMain.handle("window-minimize", () => {
      if (this.windowManager.controlPanelWindow) {
        this.windowManager.controlPanelWindow.minimize();
      }
    });

    ipcMain.handle("window-maximize", () => {
      if (this.windowManager.controlPanelWindow) {
        if (this.windowManager.controlPanelWindow.isMaximized()) {
          this.windowManager.controlPanelWindow.unmaximize();
        } else {
          this.windowManager.controlPanelWindow.maximize();
        }
      }
    });

    ipcMain.handle("window-close", () => {
      if (this.windowManager.controlPanelWindow) {
        this.windowManager.controlPanelWindow.close();
      }
    });

    ipcMain.handle("window-is-maximized", () => {
      if (this.windowManager.controlPanelWindow) {
        return this.windowManager.controlPanelWindow.isMaximized();
      }
      return false;
    });

    ipcMain.handle("snap-to-meeting-mode", () => {
      this.windowManager.snapControlPanelToMeetingMode();
    });

    ipcMain.handle("restore-from-meeting-mode", () => {
      this.windowManager.restoreControlPanelFromMeetingMode();
      this.meetingDetectionEngine?.setMeetingModeActive(false);
    });

    ipcMain.handle("hide-window", () => {
      this.windowManager.hideDictationPanel();
    });

    ipcMain.handle("show-dictation-panel", () => {
      this.windowManager.showDictationPanel({ reposition: true });
    });

    ipcMain.handle("open-settings-section", async (_event, section) => {
      if (!isProviderSettingsTarget(section)) return { success: false };
      await this.windowManager.openSettings(section);
      return { success: true };
    });

    ipcMain.handle("capture-dictation-target", async () => {
      // Recording start awaits this handler, so the Linux/Windows window probe
      // runs in the background: a stalled AT-SPI peer would otherwise hold the
      // microphone for seconds (#1944). Its consumers wait for it themselves.
      void this.selectionManager?.captureTarget?.();
      const pid = (await this.textEditMonitor?.captureTargetPid?.()) ?? null;
      return { success: true, pid };
    });

    // Tone & Style: which kind of app the dictation is going into. Runs while
    // the user speaks; only the category reaches the renderer.
    ipcMain.handle("capture-dictation-app-category", async () => {
      const context = await this.selectionManager?.getTargetAppContext?.();
      const category = classifyToneAppCategory(context);
      debugLogger.debug("Dictation app category", {
        category,
        hasWindowTitle: !!context?.windowTitle,
        hasUrlHost: !!context?.urlHost,
      });
      return category;
    });

    ipcMain.handle("force-stop-dictation", () => {
      if (this.windowManager?.forceStopMacCompoundPush) {
        this.windowManager.forceStopMacCompoundPush("manual");
      }
      return { success: true };
    });

    ipcMain.handle("set-main-window-interactivity", (event, shouldCapture) => {
      this.windowManager.setMainWindowInteractivity(Boolean(shouldCapture));
      return { success: true };
    });

    ipcMain.handle("set-main-window-input-region", (event, region) => {
      if (event.sender !== this.windowManager.mainWindow?.webContents) return null;
      return this.windowManager.setMainWindowInputRegion(region);
    });

    ipcMain.handle("get-main-window-horizontal-direction", () => {
      return this.windowManager.getMainWindowHorizontalDirection();
    });

    ipcMain.handle("set-notification-interactivity", (event, interactive) => {
      this.windowManager.setNotificationInteractivity(event.sender, Boolean(interactive));
      return { success: true };
    });

    ipcMain.handle("resize-main-window", (event, sizeKey) => {
      return this.windowManager.resizeMainWindow(sizeKey);
    });

    ipcMain.handle("resize-assistant-window-to-content", (event, surfaceHeight) => {
      return this.windowManager.resizeAssistantWindowToContent(surfaceHeight);
    });

    ipcMain.handle("resize-dictation-error-window-to-content", (event, surfaceHeight) => {
      return this.windowManager.resizeDictationErrorWindowToContent(surfaceHeight);
    });

    const saveSecretKey = (getter, saver, storeKey) => (event, key) => {
      if (typeof key !== "string") throw new TypeError("API key must be a string");
      // Committing an unedited key field saves the same value again.
      const changed = this.environmentManager[getter]() !== key;
      const result = this.environmentManager[saver](key);
      if (!changed) return result;
      // Notify peers by setting name only; leave the editor's pending input alone.
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed() && win.webContents.id !== event.sender.id) {
          win.webContents.send("api-key-updated", storeKey);
        }
      }
      return result;
    };

    for (const k of SCOPE_API_KEYS) {
      ipcMain.handle(`get-${k.base}-key`, () => this.environmentManager[k.get]());
      ipcMain.handle(`save-${k.base}-key`, saveSecretKey(k.get, k.save, k.storeKey));
    }

    ipcMain.handle("db-save-transcription", async (event, text, rawText, options) => {
      const result = this.databaseManager.saveTranscription(text, rawText, options);
      if (result?.success && result?.transcription) {
        setImmediate(() => {
          broadcastToWindows("transcription-added", result.transcription);
          if (result.transcription.status === "completed") {
            this.noteFilesSync.appendDictation(result.transcription.text);
          }
        });
      }
      return result;
    });

    ipcMain.handle("db-get-transcriptions", async (event, limit = 50, options = {}) => {
      return this.databaseManager.getTranscriptions(limit, options);
    });

    ipcMain.handle("analytics-record-event", async (_event, input) => {
      // The renderer only warns when this write fails, then saves the
      // transcription as completed anyway -- leaving a row the backfill is
      // the only thing that will ever reconcile.
      const result = this.databaseManager.recordAnalyticsEvent(input);
      // Dictation and the control panel are separate renderers, so the
      // Insights view can only learn about a new event through the main process.
      if (result?.success && !result.ignored) {
        setImmediate(() => {
          broadcastToWindows("analytics-changed");
        });
      }
      return result;
    });

    ipcMain.handle("analytics-get-summary", async () => {
      await this._ensureAnalyticsHistoryBackfilled();
      return this.databaseManager.getAnalyticsSummary();
    });

    ipcMain.handle("db-clear-transcriptions", async (event) => {
      this.audioStorageManager.deleteAllAudio();
      const result = this.databaseManager.clearTranscriptions();
      if (result?.success) {
        setImmediate(() => {
          broadcastToWindows("transcriptions-cleared", {
            cleared: result.cleared,
          });
          broadcastToWindows("analytics-changed");
        });
      }
      return result;
    });

    ipcMain.handle("db-delete-transcription", async (event, id) => {
      return this.deleteTranscriptionInternal(id);
    });

    // Audio storage handlers
    ipcMain.handle("save-transcription-audio", async (event, id, audioBuffer, metadata) => {
      const transcription = this.databaseManager.getTranscriptionById(id);
      const timestamp = transcription?.timestamp || null;
      const result = this.audioStorageManager.saveAudio(id, Buffer.from(audioBuffer), timestamp);
      if (result.success) {
        this.databaseManager.updateTranscriptionAudio(id, {
          hasAudio: 1,
          audioDurationMs: metadata?.durationMs || null,
          provider: metadata?.provider || null,
          model: metadata?.model || null,
        });
        const updated = this.databaseManager.getTranscriptionById(id);
        if (updated) broadcastToWindows("transcription-updated", updated);
      }
      return result;
    });

    ipcMain.handle("merge-audio-segments", async (_event, segments) => {
      try {
        if (!Array.isArray(segments) || segments.length < 2 || segments.length > 100) {
          throw new Error("Invalid audio segment count");
        }
        const normalized = segments.map((segment) => {
          if (!segment?.buffer || typeof segment.mimeType !== "string") {
            throw new Error("Invalid audio segment");
          }
          return { buffer: Buffer.from(segment.buffer), mimeType: segment.mimeType };
        });
        const { mergeAudioSegments } = require("./ffmpegUtils");
        const buffer = await mergeAudioSegments(normalized);
        // Slice to a real ArrayBuffer: Buffers sent over IPC arrive as Uint8Array,
        // and pooled Buffers share a larger underlying allocation.
        return {
          success: true,
          buffer: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
          mimeType: "audio/webm",
        };
      } catch (error) {
        debugLogger.error("Failed to merge recovered audio segments", { error: error.message });
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("get-audio-path", async (event, id) => {
      return this.audioStorageManager.getAudioPath(id);
    });

    ipcMain.handle("show-audio-in-folder", async (event, id) => {
      const filePath = this.audioStorageManager.getAudioPath(id);
      if (!filePath) return { success: false };
      shell.showItemInFolder(filePath);
      return { success: true };
    });

    ipcMain.handle("get-audio-buffer", async (event, id) => {
      const buffer = this.audioStorageManager.getAudioBuffer(id);
      return buffer ? buffer.buffer : null;
    });

    ipcMain.handle("delete-transcription-audio", async (event, id) => {
      const result = this.audioStorageManager.deleteAudio(id);
      if (result.success) {
        this.databaseManager.updateTranscriptionAudio(id, {
          hasAudio: 0,
          audioDurationMs: null,
          provider: null,
          model: null,
        });
      }
      return result;
    });

    ipcMain.handle("get-audio-storage-usage", async () => {
      const dictation = this.audioStorageManager.getStorageUsage();
      const meetings = await getMeetingAudioUsage();
      return {
        fileCount: dictation.fileCount + meetings.fileCount,
        totalBytes: dictation.totalBytes + meetings.totalBytes,
      };
    });

    ipcMain.on(
      "retention-settings-changed",
      createRetentionSettingsHandler({
        getCurrentSettings: () => this._retentionSettings,
        getOwner: () => this.windowManager.mainWindow?.webContents,
        hasSynced: () => this._retentionSettingsSynced,
        onSettingsChanged: (settings) => {
          this._retentionSettings = settings;
          this._retentionSettingsSynced = true;
          this._runRetentionCleanup();
          // First point at which the local-history switch is known to be real.
          // After the sweep, so expired transcripts are gone before they can be
          // reconstructed into counters the sweep would only have to purge.
          void this._ensureAnalyticsHistoryBackfilled();
        },
      })
    );

    ipcMain.handle("delete-all-audio", async () => {
      const result = this.audioStorageManager.deleteAllAudio();
      result.deleted += await deleteAllMeetingAudio();
      try {
        const rows = this.databaseManager.db
          .prepare("SELECT id FROM transcriptions WHERE has_audio = 1")
          .all();
        if (rows.length > 0) {
          this.databaseManager.clearAudioFlags(rows.map((r) => r.id));
        }
      } catch (error) {
        debugLogger.error(
          "Failed to clear audio flags after delete-all",
          { error: error.message },
          "audio-storage"
        );
      }
      return result;
    });

    ipcMain.handle("get-transcription-by-id", async (event, id) => {
      return this.databaseManager.getTranscriptionById(id);
    });

    // Every window's AudioManager can hold the mic open outside a recording, so
    // gate the audio-evidence meeting detector until they all release. A
    // renderer that reloads or goes away releases implicitly — otherwise a
    // crash mid-hold would gate detection for the rest of the session.
    ipcMain.on("mic-warm-hold-changed", (event, active) => {
      if (!active) {
        this._releaseMicHold(event.sender);
        return;
      }
      if (this._micHoldSenders.has(event.sender.id)) return;
      const release = () => this._releaseMicHold(event.sender);
      this._micHoldSenders.set(event.sender.id, release);
      event.sender.on("destroyed", release);
      event.sender.on("did-finish-load", release);
      this.meetingDetectionEngine?.setMicWarmHold(true);
    });

    // Hotkey handlers run in main, while AudioManager owns the real lifecycle
    // in the dictation renderer. Only confirmed renderer state may change the
    // main-process recording gate; raw key presses are merely requests and can
    // be declined while a transcript is still being finalized.
    ipcMain.on("dictation-lifecycle-state-changed", (event, state, inputKind) => {
      const dictationWindow = this.windowManager.mainWindow;
      if (
        !dictationWindow ||
        dictationWindow.isDestroyed() ||
        event.sender !== dictationWindow.webContents
      ) {
        return;
      }
      this.windowManager.setDictationLifecycleState(state, inputKind);
    });

    ipcMain.on("show-agent-dictation-final-transcript", (event, text) => {
      const dictationWindow = this.windowManager.mainWindow;
      if (
        !dictationWindow ||
        dictationWindow.isDestroyed() ||
        event.sender !== dictationWindow.webContents
      ) {
        return;
      }
      if (typeof text !== "string" || !text.trim()) return;
      this.windowManager.showAgentDictationFinalTranscript(text);
    });

    ipcMain.on("dictation-audio-level-changed", (event, level) => {
      const dictationWindow = this.windowManager.mainWindow;
      if (
        !dictationWindow ||
        dictationWindow.isDestroyed() ||
        event.sender !== dictationWindow.webContents
      ) {
        return;
      }
      this.windowManager.setDictationAudioLevel(level);
    });

    // Dictionary handlers
    ipcMain.on("auto-learn-changed", (_event, enabled) => {
      // Both renderer windows re-sync this on mount — ignore same-value updates (#1080).
      const { changed, enabled: next } = applyAutoLearnSetting(this._autoLearnEnabled, enabled);
      if (!changed) return;
      this._autoLearnEnabled = next;
      if (!this._autoLearnEnabled) {
        if (this._autoLearnDebounceTimer) {
          clearTimeout(this._autoLearnDebounceTimer);
          this._autoLearnDebounceTimer = null;
        }
        this._autoLearnLatestData = null;
      }
      debugLogger.debug("[AutoLearn] Setting changed", { enabled: this._autoLearnEnabled });
    });

    ipcMain.handle("db-get-dictionary", async () => {
      return this.databaseManager.getDictionary();
    });

    ipcMain.handle("db-set-dictionary", async (event, words) => {
      if (!Array.isArray(words)) {
        throw new Error("words must be an array");
      }
      return this.databaseManager.setDictionary(words);
    });

    ipcMain.handle("db-apply-dictionary-changes", async (_event, changes) => {
      const { add, remove } = changes ?? {};
      if (add !== undefined && !Array.isArray(add)) {
        throw new Error("add must be an array");
      }
      if (remove !== undefined && !Array.isArray(remove)) {
        throw new Error("remove must be an array");
      }
      return this.databaseManager.applyDictionaryChanges({ add, remove });
    });

    ipcMain.handle("db-get-snippets", async () => {
      return this.databaseManager.getSnippets();
    });

    ipcMain.handle("db-set-snippets", async (_event, snippets) => {
      if (!Array.isArray(snippets)) {
        throw new Error("snippets must be an array");
      }
      return this.databaseManager.setSnippets(snippets);
    });

    ipcMain.handle("undo-learned-corrections", async (_event, words) => {
      try {
        if (!Array.isArray(words) || words.length === 0) {
          return { success: false };
        }
        const validWords = words.filter((w) => typeof w === "string" && w.trim().length > 0);
        if (validWords.length === 0) {
          return { success: false };
        }
        const saveResult = this.databaseManager.applyDictionaryChanges({ remove: validWords });
        if (saveResult?.success === false) {
          debugLogger.debug("[AutoLearn] Undo failed to save dictionary", {
            error: saveResult.error,
          });
          return { success: false };
        }
        broadcastToWindows("dictionary-updated", this.databaseManager.getDictionary());
        debugLogger.debug("[AutoLearn] Undo: removed words", { words: validWords });
        return { success: true };
      } catch (err) {
        debugLogger.debug("[AutoLearn] Undo failed", { error: err.message });
        return { success: false };
      }
    });

    ipcMain.handle(
      "db-save-note",
      async (event, title, content, noteType, sourceFile, audioDuration, folderId, spaceId) => {
        const result = this.databaseManager.saveNote(
          title,
          content,
          noteType,
          sourceFile,
          audioDuration,
          folderId,
          spaceId
        );
        if (result?.success && result?.note) {
          setImmediate(() => broadcastToWindows("note-added", result.note));
          this.notifyVectorChanges();
        }
        return result;
      }
    );

    ipcMain.handle("db-get-note", async (event, id) => {
      return this.databaseManager.getNote(id);
    });

    ipcMain.handle("db-get-notes", async (event, noteType, limit, folderId, spaceId) => {
      return this.databaseManager.getNotes(noteType, limit, folderId, spaceId);
    });

    ipcMain.handle("db-get-space-notes", async (event, spaceId, limit) => {
      return this.databaseManager.getNotesForSpace(spaceId, limit);
    });

    ipcMain.handle("db-get-note-undos", () => this.databaseManager.getNoteUndos());
    ipcMain.handle("db-claim-note-undo", (_event, token) =>
      this.databaseManager.claimNoteUndo(token)
    );
    ipcMain.handle("db-discard-note-undo", (_event, id, token) =>
      this.databaseManager.discardNoteUndo(id, token)
    );
    ipcMain.handle("db-undo-note-update", (_event, token) => {
      const result = this.databaseManager.undoNoteUpdate(token);
      if (result?.success && result?.note) {
        setImmediate(() => broadcastToWindows("note-updated", result.note));
        this.notifyVectorChanges();
        this._asyncMirrorWrite(result.note);
      }
      return result;
    });

    ipcMain.handle("db-update-note", async (event, id, updates, options) => {
      const result = this.databaseManager.updateNote(id, updates, options);
      if (result?.success && result?.note) {
        setImmediate(() => broadcastToWindows("note-updated", result.note));
        this.notifyVectorChanges();
        if (updates.participants) {
          this._tryAutoLabelOneOnOne(id);
          this._refreshMeetingSpeakerConfigFromNote(id, result.note);
        }
      }
      return result;
    });

    ipcMain.handle("db-delete-note", async (event, id) => {
      return this.deleteNoteInternal(id);
    });

    ipcMain.handle("db-search-notes", async (event, query, limit, spaceId, folderId) => {
      return this.databaseManager.searchNotes(query, limit, spaceId, folderId);
    });

    ipcMain.handle(
      "db-semantic-search-notes",
      async (event, query, limit = 5, spaceId, folderId) => {
        try {
          // Qdrant payload updates are best-effort. Use its space filter to
          // reduce the candidate set, then validate every scoped vector hit
          // against SQLite before it can enter the fused ranking.
          const overFetch = folderId != null ? limit * 4 : limit * 2;
          const vectorFilter =
            spaceId != null
              ? { must: [{ key: "space_id", match: { value: spaceId } }] }
              : undefined;
          const [ftsResults, vectorResults] = await Promise.all([
            this.databaseManager.searchNotes(query, overFetch, spaceId, folderId),
            this.getSemanticSearch?.()?.search(query, overFetch, vectorFilter),
          ]);
          if (vectorResults == null) return ftsResults.slice(0, limit);
          const scopedIds = new Set(
            this.databaseManager.getNoteIdsInScope(
              spaceId,
              folderId,
              vectorResults.map(({ noteId }) => noteId)
            )
          );

          // Filter low-confidence semantic matches before RRF
          const filteredVectorResults = vectorResults.filter(
            ({ noteId, score }) => score > 0.3 && scopedIds.has(noteId)
          );

          // Reciprocal Rank Fusion (K=60)
          const scores = new Map();
          ftsResults.forEach((note, i) => {
            scores.set(note.id, (scores.get(note.id) || 0) + 1 / (60 + i));
          });
          filteredVectorResults.forEach(({ noteId }, i) => {
            scores.set(noteId, (scores.get(noteId) || 0) + 1 / (60 + i));
          });

          const rankedIds = [...scores.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, limit)
            .map(([id]) => id);

          const noteMap = new Map();
          ftsResults.forEach((n) => noteMap.set(n.id, n));
          for (const id of rankedIds) {
            if (!noteMap.has(id)) {
              const note = this.databaseManager.getNote(id);
              if (note) noteMap.set(id, note);
            }
          }

          return rankedIds.map((id) => noteMap.get(id)).filter(Boolean);
        } catch (error) {
          debugLogger.error("Semantic search failed, falling back to FTS5", {
            error: error.message,
          });
          return this.databaseManager.searchNotes(query, limit, spaceId, folderId);
        }
      }
    );

    ipcMain.handle("db-get-folders", async (event, spaceId) => {
      return this.databaseManager.getFolders(spaceId);
    });

    ipcMain.handle("db-create-folder", (_event, name, spaceId) =>
      this.createFolderWithEffects(name, spaceId)
    );

    ipcMain.handle("db-delete-folder", async (event, id) => {
      const result = this.databaseManager.deleteFolder(id);
      if (result?.success) {
        this.notifyVectorChanges();
        setImmediate(() => broadcastToWindows("folder-deleted", { id }));
      }
      return result;
    });

    ipcMain.handle("db-rename-folder", async (event, id, name) => {
      const result = this.databaseManager.renameFolder(id, name);
      if (result?.success && result?.folder) {
        setImmediate(() => broadcastToWindows("folder-renamed", result.folder));
      }
      return result;
    });

    ipcMain.handle("db-get-folder-note-counts", async () => {
      return this.databaseManager.getFolderNoteCounts();
    });

    ipcMain.handle("db-get-spaces", async () => {
      return this.databaseManager.getSpaces();
    });

    ipcMain.handle("db-get-actions", async () => {
      return this.databaseManager.getActions();
    });

    ipcMain.handle("db-get-action", async (event, id) => {
      return this.databaseManager.getAction(id);
    });

    ipcMain.handle("db-create-action", async (event, name, description, prompt, icon, fields) => {
      const result = this.databaseManager.createAction(name, description, prompt, icon, fields);
      if (result?.success && result?.action) {
        setImmediate(() => {
          broadcastToWindows("action-created", result.action);
        });
      }
      return result;
    });

    ipcMain.handle("db-update-action", async (event, id, updates) => {
      const result = this.databaseManager.updateAction(id, updates);
      if (result?.success && result?.action) {
        setImmediate(() => {
          broadcastToWindows("action-updated", result.action);
        });
      }
      return result;
    });

    ipcMain.handle("db-delete-action", async (event, id) => {
      const result = this.databaseManager.deleteAction(id);
      if (result?.success) {
        setImmediate(() => {
          broadcastToWindows("action-deleted", { id });
        });
      }
      return result;
    });

    // Agent conversation handlers
    ipcMain.handle(
      "db-create-agent-conversation",
      async (event, title, noteId, spaceId, folderId) => {
        return this.databaseManager.createAgentConversation(title, noteId, spaceId, folderId);
      }
    );

    ipcMain.handle("db-get-conversations-for-note", async (event, noteId, limit) => {
      return this.databaseManager.getConversationsForNote(noteId, limit);
    });

    ipcMain.handle(
      "db-get-conversations-for-container",
      async (event, spaceId, folderId, limit) => {
        return this.databaseManager.getConversationsForContainer(spaceId, folderId, limit);
      }
    );

    ipcMain.handle("db-get-agent-conversations", async (event, limit) => {
      return this.databaseManager.getAgentConversations(limit);
    });

    ipcMain.handle("db-get-agent-conversation", async (event, id) => {
      return this.databaseManager.getAgentConversation(id);
    });

    ipcMain.handle("db-delete-agent-conversation", async (event, id) => {
      const result = this.databaseManager.deleteAgentConversation(id);
      if (this.vectorIndex?.isReady?.()) {
        this.vectorIndex.deleteConversationChunks(id).catch(() => {});
      }
      return result;
    });

    ipcMain.handle("db-update-agent-conversation-title", async (event, id, title) => {
      return this.databaseManager.updateAgentConversationTitle(id, title);
    });

    ipcMain.handle(
      "db-add-agent-message",
      async (event, conversationId, role, content, metadata) => {
        const result = this.databaseManager.addAgentMessage(
          conversationId,
          role,
          content,
          metadata
        );
        if (result && this.vectorIndex?.isReady?.()) {
          const conv = this.databaseManager.getAgentConversation(conversationId);
          if (conv && conv.messages?.length % 3 === 0) {
            this.vectorIndex
              .upsertConversationChunks(conversationId, conv.title, conv.messages)
              .catch(() => {});
          }
        }
        return result;
      }
    );

    ipcMain.handle("db-get-agent-messages", async (event, conversationId) => {
      return this.databaseManager.getAgentMessages(conversationId);
    });

    ipcMain.handle(
      "db-get-agent-conversations-with-preview",
      async (event, limit, offset, includeArchived) => {
        return this.databaseManager.getAgentConversationsWithPreview(
          limit,
          offset,
          includeArchived
        );
      }
    );

    ipcMain.handle("db-search-agent-conversations", async (event, query, limit) => {
      return this.databaseManager.searchAgentConversations(query, limit);
    });

    ipcMain.handle("db-archive-agent-conversation", async (event, id) => {
      return this.databaseManager.archiveAgentConversation(id);
    });

    ipcMain.handle("db-unarchive-agent-conversation", async (event, id) => {
      return this.databaseManager.unarchiveAgentConversation(id);
    });

    ipcMain.handle("db-semantic-search-conversations", async (event, query, limit) => {
      if (this.vectorIndex?.isReady?.()) {
        try {
          const vectorResults = await this.vectorIndex.searchConversations(query, limit);
          if (vectorResults?.length > 0) {
            const ids = vectorResults.map((r) => r.conversationId);
            const previews = ids
              .map((id) => this.databaseManager.getAgentConversation(id))
              .filter(Boolean)
              .map((c) => ({
                ...c,
                message_count: c.messages?.length ?? 0,
                last_message: c.messages?.[c.messages.length - 1]?.content,
              }));
            if (previews.length > 0) return previews;
          }
        } catch {
          // fall through to keyword search
        }
      }
      return this.databaseManager.searchAgentConversations(query, limit);
    });

    ipcMain.handle("export-note", async (event, noteId, format) => {
      try {
        const note = this.databaseManager.getNote(noteId);
        if (!note) return { success: false, error: "Note not found" };

        const { dialog } = require("electron");
        const fs = require("fs");
        const exportFormat =
          format === "txt"
            ? { name: "Text", extension: "txt" }
            : { name: "Markdown", extension: "md" };
        const safeName = (note.title || "Untitled").replace(/[/\\?%*:|"<>]/g, "-");

        const result = await dialog.showSaveDialog({
          defaultPath: `${safeName}.${exportFormat.extension}`,
          filters: [{ name: exportFormat.name, extensions: [exportFormat.extension] }],
        });

        if (result.canceled || !result.filePath) return { success: false };

        let exportContent;
        if (format === "txt") {
          const { markdownToPlainText } = await import("./markdownToPlainText.ts");
          exportContent = markdownToPlainText(note.content || "");
        } else {
          exportContent = note.enhanced_content || note.content;
        }

        fs.writeFileSync(result.filePath, exportContent, "utf-8");
        return { success: true };
      } catch (error) {
        debugLogger.error("Error exporting note", { error: error.message }, "notes");
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("export-transcript", async (event, noteId, format) => {
      try {
        const note = this.databaseManager.getNote(noteId);
        if (!note) return { success: false, error: "Note not found" };

        const segments = JSON.parse(note.transcript || "[]");
        if (!segments.length) return { success: false, error: "No transcript available" };

        const speakerMappings = this._buildSpeakerMappings(noteId);

        const { dialog } = require("electron");
        const fs = require("fs");
        const exportFormats = {
          txt: { name: "Text", extension: "txt" },
          srt: { name: "SubRip Subtitles", extension: "srt" },
          json: { name: "JSON", extension: "json" },
          md: { name: "Markdown", extension: "md" },
        };
        const exportFormat = exportFormats[format] || exportFormats.txt;
        const safeName = (note.title || "Untitled").replace(/[/\\?%*:|"<>]/g, "-");

        const result = await dialog.showSaveDialog({
          defaultPath: `${safeName}.${exportFormat.extension}`,
          filters: [{ name: exportFormat.name, extensions: [exportFormat.extension] }],
        });

        if (result.canceled || !result.filePath) return { success: false };

        const transcriptFormatter = require("./transcriptFormatter");
        let exportContent;
        if (format === "txt") {
          exportContent = transcriptFormatter.formatTxt(note, segments, speakerMappings);
        } else if (format === "srt") {
          exportContent = transcriptFormatter.formatSrt(segments, speakerMappings, note);
        } else if (format === "md") {
          exportContent = transcriptFormatter.formatMd(note, segments, speakerMappings);
        } else {
          exportContent = transcriptFormatter.formatJson(note, segments, speakerMappings);
        }

        fs.writeFileSync(result.filePath, exportContent, "utf-8");
        return { success: true };
      } catch (error) {
        debugLogger.error("Error exporting transcript", { error: error.message }, "notes");
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("export-dictionary", async (event, words) => {
      try {
        const { dialog } = require("electron");
        const fs = require("fs");

        const result = await dialog.showSaveDialog({
          defaultPath: "dictionary.txt",
          filters: [{ name: "Text", extensions: ["txt"] }],
        });

        if (result.canceled || !result.filePath) return { success: false };

        fs.writeFileSync(result.filePath, words.join("\n"), "utf-8");
        return { success: true };
      } catch (error) {
        debugLogger.error("Error exporting dictionary", { error: error.message }, "dictionary");
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("select-audio-file", async (event, options = {}) => {
      const { dialog } = require("electron");
      const properties = ["openFile"];
      if (options.multiple === true) properties.push("multiSelections");
      const result = await dialog.showOpenDialog({
        properties,
        filters: [{ name: "Audio and Video Files", extensions: UPLOAD_AUDIO_EXTENSIONS }],
      });
      if (result.canceled || !result.filePaths.length) {
        return { canceled: true };
      }
      result.filePaths.forEach(approveAudioPath);
      if (options.multiple === true) {
        return { canceled: false, filePaths: result.filePaths };
      }
      return { canceled: false, filePath: result.filePaths[0] };
    });

    // Fired by the preload's getPathForFile for real drag-dropped files; a
    // renderer-constructed File yields "" there, so this can't be forged.
    ipcMain.on("approve-audio-path", (_event, filePath) => {
      approveAudioPath(filePath);
    });

    ipcMain.handle("get-file-size", async (_event, filePath) => {
      const fs = require("fs");
      try {
        if (typeof filePath !== "string") return 0;
        const real = resolveAllowedAudioPath(filePath);
        if (!real) return 0;
        const stats = fs.statSync(real);
        return stats.size;
      } catch {
        return 0;
      }
    });

    const activeUrlDownloads = new Map();
    let urlDownloadSeq = 0;

    // Sweep ow-url-*/ow-diarize-* orphans from crashes or windows closed mid-download.
    require("./urlAudioDownloader").sweepStaleTempArtifacts();

    ipcMain.handle("download-url-audio", async (event, url, downloadId) => {
      if (typeof url !== "string" || url.length > 2048) {
        return { success: false, error: "Invalid URL", code: "INVALID_URL" };
      }
      const { download } = require("./urlAudioDownloader");

      const id =
        typeof downloadId === "string" && downloadId ? downloadId : `dl-${++urlDownloadSeq}`;
      const abortController = new AbortController();
      activeUrlDownloads.set(id, abortController);

      try {
        const result = await download(
          url,
          (progress) => {
            if (!event.sender.isDestroyed()) {
              event.sender.send("url-download-progress", { ...progress, downloadId: id });
            }
          },
          abortController.signal
        );
        return { success: true, ...result };
      } catch (error) {
        debugLogger.error("URL audio download error", { error: error.message, code: error.code });
        return { success: false, error: error.message, code: error.code || "DOWNLOAD_FAILED" };
      } finally {
        if (activeUrlDownloads.get(id) === abortController) {
          activeUrlDownloads.delete(id);
        }
      }
    });

    // With an id, cancels that download; without, cancels all (unmount cleanup).
    ipcMain.handle("cancel-url-download", async (_event, downloadId) => {
      if (typeof downloadId === "string" && downloadId) {
        const controller = activeUrlDownloads.get(downloadId);
        if (!controller) return { success: false };
        controller.abort();
        activeUrlDownloads.delete(downloadId);
        return { success: true };
      }
      if (activeUrlDownloads.size === 0) return { success: false };
      for (const controller of activeUrlDownloads.values()) controller.abort();
      activeUrlDownloads.clear();
      return { success: true };
    });

    ipcMain.handle("delete-temp-file", async (event, filePath) => {
      try {
        if (typeof filePath !== "string") {
          return { success: false, error: "Invalid file path" };
        }
        const { getSafeTempDir } = require("./safeTempDir");
        const resolved = path.resolve(filePath);
        const basename = path.basename(resolved);
        if (!basename.startsWith("ow-url-") && !basename.startsWith("ow-diarize-")) {
          return { success: false, error: "Not an OpenWhispr temp file" };
        }
        const real = fs.realpathSync(resolved);
        let tempDir = getSafeTempDir();
        try {
          tempDir = fs.realpathSync(tempDir);
        } catch {}
        const rel = path.relative(tempDir, real);
        if (rel.startsWith("..") || path.isAbsolute(rel)) {
          return { success: false, error: "Not an OpenWhispr temp file" };
        }
        fs.unlinkSync(real);
        return { success: true };
      } catch (error) {
        debugLogger.warn("Failed to delete temp file", { error: error.message });
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("transcribe-audio-file", async (event, filePath, options = {}) => {
      // Uploads pass a requestId so cancel-upload-transcription can abort the
      // local decode; flows without one (voice drafts) register nothing.
      const { signal, release } = this._uploadCancelRegistry.register(options.requestId);
      try {
        if (typeof filePath !== "string") {
          return { success: false, error: "Invalid file path" };
        }
        const real = resolveAllowedAudioPath(filePath);
        if (!real) return { success: false, error: "File path not allowed" };
        return await this.transcribeLocalFile(real, { ...options, signal });
      } catch (error) {
        if (error?.name === "AbortError" || signal?.aborted) {
          debugLogger.debug("Local audio file transcription cancelled", {
            requestId: options.requestId,
          });
          return { success: false, error: "Cancelled", code: "UPLOAD_CANCELLED" };
        }
        debugLogger.error("Audio file transcription error", { error: error.message });
        return { success: false, error: error.message };
      } finally {
        release();
      }
    });

    ipcMain.handle("capture-selected-text", async (event, options = {}) => {
      if (!this.selectionManager) {
        return { status: "unavailable", code: "selection_manager_unavailable" };
      }
      return this.selectionManager.captureSelectedText({
        probeEditable: options.probeEditable === true,
      });
    });

    ipcMain.handle("replace-selected-text", async (event, sessionId, text, options = {}) => {
      if (!this.selectionManager) {
        return { success: false, code: "selection_manager_unavailable" };
      }
      return this.selectionManager.replaceSelectedText(sessionId, text, {
        restoreClipboard: options.restoreClipboard !== false,
        allowClipboardFallback: options.allowClipboardFallback === true,
        webContents: event.sender,
      });
    });

    ipcMain.handle("paste-at-captured-target", async (event, sessionId, text, options = {}) => {
      if (!this.selectionManager) {
        return { success: false, code: "selection_manager_unavailable" };
      }
      return this.selectionManager.pasteAtCapturedTarget(sessionId, text, {
        restoreClipboard: options.restoreClipboard !== false,
        allowClipboardFallback: options.allowClipboardFallback === true,
        webContents: event.sender,
      });
    });

    ipcMain.handle("paste-text", async (event, text, options) => {
      // An onboarding demo already puts the transcript in its own textarea from
      // the demo event, and that textarea is what has focus — pasting on top of
      // it appends the same sentence a second time. This is a successful no-op,
      // not a completed paste, so callers can avoid reporting paste-dependent
      // fallbacks as if text reached another application.
      if (this.windowManager?.isOnboardingDemoActive()) {
        return { success: true, pasted: false };
      }

      const mainWindow = this.windowManager?.mainWindow;
      const targetPid = this.textEditMonitor?.lastTargetPid || null;

      // Activating the target by PID is more reliable than hide()'s implicit
      // focus hand-off for Chromium apps like Claude desktop and Brave (#668).
      let activated = false;
      if (process.platform === "darwin" && this.textEditMonitor) {
        activated = await this.textEditMonitor.activateTargetPid();
      }

      if (!activated && mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused()) {
        if (process.platform === "darwin") {
          mainWindow.hide();
          await new Promise((resolve) => setTimeout(resolve, 120));
          mainWindow.showInactive();
        } else {
          mainWindow.blur();
          // On Linux blur() leaves X focus on the pill, where the assistant panel
          // took it, so the paste would land in the panel.
          if (process.platform === "linux") this.windowManager.returnLinuxKeyboardFocus();
          await new Promise((resolve) => setTimeout(resolve, 80));
        }
      }

      // Smart spacing (#856): append a trailing space so the next paste's leading
      // space self-corrects the gap. Reading the char before the cursor to space
      // the front instead would take a macOS Accessibility read costing hundreds
      // of ms — too slow for the paste hot path.
      const textToPaste = applySmartSpacing(text);

      // Windows: restore the foreground window captured at record start so the
      // paste lands in the field the user was dictating into, not wherever focus
      // drifted during transcription (#859). macOS handles this via
      // activateTargetPid above; Linux re-detects the target inside pasteLinux.
      const winTarget =
        process.platform === "win32"
          ? ((await this.selectionManager?.getWinTarget?.()) ?? null)
          : null;
      const targetWindow =
        winTarget &&
        isRestorablePasteTarget({
          target: winTarget,
          ownExeName: path.basename(process.execPath),
          ownWindowHandles: BrowserWindow.getAllWindows()
            .filter((win) => !win.isDestroyed())
            .map((win) => win.getNativeWindowHandle()),
        })
          ? winTarget.id
          : null;

      let pasteResult;
      try {
        pasteResult = await this.clipboardManager.pasteText(textToPaste, {
          ...options,
          webContents: event.sender,
          targetWindow,
          silentAccessibilityCheck: true,
        });
      } catch (error) {
        if (error?.code !== "ACCESSIBILITY_PERMISSION_REQUIRED" || error.clipboardCopied !== true) {
          throw error;
        }
        return {
          success: false,
          pasted: false,
          code: "ACCESSIBILITY_PERMISSION_REQUIRED",
          clipboardCopied: true,
        };
      }
      const pasted = pasteResult?.pasted !== false;
      debugLogger.debug("[AutoLearn] Paste completed", {
        autoLearnEnabled: this._autoLearnEnabled,
        hasMonitor: !!this.textEditMonitor,
        targetPid,
        pasted,
      });
      if (pasted && this.textEditMonitor && this._autoLearnEnabled) {
        setTimeout(() => {
          try {
            debugLogger.debug("[AutoLearn] Starting monitoring", {
              textPreview: text.substring(0, 80),
            });
            this.textEditMonitor.startMonitoring(text, 30000, { targetPid });
          } catch (err) {
            debugLogger.debug("[AutoLearn] Failed to start monitoring", { error: err.message });
          }
        }, 500);
      }
      // ClipboardManager returns `restoreComplete` so main-process callers can
      // serialize subsequent clipboard work behind its delayed restore. A
      // Promise cannot cross Electron's IPC boundary, though, and renderer
      // callers need to know whether text was pasted, but not the delayed
      // clipboard restoration promise. Successful platform paths predate the
      // explicit `pasted` outcome; only the clipboard-only fallback and a held-back
      // paste (held modifiers or a missing or failed wl-copy, which carries a `reason`) set false.
      return {
        success: true,
        pasted,
        ...(pasteResult?.reason ? { reason: pasteResult.reason } : {}),
      };
    });

    ipcMain.handle("check-accessibility-permission", async (_event, silent = false) => {
      return this.clipboardManager.checkAccessibilityPermissions(silent);
    });

    // Passes `true` to isTrustedAccessibilityClient to trigger the macOS system prompt
    ipcMain.handle("prompt-accessibility-permission", async () => {
      if (process.platform !== "darwin") return true;
      return systemPreferences.isTrustedAccessibilityClient(true);
    });

    ipcMain.handle("read-clipboard", async (event) => {
      return this.clipboardManager.readClipboard();
    });

    ipcMain.handle("write-clipboard", async (event, text) => {
      return this.clipboardManager.writeClipboard(text, event.sender);
    });

    ipcMain.handle("check-paste-tools", async () => {
      return this.clipboardManager.checkPasteTools();
    });

    // Voice drafts (chat input): persist a recorded buffer so the file-based
    // transcription pipeline (all providers) can consume it, then delete it.
    ipcMain.handle("save-temp-audio", async (_event, buffer) => {
      const tempPath = path.join(
        os.tmpdir(),
        `ow-voice-draft-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.webm`
      );
      fs.writeFileSync(tempPath, Buffer.from(buffer));
      return { success: true, path: tempPath };
    });

    ipcMain.handle("delete-temp-audio", async (_event, tempPath) => {
      // Only files this handler family created are deletable.
      const resolved = path.resolve(tempPath);
      const validPrefix = path.join(os.tmpdir(), "ow-voice-draft-");
      if (!resolved.startsWith(validPrefix)) {
        return { success: false, error: "Invalid temp path" };
      }
      try {
        fs.unlinkSync(resolved);
      } catch {
        // Already gone — fine.
      }
      return { success: true };
    });

    ipcMain.handle("transcribe-local-whisper", async (_event, audioBlob, options = {}) => {
      debugLogger.log("transcribe-local-whisper called", {
        audioBlobType: typeof audioBlob,
        audioBlobSize: audioBlob?.byteLength || audioBlob?.length || 0,
        options,
      });

      try {
        // skipVad: dictionary-echo rescue retries decode VAD-free, since VAD
        // stripping the speech is what turned the transcript into prompt echo.
        const { skipVad, ...requestOptions } = options;
        const vadOptions = skipVad
          ? { vadEnabled: false }
          : this._resolveWhisperVadOptions("dictation");
        const result = await this.whisperManager.transcribeLocalWhisper(audioBlob, {
          ...requestOptions,
          ...vadOptions,
        });

        debugLogger.log("Whisper result", {
          success: result.success,
          hasText: !!result.text,
          message: result.message,
          error: result.error,
        });

        return result;
      } catch (error) {
        debugLogger.error("Local Whisper transcription error", error);
        const errorMessage = error.message || "Unknown error";

        // Return specific error types for better user feedback
        if (errorMessage.includes("FFmpeg not found")) {
          return {
            success: false,
            error: "ffmpeg_not_found",
            message: "FFmpeg is missing. Please reinstall the app or install FFmpeg manually.",
          };
        }
        if (
          errorMessage.includes("FFmpeg conversion failed") ||
          errorMessage.includes("FFmpeg process error")
        ) {
          return {
            success: false,
            error: "ffmpeg_error",
            message: "Audio conversion failed. The recording may be corrupted.",
          };
        }
        if (
          errorMessage.includes("whisper.cpp not found") ||
          errorMessage.includes("whisper-cpp")
        ) {
          return {
            success: false,
            error: "whisper_not_found",
            message: "Whisper binary is missing. Please reinstall the app.",
          };
        }
        if (
          errorMessage.includes("Audio buffer is empty") ||
          errorMessage.includes("Audio data too small")
        ) {
          return {
            success: false,
            error: "no_audio_data",
            message: "No audio detected",
          };
        }
        if (errorMessage.includes("model") && errorMessage.includes("not downloaded")) {
          return {
            success: false,
            error: "model_not_found",
            message: errorMessage,
          };
        }

        throw error;
      }
    });

    ipcMain.handle("check-whisper-installation", async (event) => {
      return this.whisperManager.checkWhisperInstallation();
    });

    ipcMain.handle("get-audio-diagnostics", async () => {
      return this.whisperManager.getDiagnostics();
    });

    ipcMain.handle("download-whisper-model", async (event, modelName) => {
      const hadActiveDownload = this.localModelDownloadStatus.has("whisper", modelName);
      this.localModelDownloadStatus.start("whisper", modelName);
      try {
        const result = await this.whisperManager.downloadWhisperModel(modelName, (progressData) => {
          const status = this._updateNativeModelDownloadStatus("whisper", modelName, progressData);
          this.windowManager.sendToControlPanel("whisper-download-progress", {
            ...progressData,
            sequence: status?.sequence,
          });
        });
        const status = this.localModelDownloadStatus.has("whisper", modelName)
          ? this.localModelDownloadStatus.finish("whisper", modelName)
          : null;
        if (status) {
          this.windowManager.sendToControlPanel("whisper-download-progress", {
            type: "complete",
            model: modelName,
            percentage: 100,
            sequence: status.sequence,
          });
        }
        return result;
      } catch (error) {
        const status = hadActiveDownload
          ? null
          : this.localModelDownloadStatus.finish("whisper", modelName);
        if (!hadActiveDownload && error.code !== "DOWNLOAD_IN_PROGRESS") {
          this.windowManager.sendToControlPanel("whisper-download-progress", {
            type: "error",
            model: modelName,
            error: error.message,
            code: error.code || "DOWNLOAD_FAILED",
            sequence: status?.sequence,
          });
        }
        return {
          success: false,
          error: error.message,
          code: error.code || "DOWNLOAD_FAILED",
        };
      }
    });

    ipcMain.handle("check-model-status", async (event, modelName) => {
      return this.whisperManager.checkModelStatus(modelName);
    });

    ipcMain.handle("list-whisper-models", async (event) => {
      return this.whisperManager.listWhisperModels();
    });

    ipcMain.handle("delete-whisper-model", async (event, modelName) => {
      return this.whisperManager.deleteWhisperModel(modelName);
    });

    ipcMain.handle("delete-all-whisper-models", async () => {
      return this.whisperManager.deleteAllWhisperModels();
    });

    ipcMain.handle("cancel-whisper-download", async (event) => {
      return this.whisperManager.cancelDownload();
    });

    ipcMain.handle("whisper-server-start", async (event, modelName) => {
      return this.whisperManager.startServer(
        modelName,
        this.whisperManager.resolveGpuStartOptions()
      );
    });

    ipcMain.handle("whisper-server-stop", async () => {
      return this.whisperManager.stopServer();
    });

    ipcMain.handle("whisper-server-status", async () => {
      return this.whisperManager.getServerStatus();
    });

    ipcMain.handle("detect-gpu", async () => {
      const { detectNvidiaGpu } = require("../utils/gpuDetection");
      return detectNvidiaGpu();
    });

    ipcMain.handle("list-gpus", async () => {
      const { listNvidiaGpus } = require("../utils/gpuDetection");
      return listNvidiaGpus();
    });

    ipcMain.handle("set-gpu-device-index", async (_event, purpose, uuid) => {
      if (purpose !== "transcription" && purpose !== "intelligence") {
        return { success: false };
      }
      // Empty string clears the pinned GPU; otherwise require an nvidia-smi UUID. See #531.
      if (typeof uuid !== "string" || (uuid !== "" && !uuid.startsWith("GPU-"))) {
        return { success: false };
      }
      const key = purpose === "intelligence" ? "INTELLIGENCE_GPU_UUID" : "TRANSCRIPTION_GPU_UUID";
      const oldUuid = process.env[key] || "";
      process.env[key] = uuid;
      this.environmentManager.saveAllKeysToEnvFile().catch((err) => {
        debugLogger.error("Failed to persist GPU UUID", { error: err.message }, "gpu");
      });

      if (oldUuid !== uuid) {
        try {
          if (purpose === "transcription" && this.whisperManager?.serverManager?.process) {
            debugLogger.info(
              "Restarting whisper-server for GPU change",
              { from: oldUuid, to: uuid },
              "gpu"
            );
            await this.whisperManager.restartServerWithGpuPreference();
          }
          if (purpose === "intelligence") {
            const modelManager = require("./modelManagerBridge").default;
            if (modelManager.serverManager?.process) {
              debugLogger.info(
                "Restarting llama-server for GPU change",
                { from: oldUuid, to: uuid },
                "gpu"
              );
              const modelId = modelManager.currentServerModelId;
              await modelManager.serverManager.stop();
              if (modelId) {
                await modelManager.prewarmServer(modelId);
              }
            }
          }
        } catch (err) {
          debugLogger.error(
            "Failed to restart server after GPU change",
            { error: err.message, purpose },
            "gpu"
          );
        }
      }

      return { success: true };
    });

    ipcMain.handle("get-gpu-device-index", async (_event, purpose) => {
      if (purpose !== "transcription" && purpose !== "intelligence") {
        return "";
      }
      const key = purpose === "intelligence" ? "INTELLIGENCE_GPU_UUID" : "TRANSCRIPTION_GPU_UUID";
      return process.env[key] || "";
    });

    ipcMain.handle("get-cuda-whisper-status", async () => {
      const { detectNvidiaGpu } = require("../utils/gpuDetection");
      const gpuInfo = await detectNvidiaGpu();
      if (!this.whisperCudaManager) {
        return { downloaded: false, needsUpdate: false, downloading: false, path: null, gpuInfo };
      }
      return {
        downloaded: this.whisperCudaManager.isDownloaded(),
        needsUpdate: this.whisperCudaManager.needsUpdate(),
        downloading: this.whisperCudaManager.isDownloading(),
        path: this.whisperCudaManager.getCudaBinaryPath(),
        gpuInfo,
        ...this._whisperGpuFailureStatus("cuda"),
        inUse: this.whisperManager.resolveGpuPackInUse() === "cuda",
      };
    });

    ipcMain.handle("download-cuda-whisper-binary", async (event) => {
      if (!this.whisperCudaManager) {
        return { success: false, error: "CUDA not supported on this platform" };
      }
      try {
        const reloadModel = this._whisperReloadModel();
        // Stop the server first: swapping in a pack a running binary is loaded
        // from EBUSYs on Windows (same rule as the Vulkan handler below)
        await this.whisperManager.stopServer().catch(() => {});
        await this.whisperCudaManager.download((downloaded, total) => {
          if (!event.sender.isDestroyed()) {
            event.sender.send("cuda-download-progress", {
              downloadedBytes: downloaded,
              totalBytes: total,
              percentage: total > 0 ? Math.round((downloaded / total) * 100) : 0,
            });
          }
        });
        this._syncStartupEnv({ WHISPER_CUDA_ENABLED: "true" });
        this._clearWhisperGpuFailure("cuda");
        return { success: true, willRestart: this._applyWhisperGpuPreference(reloadModel) };
      } catch (error) {
        debugLogger.error("CUDA binary download failed", {
          error: error.message,
          stack: error.stack,
        });
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("cancel-cuda-whisper-download", async () => {
      if (!this.whisperCudaManager) return { success: false };
      return this.whisperCudaManager.cancelDownload();
    });

    ipcMain.handle("delete-cuda-whisper-binary", async () => {
      if (!this.whisperCudaManager) return { success: false };
      const reloadModel = this._whisperReloadModel();
      // Stop the server first so the running binary can be deleted on Windows
      await this.whisperManager.stopServer().catch(() => {});
      const result = await this.whisperCudaManager.delete();
      if (result.success) {
        this._syncStartupEnv({}, ["WHISPER_CUDA_ENABLED"]);
        this._clearWhisperGpuFailure("cuda");
        this._applyWhisperGpuPreference(reloadModel);
      }
      return result;
    });

    ipcMain.handle("get-vulkan-whisper-status", async () => {
      const { detectVulkanGpu } = require("../utils/vulkanDetection");
      const { detectNvidiaGpu } = require("../utils/gpuDetection");
      const [vulkan, gpuInfo] = await Promise.all([detectVulkanGpu(), detectNvidiaGpu()]);
      return {
        downloaded: this.whisperVulkanManager?.isDownloaded() ?? false,
        needsUpdate: this.whisperVulkanManager?.needsUpdate() ?? false,
        downloading: this.whisperVulkanManager?.isDownloading() ?? false,
        vulkan,
        hasNvidiaGpu: gpuInfo.hasNvidiaGpu,
        ...this._whisperGpuFailureStatus("vulkan"),
        inUse: this.whisperManager.resolveGpuPackInUse() === "vulkan",
      };
    });

    ipcMain.handle("download-vulkan-whisper-binary", async (event) => {
      if (!this.whisperVulkanManager) {
        return { success: false, error: "Vulkan not supported on this platform" };
      }
      try {
        const reloadModel = this._whisperReloadModel();
        // Stop the server first: overwriting a running binary EBUSYs on Windows
        await this.whisperManager.stopServer().catch(() => {});
        await this.whisperVulkanManager.download((downloaded, total) => {
          if (!event.sender.isDestroyed()) {
            event.sender.send("vulkan-whisper-download-progress", {
              downloadedBytes: downloaded,
              totalBytes: total,
              percentage: total > 0 ? Math.round((downloaded / total) * 100) : 0,
            });
          }
        });
        this._syncStartupEnv({ WHISPER_VULKAN_ENABLED: "true" });
        this._clearWhisperGpuFailure("vulkan");
        return { success: true, willRestart: this._applyWhisperGpuPreference(reloadModel) };
      } catch (error) {
        debugLogger.error("Vulkan whisper binary download failed", {
          error: error.message,
          stack: error.stack,
        });
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("cancel-vulkan-whisper-download", async () => {
      if (!this.whisperVulkanManager) return { success: false };
      return { success: this.whisperVulkanManager.cancelDownload() };
    });

    ipcMain.handle("delete-vulkan-whisper-binary", async () => {
      if (!this.whisperVulkanManager) return { success: false };
      const reloadModel = this._whisperReloadModel();
      // Stop the server first so the running binary can be deleted on Windows
      await this.whisperManager.stopServer().catch(() => {});
      const { deletedCount } = await this.whisperVulkanManager.delete();
      this._syncStartupEnv({}, ["WHISPER_VULKAN_ENABLED", "WHISPER_VULKAN_DEVICE"]);
      this._clearWhisperGpuFailure("vulkan");
      this._applyWhisperGpuPreference(reloadModel);
      return { success: true, deletedCount };
    });

    // One-time "GPU pack needs re-downloading" notice recorded before any
    // window existed (#1606). Only the window that shows it can take it.
    ipcMain.handle("take-gpu-pack-migration-notice", (event) => {
      if (event.sender !== this._gpuPackNoticeWindow()?.webContents) return null;
      return require("./gpuPackMigrationNotice").take();
    });

    // Clears the remembered GPU failure and reloads the server with the GPU
    // backend re-enabled (Retry on the "GPU could not be activated" state)
    ipcMain.handle("whisper-gpu-retry", async () => {
      this._syncStartupEnv({}, [
        "WHISPER_GPU_FAILED",
        ...Object.values(WHISPER_GPU_FAILURE_REASON_KEYS),
      ]);
      return {
        success: true,
        willRestart: this._applyWhisperGpuPreference(this._whisperReloadModel()),
      };
    });

    ipcMain.handle("check-ffmpeg-availability", async (event) => {
      return this.whisperManager.checkFFmpegAvailability();
    });

    ipcMain.handle("transcribe-local-parakeet", async (_event, audioBlob, options = {}) => {
      debugLogger.log("transcribe-local-parakeet called", {
        audioBlobType: typeof audioBlob,
        audioBlobSize: audioBlob?.byteLength || audioBlob?.length || 0,
        options,
      });

      try {
        const result = await this.parakeetManager.transcribeLocalParakeet(audioBlob, options);

        debugLogger.log("Parakeet result", {
          success: result.success,
          hasText: !!result.text,
          message: result.message,
          error: result.error,
        });

        return result;
      } catch (error) {
        debugLogger.error("Local Parakeet transcription error", error);
        const errorMessage = error.message || "Unknown error";

        if (errorMessage.includes("sherpa-onnx") && errorMessage.includes("not found")) {
          return {
            success: false,
            error: "parakeet_not_found",
            message: "Parakeet binary is missing. Please reinstall the app.",
          };
        }
        if (errorMessage.includes("model") && errorMessage.includes("not downloaded")) {
          return {
            success: false,
            error: "model_not_found",
            message: errorMessage,
          };
        }
        if (error.code === PARAKEET_UNSUPPORTED_OS_CODE) {
          return {
            success: false,
            error: error.code,
            message: errorMessage,
          };
        }

        throw error;
      }
    });

    ipcMain.handle("check-parakeet-installation", async () => {
      return this.parakeetManager.checkInstallation();
    });

    ipcMain.handle("download-parakeet-model", async (event, modelName) => {
      const hadActiveDownload = this.localModelDownloadStatus.has("parakeet", modelName);
      this.localModelDownloadStatus.start("parakeet", modelName);
      try {
        const result = await this.parakeetManager.downloadParakeetModel(
          modelName,
          (progressData) => {
            const status = this._updateNativeModelDownloadStatus(
              "parakeet",
              modelName,
              progressData
            );
            this.windowManager.sendToControlPanel("parakeet-download-progress", {
              ...progressData,
              sequence: status?.sequence,
            });
          }
        );
        const status = this.localModelDownloadStatus.has("parakeet", modelName)
          ? this.localModelDownloadStatus.finish("parakeet", modelName)
          : null;
        if (status) {
          this.windowManager.sendToControlPanel("parakeet-download-progress", {
            type: "complete",
            model: modelName,
            percentage: 100,
            sequence: status.sequence,
          });
        }
        return result;
      } catch (error) {
        const status = hadActiveDownload
          ? null
          : this.localModelDownloadStatus.finish("parakeet", modelName);
        if (!hadActiveDownload && error.code !== "DOWNLOAD_IN_PROGRESS") {
          this.windowManager.sendToControlPanel("parakeet-download-progress", {
            type: "error",
            model: modelName,
            error: error.message,
            code: error.code || "DOWNLOAD_FAILED",
            sequence: status?.sequence,
          });
        }
        return {
          success: false,
          error: error.message,
          code: error.code || "DOWNLOAD_FAILED",
        };
      }
    });

    ipcMain.handle("check-parakeet-model-status", async (_event, modelName) => {
      return this.parakeetManager.checkModelStatus(modelName);
    });

    ipcMain.handle("list-parakeet-models", async () => {
      return this.parakeetManager.listParakeetModels();
    });

    ipcMain.handle("delete-parakeet-model", async (_event, modelName) => {
      return this.parakeetManager.deleteParakeetModel(modelName);
    });

    ipcMain.handle("delete-all-parakeet-models", async () => {
      return this.parakeetManager.deleteAllParakeetModels();
    });

    ipcMain.handle("cancel-parakeet-download", async () => {
      return this.parakeetManager.cancelDownload();
    });

    ipcMain.handle("get-parakeet-diagnostics", async () => {
      return this.parakeetManager.getDiagnostics();
    });

    ipcMain.handle("parakeet-server-start", async (event, modelName) => {
      const result = await this.parakeetManager.startServer(modelName);
      // Persisting a provider that failed to start would wedge every launch
      // into a failing pre-warm.
      if (result.success) {
        process.env.LOCAL_TRANSCRIPTION_PROVIDER =
          getModelType(modelName) === "cohere-transcribe" ? "cohere" : "nvidia";
        process.env.PARAKEET_MODEL = modelName;
        await this.environmentManager.saveAllKeysToEnvFile();
      }
      return result;
    });

    ipcMain.handle("parakeet-server-stop", async () => {
      const result = await this.parakeetManager.stopServer();
      delete process.env.LOCAL_TRANSCRIPTION_PROVIDER;
      delete process.env.PARAKEET_MODEL;
      await this.environmentManager.saveAllKeysToEnvFile();
      return result;
    });

    ipcMain.handle("parakeet-server-status", async () => {
      return this.parakeetManager.getServerStatus();
    });

    // Diarization model management
    ipcMain.handle("download-diarization-models", async (event) => {
      try {
        const result = await this.diarizationManager.downloadModels((progressData) => {
          if (!event.sender.isDestroyed()) {
            event.sender.send("diarization-download-progress", progressData);
          }
        });
        return result;
      } catch (error) {
        if (!event.sender.isDestroyed()) {
          event.sender.send("diarization-download-progress", {
            type: "error",
            error: error.message,
            code: error.code || "DOWNLOAD_FAILED",
          });
        }
        return {
          success: false,
          error: error.message,
          code: error.code || "DOWNLOAD_FAILED",
        };
      }
    });

    ipcMain.handle("get-diarization-model-status", async () => {
      return {
        available: this.diarizationManager?.isAvailable() ?? false,
        modelsDownloaded:
          (this.diarizationManager?.isModelDownloaded() ?? false) &&
          (this.diarizationManager?.isVadModelDownloaded() ?? false),
      };
    });

    ipcMain.handle("delete-diarization-models", async () => {
      try {
        await this.diarizationManager.deleteModels();
        return { success: true };
      } catch (error) {
        debugLogger.error("Failed to delete diarization models", { error: error.message });
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("diarize-audio-file", async (event, filePath, options = {}) => {
      // Registered under the same requestId as the upload's transcription, so
      // one cancel stops both the decode and the diarization (child process or
      // server request).
      const { signal, release } = this._uploadCancelRegistry.register(options.requestId);
      try {
        if (!this.diarizationManager) {
          return { success: false, error: "Diarization not available" };
        }
        const diarizationRoute = this.diarizationRoute;
        if (diarizationRoute.transport === "error") {
          return { success: false, error: diarizationRoute.message };
        }
        if (
          diarizationRoute.transport === "local" &&
          !this.diarizationManager.isModelDownloaded()
        ) {
          return { success: false, error: "Diarization models not downloaded" };
        }

        if (typeof filePath !== "string") {
          return { success: false, error: "Invalid file path" };
        }
        const realPath = resolveAllowedAudioPath(filePath);
        if (!realPath) return { success: false, error: "File path not allowed" };
        filePath = realPath;

        // No count means no cap: the engine decides and phantoms are dropped below.
        const maxSpeakers = normalizeStoredSpeakerCount(options.numSpeakers) ?? Infinity;

        const { convertToWav } = require("./ffmpegUtils");
        const { getSafeTempDir } = require("./safeTempDir");
        const { capSpeakerClustersByVoice } = require("./diarizationPolicy");
        const wavPath = path.join(getSafeTempDir(), `ow-diarize-${Date.now()}.wav`);

        try {
          await convertToWav(filePath, wavPath, { sampleRate: 16000, channels: 1 });
          if (signal?.aborted) {
            return { success: false, error: "Cancelled", code: "UPLOAD_CANCELLED" };
          }
          // Auto-clustering over-splits long single-mic audio at the 0.55
          // default, so the threshold ramps with duration unless pinned.
          const durationSeconds = fs.statSync(wavPath).size / PCM16_MONO_16K_BYTES_PER_SECOND;
          const threshold = resolveClusterThreshold(durationSeconds, options.threshold);

          // Always auto-cluster: forcing 2 clusters on #2021's two-person call
          // split short utterances from long ones instead of one speaker from
          // the other, merging both speakers. The requested count is applied
          // as a cap after cleanup instead.
          let segments = await this._diarizeWav(wavPath, { threshold, signal });
          if (signal?.aborted) {
            return { success: false, error: "Cancelled", code: "UPLOAD_CANCELLED" };
          }
          // A collapsed run's labels are wrong either way: two people under
          // one label, or one person split off into a phantom. With no
          // segments the renderer keeps the plain transcript and shows the
          // diarization warning instead. Judged before phantoms are dropped;
          // a request for one speaker is met by the cap below instead.
          if (maxSpeakers > 1 && isCollapsedDiarization(segments)) {
            debugLogger.warn("Discarding diarization: one cluster holds nearly all speech", {
              durationSeconds,
            });
            segments = [];
          }
          // The meeting path caps clusters via its expectation resolver; this
          // path fed raw sherpa output to the merge, which is how a 2-person
          // voice memo surfaced 46 speakers.
          segments = dropNegligibleClusters(segments);
          if (new Set(segments.map((s) => s.speaker)).size > maxSpeakers) {
            const speakerEmbeddings = require("./speakerEmbeddings");
            let centroids = new Map();
            try {
              centroids = await speakerEmbeddings.extractClusterCentroids(wavPath, segments, {
                signal,
              });
            } catch (error) {
              debugLogger.warn("Speaker voices unavailable; extra clusters fold into the largest", {
                error: error.message,
              });
            }
            if (signal?.aborted) {
              return { success: false, error: "Cancelled", code: "UPLOAD_CANCELLED" };
            }
            segments = capSpeakerClustersByVoice(segments, maxSpeakers, centroids, (a, b) =>
              speakerEmbeddings.cosineSimilarity(a, b)
            );
          }
          // Callers persist this as audio_duration_seconds: for picked files
          // the renderer has no other duration source.
          return { success: true, segments, durationSeconds };
        } finally {
          try {
            fs.unlinkSync(wavPath);
          } catch {}
        }
      } catch (error) {
        if (error?.name === "AbortError" || signal?.aborted) {
          debugLogger.debug("Diarization cancelled", { requestId: options.requestId });
          return { success: false, error: "Cancelled", code: "UPLOAD_CANCELLED" };
        }
        debugLogger.error("Diarization error", { error: error.message });
        return { success: false, error: error.message };
      } finally {
        release();
      }
    });

    ipcMain.handle(
      "merge-speaker-text",
      async (event, { segments, text, duration, textSegments }) => {
        try {
          if (
            !Array.isArray(segments) ||
            typeof text !== "string" ||
            typeof duration !== "number" ||
            !isFinite(duration)
          ) {
            return { success: false, error: "Invalid arguments" };
          }
          if (segments.length > 10000 || text.length > 1_000_000) {
            return { success: false, error: "Input too large" };
          }
          const sanitizedSegments = segments.map((s) => ({
            speaker: typeof s.speaker === "string" ? s.speaker.slice(0, 100) : "unknown",
            start: typeof s.start === "number" && isFinite(s.start) ? s.start : 0,
            end: typeof s.end === "number" && isFinite(s.end) ? s.end : 0,
          }));
          if (
            Array.isArray(textSegments) &&
            textSegments.length > 0 &&
            textSegments.length <= 10000
          ) {
            const timed = textSegments
              .filter((s) => typeof s?.text === "string" && isFinite(s.start))
              .map((s) => ({
                text: s.text,
                start: s.start,
                end: isFinite(s.end) ? s.end : s.start,
              }));
            if (timed.length > 0) {
              const assigned = mergeSpeakersWithSegments(sanitizedSegments, timed);
              return {
                success: true,
                text: formatSpeakerTranscript(consolidateSpeakerRuns(assigned)),
                segments: labelSpeakers(assigned),
              };
            }
          }
          const merged = mergeSpeakersWithText(sanitizedSegments, text, duration);
          return { success: true, text: formatSpeakerTranscript(merged) };
        } catch (error) {
          debugLogger.error("Speaker merge error", { error: error.message });
          return { success: false, error: error.message };
        }
      }
    );

    ipcMain.handle("cancel-diarization-download", async () => {
      return this.diarizationManager.cancelDownload();
    });

    // Under `npm run dev` the Vite server dies with Electron, so a relaunched dev
    // instance would have no renderer: just quit there.
    ipcMain.handle("relaunch-app", async () => {
      if (process.env.NODE_ENV === "development") return app.quit();
      const { launcherPath, args } = getRelaunchOptions({
        argv: process.argv,
        appImagePath: process.env.APPIMAGE,
      });
      if (launcherPath) {
        const waiter = getRelaunchWaiter({ launcherPath, args, pid: process.pid });
        require("child_process")
          .spawn(waiter.file, waiter.args, {
            detached: true,
            stdio: "ignore",
            cwd: path.dirname(launcherPath), // never inside the directory being removed
          })
          .unref();
      } else {
        app.relaunch({ args });
      }
      app.quit();
    });

    ipcMain.handle("cleanup-app", async (event) => {
      const fs = require("fs");
      const os = require("os");
      const errors = [];
      const mainWindow = this.windowManager.mainWindow;

      // Stop services before deleting files they hold open
      try {
        await this.parakeetManager?.stopServer();
      } catch (e) {
        errors.push(`Parakeet stop: ${e.message}`);
      }
      try {
        this.whisperManager?.stopServer();
      } catch (e) {
        errors.push(`Whisper stop: ${e.message}`);
      }
      try {
        this.appleCalendarManager?.stop();
      } catch (e) {
        errors.push(`ACal stop: ${e.message}`);
      }
      try {
        await this.diarizationManager?.shutdown();
      } catch (e) {
        errors.push(`Diarization stop: ${e.message}`);
      }
      try {
        await this.getSemanticSearch?.()?.stop();
      } catch (e) {
        errors.push(`Vector index stop: ${e.message}`);
      }
      try {
        const onnxWorkerClient = require("./onnxWorkerClient");
        await onnxWorkerClient.stop();
      } catch (e) {
        errors.push(`Embedding worker stop: ${e.message}`);
      }

      // Close DB connection before deleting the file
      try {
        this.databaseManager?.db?.close();
      } catch (e) {
        errors.push(`DB close: ${e.message}`);
      }

      // Delete audio files
      try {
        this.audioStorageManager.deleteAllAudio();
      } catch (e) {
        errors.push(`Audio delete: ${e.message}`);
      }

      // Delete downloaded models
      try {
        const { getModelsDirForService } = require("./modelDirUtils");
        const whisperDir = getModelsDirForService("whisper");
        if (fs.existsSync(whisperDir)) fs.rmSync(whisperDir, { recursive: true, force: true });
      } catch (e) {
        errors.push(`Whisper models: ${e.message}`);
      }
      try {
        await this.parakeetManager?.deleteAllParakeetModels();
      } catch (e) {
        errors.push(`Parakeet models: ${e.message}`);
      }
      try {
        await this.diarizationManager?.deleteModels();
      } catch (e) {
        errors.push(`Diarization models: ${e.message}`);
      }
      try {
        const modelManager = require("./modelManagerBridge").default;
        await modelManager.deleteAllModels();
      } catch (e) {
        errors.push(`LLM models: ${e.message}`);
      }

      // Shared model and search caches outside userData.
      const homeCacheRoot = path.join(os.homedir(), ".cache", "openwhispr");
      for (const cacheName of ["embedding-models", "qdrant-data", "qdrant-data-dev", "yt-dlp"]) {
        try {
          fs.rmSync(path.join(homeCacheRoot, cacheName), { recursive: true, force: true });
        } catch (e) {
          errors.push(`${cacheName} cache: ${e.message}`);
        }
      }

      // Delete database file + WAL/SHM
      try {
        const dbPath = path.join(
          app.getPath("userData"),
          process.env.NODE_ENV === "development" ? "transcriptions-dev.db" : "transcriptions.db"
        );
        if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
        if (fs.existsSync(dbPath + "-wal")) fs.unlinkSync(dbPath + "-wal");
        if (fs.existsSync(dbPath + "-shm")) fs.unlinkSync(dbPath + "-shm");
      } catch (e) {
        errors.push(`DB file: ${e.message}`);
      }

      // Delete device-wide settings and encrypted credentials.
      try {
        await this.environmentManager?.clearAllPersistedData();
      } catch (e) {
        errors.push(`Environment settings: ${e.message}`);
      }
      try {
        for (const fileName of ["globe-preference-state.json", ".system-audio-permission"]) {
          fs.rmSync(path.join(app.getPath("userData"), fileName), { force: true });
        }
      } catch (e) {
        errors.push(`Device setting files: ${e.message}`);
      }
      for (const directoryName of ["bin", "llama-cpp"]) {
        try {
          fs.rmSync(path.join(app.getPath("userData"), directoryName), {
            recursive: true,
            force: true,
          });
        } catch (e) {
          errors.push(`${directoryName} runtime: ${e.message}`);
        }
      }
      try {
        autoStart.setAutoStartEnabled(false);
      } catch (e) {
        errors.push(`Launch at login: ${e.message}`);
      }

      // Clear browser-held state, including cookies, IndexedDB,
      // Cache Storage and localStorage persisted by any app window.
      try {
        const win = BrowserWindow.fromWebContents(event.sender);
        if (win) {
          await win.webContents.session.clearStorageData();
          await win.webContents.session.clearCache();
        }
      } catch (e) {
        errors.push(`Browser data: ${e.message}`);
      }

      // Clear localStorage
      if (mainWindow?.webContents) {
        try {
          await mainWindow.webContents.executeJavaScript("localStorage.clear()");
        } catch (e) {
          errors.push(`localStorage: ${e.message}`);
        }
      }

      if (errors.length > 0) {
        debugLogger.warn("Cleanup completed with errors", { errors }, "cleanup");
      }

      return { success: errors.length === 0, message: "Cleanup completed", errors };
    });

    ipcMain.handle("update-hotkey", async (event, hotkey) => {
      return await this.windowManager.updateHotkey(hotkey);
    });

    ipcMain.handle("set-hotkey-listening-mode", async (event, enabled) => {
      if (enabled) {
        const captureWindow = BrowserWindow.fromWebContents(event.sender);
        // Only the control panel owns editable hotkey fields. Refocusing the
        // sender before the idempotence check also repairs a stale capture-mode
        // flag after Windows has moved foreground focus to another window.
        if (captureWindow === this.windowManager.controlPanelWindow) {
          focusWindowsHotkeyCaptureWindow(captureWindow);
        }
      }
      if (this._hotkeyCaptureMode === enabled) return { success: true, skipped: true };
      this._hotkeyCaptureMode = enabled;
      this.windowManager.setHotkeyListeningMode(enabled);
      ipcMain.emit("hotkey-listening-mode-changed", null, enabled);
      const hotkeyManager = this.windowManager.hotkeyManager;

      // Restore from slot state only. A freshly captured hotkey is registered by
      // its own update IPC (invoked before this one); re-binding it here would
      // overwrite the primary on DE backends or leak untracked registrations.
      const effectiveHotkey = hotkeyManager.getCurrentHotkey();

      const {
        isGlobeLikeHotkey,
        isModifierOnlyHotkey,
        isRightSideModifier,
        isMouseButtonHotkey,
      } = require("./hotkeyManager");
      const usesNativeListener = (hotkey) =>
        !hotkey ||
        isGlobeLikeHotkey(hotkey) ||
        isMouseButtonHotkey(hotkey) ||
        isModifierOnlyHotkey(hotkey) ||
        isRightSideModifier(hotkey);

      if (enabled) {
        // Entering capture mode — unregister ALL slots so none intercept keypresses.
        // Dictation is always active; meeting and agent may or may not be set.
        const allSlots = hotkeyManager.slots;
        for (const [slot, info] of allSlots) {
          // Native-listener entries (null accelerator) are handled by stopping
          // the key listeners below.
          for (const accel of info?.accelerators || []) {
            if (!accel) continue;
            debugLogger.log(
              `[IPC] Unregistering globalShortcut "${accel}" (slot "${slot}") for capture mode`
            );
            const { globalShortcut } = require("electron");
            try {
              globalShortcut.unregister(accel);
            } catch {}
          }
        }

        // On Windows, stop the Windows key listener
        if (process.platform === "win32" && this.windowsKeyManager) {
          debugLogger.log("[IPC] Stopping Windows key listener for hotkey capture mode");
          this.windowsKeyManager.stop();
        }

        // On Linux, stop the Linux key listener
        if (process.platform === "linux" && this.linuxKeyManager) {
          debugLogger.log("[IPC] Stopping Linux key listener for hotkey capture mode");
          this.linuxKeyManager.stop();
        }

        // On GNOME, unregister all native keybindings during capture
        if (hotkeyManager.isUsingGnome() && hotkeyManager.gnomeManager) {
          await hotkeyManager.gnomeManager.unregisterPushToTalk();
          for (const slot of [...hotkeyManager.gnomeManager.registeredSlots]) {
            debugLogger.log(
              `[IPC] Unregistering GNOME keybinding (slot "${slot}") for capture mode`
            );
            await hotkeyManager.gnomeManager.unregisterKeybinding(slot).catch((err) => {
              debugLogger.warn(`[IPC] Failed to unregister GNOME slot "${slot}":`, err.message);
            });
          }
        }

        // On Hyprland Wayland, unregister the keybinding during capture
        if (hotkeyManager.isUsingHyprland() && hotkeyManager.hyprlandManager) {
          debugLogger.log("[IPC] Unregistering Hyprland keybinding for hotkey capture mode");
          const unregistered = await hotkeyManager.hyprlandManager
            .unregisterKeybinding()
            .catch((err) => {
              debugLogger.warn("[IPC] Failed to unregister Hyprland keybinding:", err.message);
              return false;
            });
          if (!unregistered) {
            debugLogger.warn("[IPC] Hyprland keybinding remained active during capture");
          }
        }
      } else {
        // Exiting capture mode - re-register globalShortcut if not already registered
        // Skip for KDE/GNOME/Hyprland — updateHotkey handles re-registration via native path
        const usesNativePath =
          hotkeyManager.isUsingKDE() ||
          hotkeyManager.isUsingGnome() ||
          hotkeyManager.isUsingHyprland();
        if (!usesNativePath) {
          const { globalShortcut } = require("electron");
          // Re-register every globalShortcut-backed dictation hotkey (the slot
          // may hold several).
          for (const hk of hotkeyManager.getSlotHotkeys("dictation")) {
            if (!hk || usesNativeListener(hk)) continue;
            const accelerator = hk;
            if (!globalShortcut.isRegistered(accelerator)) {
              debugLogger.log(
                `[IPC] Re-registering globalShortcut "${accelerator}" after capture mode`
              );
              const callback = this.windowManager.createHotkeyCallback();
              const registered = globalShortcut.register(accelerator, () => callback(hk));
              if (!registered) {
                debugLogger.warn(
                  `[IPC] Failed to re-register globalShortcut "${accelerator}" after capture mode`
                );
              }
            }
          }
        }

        // Re-sync native key listeners (Windows/Linux) across all hotkey slots now
        // that capture is done. Idempotent — reads the current slot hotkeys.
        this.windowManager.reconcileNativeKeyListeners();

        // On GNOME, re-register the keybinding with the effective hotkey
        if (hotkeyManager.isUsingGnome() && hotkeyManager.gnomeManager && effectiveHotkey) {
          debugLogger.log(
            `[IPC] Re-registering GNOME keybinding "${effectiveHotkey}" after capture mode`
          );
          await hotkeyManager.registerGnomeDictationHotkey(
            effectiveHotkey,
            this.windowManager.createHotkeyCallback()
          );
        }

        // On Hyprland Wayland, re-register the keybinding with the effective hotkey
        if (hotkeyManager.isUsingHyprland() && hotkeyManager.hyprlandManager && effectiveHotkey) {
          debugLogger.log(
            `[IPC] Re-registering Hyprland keybinding "${effectiveHotkey}" after capture mode`
          );
          await hotkeyManager.hyprlandManager.registerKeybinding(
            effectiveHotkey,
            this.windowManager.getActivationMode() === "push"
          );
        }

        // On KDE (X11 or Wayland), re-register the keybinding with the effective hotkey
        if (hotkeyManager.isUsingKDE() && hotkeyManager.kdeManager && effectiveHotkey) {
          debugLogger.log(
            `[IPC] Re-registering KDE keybinding "${effectiveHotkey}" after capture mode`
          );
          const callback = this.windowManager.createHotkeyCallback();
          const result = await hotkeyManager.kdeManager.registerKeybinding(
            effectiveHotkey,
            "dictation",
            callback,
            this.windowManager.getActivationMode() === "push"
          );
          if (result !== true) {
            debugLogger.warn(
              `[IPC] Failed to re-register KDE keybinding "${effectiveHotkey}" after capture mode`,
              { result }
            );
          }
        }

        // Re-register non-dictation slots (meeting, agent) that were unregistered on capture enter
        for (const [slot, info] of hotkeyManager.slots) {
          const hotkeys = info?.hotkeys || [];
          if (slot === "dictation" || slot === "cancel" || hotkeys.length === 0 || !info?.callback)
            continue;
          debugLogger.log(
            `[IPC] Re-registering slot "${slot}" ("${hotkeys.join(", ")}") after capture mode`
          );
          const result = await hotkeyManager
            .registerSlot(slot, hotkeys, info.callback)
            .catch((err) => {
              debugLogger.warn(`[IPC] Failed to re-register slot "${slot}":`, err.message);
              return { success: false };
            });
          if (!result.success) {
            debugLogger.warn(`[IPC] Slot "${slot}" was not restored after capture`);
          }
        }
      }

      return { success: true };
    });

    ipcMain.handle("get-hotkey-mode-info", async (_event, requestedHotkey) => {
      const hotkeyManager = this.windowManager.hotkeyManager;
      const hotkey =
        typeof requestedHotkey === "string" && requestedHotkey.trim()
          ? requestedHotkey.split(",")[0].trim()
          : hotkeyManager.getCurrentHotkey();
      const isUsingNativeShortcut = this.windowManager.isUsingNativeShortcutHotkeys();
      const supportsPushToTalk = hotkeyManager.supportsPushToTalk(hotkey);

      return {
        isUsingGnome: this.windowManager.isUsingGnomeHotkeys(),
        isUsingHyprland: this.windowManager.isUsingHyprlandHotkeys(),
        isUsingKDE: this.windowManager.isUsingKDEHotkeys(),
        isUsingNativeShortcut,
        supportsPushToTalk,
        pushToTalkUnavailableReason: supportsPushToTalk
          ? null
          : hotkeyManager.getPushToTalkUnavailableReason(hotkey),
        // Lets the renderer show the setup box outside push mode, where the
        // disabled-Hold tooltip is the only other place this surfaces. Desktop
        // backends see their own hotkeys, so access matters only without one.
        linuxInputAccessDenied:
          hotkeyManager.reliesOnLinuxKeyListener() &&
          hotkeyManager.nativeListenerProbe().reason === "input_access_denied",
      };
    });

    ipcMain.handle("get-hyprland-config-status", async () => {
      if (!this.windowManager.isUsingHyprlandHotkeys()) return null;
      return this.windowManager.getHyprlandConfigStatus();
    });

    ipcMain.handle("register-cancel-hotkey", async (event, key) => {
      const hotkeyManager = this.windowManager.hotkeyManager;
      const mainWindow = this.windowManager.mainWindow;
      return hotkeyManager.registerSlot("cancel", key, () => {
        mainWindow?.webContents?.send("cancel-hotkey-pressed");
      });
    });

    ipcMain.handle("unregister-cancel-hotkey", async () => {
      this.windowManager.hotkeyManager.unregisterSlot("cancel");
      return { success: true };
    });

    ipcMain.handle("start-window-drag", async (event) => {
      return await this.windowManager.startWindowDrag();
    });

    ipcMain.handle("stop-window-drag", async (event) => {
      return await this.windowManager.stopWindowDrag();
    });

    ipcMain.handle("start-control-panel-drag", async () => {
      return await this.windowManager.startControlPanelDrag();
    });

    ipcMain.handle("stop-control-panel-drag", async () => {
      return await this.windowManager.stopControlPanelDrag();
    });

    ipcMain.handle("open-external", async (event, url) => {
      try {
        const { protocol } = new URL(url);
        if (!["http:", "https:", "mailto:"].includes(protocol)) {
          return { success: false, error: `Blocked URL scheme: ${protocol}` };
        }
        await openExternalUrl(url);
        return { success: true };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("get-auto-start-enabled", async () => {
      try {
        return autoStart.getAutoStartState();
      } catch (error) {
        debugLogger.error("Error getting auto-start status:", error);
        return { enabled: false, requiresApproval: false };
      }
    });

    ipcMain.handle("set-auto-start-enabled", async (event, enabled) => {
      try {
        autoStart.setAutoStartEnabled(enabled);
        debugLogger.debug("Auto-start setting updated", { enabled });
        return { success: true };
      } catch (error) {
        debugLogger.error("Error setting auto-start:", error);
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("model-get-all", async () => {
      try {
        debugLogger.debug("model-get-all called", undefined, "ipc");
        const modelManager = require("./modelManagerBridge").default;
        const models = await modelManager.getModelsWithStatus();
        debugLogger.debug("Returning models", { count: models.length }, "ipc");
        return models;
      } catch (error) {
        debugLogger.error("Error in model-get-all:", error);
        throw error;
      }
    });

    ipcMain.handle("model-get-active-downloads", async () => {
      return this.localModelDownloadStatus.getActiveDownloads();
    });

    ipcMain.handle("model-check", async (_, modelId) => {
      const modelManager = require("./modelManagerBridge").default;
      return modelManager.isModelDownloaded(modelId);
    });

    ipcMain.handle("model-download", async (event, modelId) => {
      if (this.localModelDownloadStatus.has("llm", modelId)) {
        return {
          success: false,
          error: "Model is already being downloaded",
          code: "DOWNLOAD_IN_PROGRESS",
          details: { modelId },
        };
      }
      // Claim ownership before the manager's asynchronous filesystem preflight.
      this.localModelDownloadStatus.start("llm", modelId);
      try {
        const modelManager = require("./modelManagerBridge").default;
        const result = await modelManager.downloadModel(
          modelId,
          (progress, downloadedSize, totalSize) => {
            const status = this.localModelDownloadStatus.update("llm", modelId, {
              phase: "downloading",
              progress,
              downloadedBytes: downloadedSize,
              totalBytes: totalSize,
            });
            this.windowManager.sendToControlPanel("model-download-progress", {
              modelId,
              type: "progress",
              progress,
              downloadedSize,
              totalSize,
              sequence: status.sequence,
            });
          }
        );
        const status = this.localModelDownloadStatus.finish("llm", modelId);
        this.windowManager.sendToControlPanel("model-download-progress", {
          modelId,
          type: "complete",
          progress: 100,
          downloadedSize: status?.downloadedBytes,
          totalSize: status?.totalBytes,
          sequence: status?.sequence,
        });
        return { success: true, path: result };
      } catch (error) {
        const status = this.localModelDownloadStatus.finish("llm", modelId);
        if (error.code !== "DOWNLOAD_IN_PROGRESS") {
          this.windowManager.sendToControlPanel("model-download-progress", {
            modelId,
            type: "error",
            error: error.message,
            code: error.code,
            details: error.details,
            sequence: status?.sequence,
          });
        }
        return {
          success: false,
          error: error.message,
          code: error.code,
          details: error.details,
        };
      }
    });

    ipcMain.handle("model-delete", async (event, modelId) => {
      try {
        const modelManager = require("./modelManagerBridge").default;
        await modelManager.deleteModel(modelId);
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: error.message,
          code: error.code,
          details: error.details,
        };
      }
    });

    ipcMain.handle("model-delete-all", async () => {
      try {
        const modelManager = require("./modelManagerBridge").default;
        await modelManager.deleteAllModels();
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: error.message,
          code: error.code,
          details: error.details,
        };
      }
    });

    ipcMain.handle("model-cancel-download", async (event, modelId) => {
      try {
        const modelManager = require("./modelManagerBridge").default;
        const cancelled = modelManager.cancelDownload(modelId);
        return { success: cancelled };
      } catch (error) {
        return {
          success: false,
          error: error.message,
        };
      }
    });

    ipcMain.handle("get-custom-transcription-key", async () => {
      return this.environmentManager.getCustomTranscriptionKey();
    });

    ipcMain.handle(
      "save-custom-transcription-key",
      saveSecretKey(
        "getCustomTranscriptionKey",
        "saveCustomTranscriptionKey",
        "customTranscriptionApiKey"
      )
    );

    ipcMain.handle("get-cleanup-custom-key", async () => {
      return this.environmentManager.getCleanupCustomKey();
    });

    ipcMain.handle(
      "save-cleanup-custom-key",
      saveSecretKey("getCleanupCustomKey", "saveCleanupCustomKey", "cleanupCustomApiKey")
    );

    ipcMain.handle("get-dictation-key", async () => {
      return this.environmentManager.getDictationKey();
    });

    ipcMain.handle("save-dictation-key", async (event, key) => {
      return this.environmentManager.saveDictationKey(key);
    });

    ipcMain.handle("get-active-dictation-key", async () => {
      const hotkeys = this.windowManager?.hotkeyManager?.getSlotHotkeys?.("dictation") ?? [];
      return hotkeys.length > 0 ? hotkeys.join(",") : null;
    });

    ipcMain.handle("get-effective-default-hotkey", async () => {
      return this.windowManager?.hotkeyManager?.getEffectiveDefaultHotkey() ?? null;
    });

    // The mode in effect: startup can fall back to Tap for this session while
    // the saved preference stays Hold for the next launch.
    ipcMain.handle("get-activation-mode", async () => {
      return this.windowManager.getActivationMode();
    });

    ipcMain.handle("save-activation-mode", async (event, mode) => {
      return this.environmentManager.saveActivationMode(mode);
    });

    ipcMain.handle("get-ui-language", async () => {
      return this.environmentManager.getUiLanguage();
    });

    ipcMain.handle("save-ui-language", async (event, language) => {
      return this.environmentManager.saveUiLanguage(language);
    });

    ipcMain.handle("set-ui-language", async (event, language) => {
      const result = this.environmentManager.saveUiLanguage(language);
      process.env.UI_LANGUAGE = result.language;
      changeLanguage(result.language);
      this.windowManager?.refreshLocalizedUi?.();
      this.getTrayManager?.()?.updateTrayMenu?.();
      return { success: true, language: result.language };
    });

    ipcMain.handle("save-all-keys-to-env", async () => {
      return this.environmentManager.saveAllKeysToEnvFile();
    });

    ipcMain.handle("sync-startup-preferences", async (event, prefs) => {
      const setVars = {};
      const clearVars = [];

      if (prefs.useLocalWhisper && prefs.model) {
        // Local mode with model selected - set provider and model for pre-warming
        setVars.LOCAL_TRANSCRIPTION_PROVIDER = prefs.localTranscriptionProvider;
        if (prefs.language) setVars.DICTATION_LANGUAGE = prefs.language;
        if (isSherpaLocalProvider(prefs.localTranscriptionProvider)) {
          setVars.PARAKEET_MODEL = prefs.model;
          clearVars.push("LOCAL_WHISPER_MODEL");
          this.whisperManager.stopServer().catch((err) => {
            debugLogger.error("Failed to stop whisper-server on provider switch", {
              error: err.message,
            });
          });
        } else {
          setVars.LOCAL_WHISPER_MODEL = prefs.model;
          clearVars.push("PARAKEET_MODEL");
          this.parakeetManager.stopServer().catch((err) => {
            debugLogger.error("Failed to stop parakeet-server on provider switch", {
              error: err.message,
            });
          });
        }
      } else if (prefs.useLocalWhisper) {
        // Local mode enabled but no model selected - clear pre-warming vars
        clearVars.push("LOCAL_TRANSCRIPTION_PROVIDER", "PARAKEET_MODEL", "LOCAL_WHISPER_MODEL");
      } else {
        // Self-hosted mode - stop local servers to free RAM
        clearVars.push("LOCAL_TRANSCRIPTION_PROVIDER", "PARAKEET_MODEL", "LOCAL_WHISPER_MODEL");
        this.whisperManager.stopServer().catch((err) => {
          debugLogger.error("Failed to stop whisper-server on self-hosted switch", {
            error: err.message,
          });
        });
        this.parakeetManager.stopServer().catch((err) => {
          debugLogger.error("Failed to stop parakeet-server on self-hosted switch", {
            error: err.message,
          });
        });
      }

      // TODO: drop legacy REASONING_PROVIDER / LOCAL_REASONING_MODEL clears once
      // the read fallback is removed (~2 releases after this lands).
      clearVars.push("REASONING_PROVIDER", "LOCAL_REASONING_MODEL");

      // Applies to whichever model the shared llama-server holds.
      const modelManager = require("./modelManagerBridge").default;
      modelManager.serverManager.setKeepResident(prefs.keepLocalModelLoaded === true);

      const localServer = resolveLocalServerNeeds(prefs);

      if (localServer.cleanup) {
        setVars.CLEANUP_PROVIDER = "local";
        setVars.LOCAL_CLEANUP_MODEL = localServer.cleanup;
      } else {
        clearVars.push("CLEANUP_PROVIDER", "LOCAL_CLEANUP_MODEL");
      }

      if (localServer.dictationAgent) {
        setVars.DICTATION_AGENT_PROVIDER = "local";
        setVars.LOCAL_DICTATION_AGENT_MODEL = localServer.dictationAgent;
      } else {
        clearVars.push("DICTATION_AGENT_PROVIDER", "LOCAL_DICTATION_AGENT_MODEL");
      }

      // Stop the shared llama-server only when no scope still needs the model
      // it holds, so the active scopes keep their server when another leaves.
      if (shouldStopLocalServer(localServer, modelManager.currentServerModelId)) {
        if (modelManager.getServerStatus().running) {
          debugLogger.debug("Stopping llama-server: no scope needs its model", {
            loadedModel: modelManager.currentServerModelId,
            neededModels: localServer.models,
          });
        }
        modelManager.stopServer().catch((err) => {
          debugLogger.error("Failed to stop llama-server", { error: err.message });
        });
      }

      this._syncStartupEnv(setVars, clearVars);
    });

    ipcMain.handle("process-local-reasoning", async (event, text, modelId, _agentName, config) => {
      try {
        const LocalReasoningService = require("../services/localReasoningBridge").default;
        const result = await LocalReasoningService.processText(text, modelId, config);
        return { success: true, text: result };
      } catch (error) {
        // code/details carry the machine-readable failure across to the
        // renderer, which owns the translation keys. Flattening to a bare
        // string is how llama.cpp JSON used to reach users (#2142).
        return {
          success: false,
          error: error.message,
          code: error.code,
          details: error.details,
        };
      }
    });

    ipcMain.handle("cancel-local-reasoning", (event, requestId) => {
      require("../services/localReasoningBridge").default.cancel(requestId);
    });

    // After a local refusal, the renderer plans a note's parts against this
    // number (#2142 part 3). It is the same ceiling runInference sizes against,
    // so a part the renderer judges to fit is one the main process will accept
    // without a restart it cannot afford.
    ipcMain.handle("get-local-context-budget", async (event, modelId) => {
      try {
        const modelManager = require("./modelManagerBridge").default;
        modelManager.ensureInitialized();
        const modelInfo = modelManager.findModelById(modelId);
        if (!modelInfo) {
          return { success: false, error: `Model "${modelId}" not found` };
        }
        const modelPath = require("path").join(modelManager.modelsDir, modelInfo.model.fileName);
        const { ceiling } = await modelManager.contextCeiling(modelInfo, modelPath);
        return { success: true, maxContextTokens: ceiling, modelName: modelInfo.model.name };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("check-local-reasoning-available", async () => {
      try {
        const LocalReasoningService = require("../services/localReasoningBridge").default;
        return await LocalReasoningService.isAvailable();
      } catch (error) {
        return false;
      }
    });

    ipcMain.handle("llama-cpp-check", async () => {
      try {
        const llamaCppInstaller = require("./llamaCppInstaller").default;
        const isInstalled = await llamaCppInstaller.isInstalled();
        const version = isInstalled ? await llamaCppInstaller.getVersion() : null;
        return { isInstalled, version };
      } catch (error) {
        return { isInstalled: false, error: error.message };
      }
    });

    ipcMain.handle("llama-cpp-install", async () => {
      try {
        const llamaCppInstaller = require("./llamaCppInstaller").default;
        const result = await llamaCppInstaller.install();
        return result;
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("llama-cpp-uninstall", async () => {
      try {
        const llamaCppInstaller = require("./llamaCppInstaller").default;
        const result = await llamaCppInstaller.uninstall();
        return result;
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("llama-server-start", async (event, modelId) => {
      try {
        const modelManager = require("./modelManagerBridge").default;
        modelManager.ensureInitialized();
        const modelInfo = modelManager.findModelById(modelId);
        if (!modelInfo) {
          return { success: false, error: `Model "${modelId}" not found` };
        }

        const modelPath = require("path").join(modelManager.modelsDir, modelInfo.model.fileName);

        await modelManager.serverManager.start(
          modelPath,
          await modelManager.serverStartOptions(modelInfo)
        );
        modelManager.currentServerModelId = modelId;

        this.environmentManager.saveAllKeysToEnvFile().catch(() => {});
        return { success: true, port: modelManager.serverManager.port };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("llama-server-status", async () => {
      try {
        const modelManager = require("./modelManagerBridge").default;
        return modelManager.getServerStatus();
      } catch (error) {
        return { available: false, running: false, error: error.message };
      }
    });

    ipcMain.handle("llama-gpu-reset", async () => {
      try {
        const modelManager = require("./modelManagerBridge").default;
        const previousModelId = modelManager.currentServerModelId;
        modelManager.serverManager.resetGpuDetection();
        await modelManager.stopServer();

        // Restart server with previous model so Vulkan binary is picked up
        if (previousModelId) {
          modelManager.prewarmServer(previousModelId).catch(() => {});
        }

        return { success: true };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("detect-vulkan-gpu", async () => {
      try {
        const { detectVulkanGpu } = require("../utils/vulkanDetection");
        return await detectVulkanGpu();
      } catch (error) {
        return { available: false, error: error.message };
      }
    });

    ipcMain.handle("get-llama-vulkan-status", async () => {
      try {
        if (!this._llamaVulkanManager) {
          const LlamaVulkanManager = require("./llamaVulkanManager");
          this._llamaVulkanManager = new LlamaVulkanManager();
        }
        return this._llamaVulkanManager.getStatus();
      } catch (error) {
        return { supported: false, downloaded: false, error: error.message };
      }
    });

    ipcMain.handle("download-llama-vulkan-binary", async (event) => {
      try {
        if (!this._llamaVulkanManager) {
          const LlamaVulkanManager = require("./llamaVulkanManager");
          this._llamaVulkanManager = new LlamaVulkanManager();
        }

        // Stop Vulkan server before downloading to release file locks on DLLs (Windows EBUSY)
        const modelManager = require("./modelManagerBridge").default;
        if (modelManager.serverManager.activeBackend === "vulkan") {
          await modelManager.stopServer().catch((err) => {
            debugLogger.warn("Failed to stop Vulkan server before download", {
              error: err.message,
            });
          });
        }

        const result = await this._llamaVulkanManager.download((downloaded, total) => {
          if (!event.sender.isDestroyed()) {
            event.sender.send("llama-vulkan-download-progress", {
              downloaded,
              total,
              percentage: total > 0 ? Math.round((downloaded / total) * 100) : 0,
            });
          }
        });

        if (result.success) {
          process.env.LLAMA_VULKAN_ENABLED = "true";
          delete process.env.LLAMA_GPU_BACKEND;
          modelManager.serverManager.cachedServerBinaryPaths = null;
          await this.environmentManager.saveAllKeysToEnvFile().catch(() => {});
          // Stop server so next inference picks up the new Vulkan binary
          await modelManager.stopServer().catch(() => {});
        }

        return result;
      } catch (error) {
        debugLogger.error("Vulkan binary download failed", {
          error: error.message,
          stack: error.stack,
        });
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("cancel-llama-vulkan-download", async () => {
      if (this._llamaVulkanManager) {
        return { success: this._llamaVulkanManager.cancelDownload() };
      }
      return { success: false };
    });

    ipcMain.handle("delete-llama-vulkan-binary", async () => {
      try {
        if (!this._llamaVulkanManager) {
          const LlamaVulkanManager = require("./llamaVulkanManager");
          this._llamaVulkanManager = new LlamaVulkanManager();
        }

        const modelManager = require("./modelManagerBridge").default;
        if (modelManager.serverManager.activeBackend === "vulkan") {
          await modelManager.stopServer();
        }

        const result = await this._llamaVulkanManager.deleteBinary();

        delete process.env.LLAMA_VULKAN_ENABLED;
        delete process.env.LLAMA_GPU_BACKEND;
        modelManager.serverManager.cachedServerBinaryPaths = null;
        this.environmentManager.saveAllKeysToEnvFile().catch(() => {});

        return result;
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("get-log-level", async () => {
      return debugLogger.getLevel();
    });

    ipcMain.handle("app-log", async (event, entry) => {
      debugLogger.logEntry(entry);
      return { success: true };
    });

    const SYSTEM_SETTINGS_URLS = {
      darwin: {
        microphone: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
        sound: "x-apple.systempreferences:com.apple.preference.sound?input",
        accessibility:
          "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
        systemAudio:
          "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
        screenRecording:
          "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
        calendars: "x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars",
        loginItems: "x-apple.systempreferences:com.apple.LoginItems-Settings.extension",
      },
      win32: {
        microphone: "ms-settings:privacy-microphone",
        sound: "ms-settings:sound",
        loginItems: "ms-settings:startupapps",
      },
    };

    const openSystemSettings = async (settingType) => {
      const platform = process.platform;
      const urls = SYSTEM_SETTINGS_URLS[platform];
      const url = urls?.[settingType];

      if (!url) {
        // Platform doesn't support this settings URL
        const messages = {
          microphone: i18nMain.t("systemSettings.microphone"),
          sound: i18nMain.t("systemSettings.sound"),
          accessibility: i18nMain.t("systemSettings.accessibility"),
          systemAudio: i18nMain.t("systemSettings.systemAudio"),
          screenRecording: i18nMain.t("systemSettings.screenRecording"),
          loginItems: i18nMain.t("systemSettings.loginItems"),
        };
        return {
          success: false,
          error:
            messages[settingType] || `${settingType} settings are not available on this platform.`,
        };
      }

      try {
        await shell.openExternal(url);
        return { success: true };
      } catch (error) {
        debugLogger.error(`Failed to open ${settingType} settings:`, error);
        return { success: false, error: error.message };
      }
    };

    ipcMain.handle("open-microphone-settings", () => openSystemSettings("microphone"));
    ipcMain.handle("open-sound-input-settings", () => openSystemSettings("sound"));
    ipcMain.handle("get-system-default-microphone", (_event, options = {}) =>
      resolveSystemDefaultMicrophone({ refresh: options?.refresh === true })
    );
    ipcMain.handle("open-accessibility-settings", () => openSystemSettings("accessibility"));
    ipcMain.handle("open-system-audio-settings", () => openSystemSettings("systemAudio"));
    ipcMain.handle("open-screen-recording-settings", () => openSystemSettings("screenRecording"));
    ipcMain.handle("open-login-items-settings", () => openSystemSettings("loginItems"));

    ipcMain.handle("capture-screen-context", async () => {
      // The target's window rect picks the display it is on rather than the one
      // under the cursor, and the panel reposition has normally cached it already.
      // A failed rect read falls back to the cursor rather than rejecting:
      // capture's contract is to yield null, never to throw — a screenshot must
      // never break the dictation it accompanies.
      const targetPid = this.textEditMonitor?.lastTargetPid;
      return Promise.resolve(
        targetPid ? this.textEditMonitor.getTargetWindowBounds?.(targetPid) : null
      )
        .catch(() => null)
        .then((targetBounds) => screenContextCapture.captureActiveDisplay(targetBounds));
    });

    // Snapshot the launch-time TCC status so a mid-session grant (which macOS
    // only honors after a relaunch) is detectable even if the renderer never
    // checked before the user granted.
    screenContextCapture.getAccessStatus();

    ipcMain.handle("check-screen-recording-access", () => screenContextCapture.getAccessResult());

    ipcMain.handle("request-screen-recording-access", async () => {
      const status = await screenContextCapture.requestAccess();
      if (process.platform === "darwin" && status !== "granted") {
        await openSystemSettings("screenRecording");
      }
      return screenContextCapture.getAccessResult();
    });

    // Preserve the renderer setting while app-wide content protection is
    // temporarily disabled for screen recording.
    ipcMain.handle("screen-context-set-enabled", (event, enabled) => {
      this.windowManager?.setScreenContextProtection(enabled);
      return { success: true };
    });

    // Panel open: window becomes focusable so follow-up keyboard input works.
    // Only the dictation renderer may flip main-window focusability.
    ipcMain.handle("set-assistant-panel-open", (event, open) => {
      const dictationWindow = this.windowManager?.mainWindow;
      if (
        !dictationWindow ||
        dictationWindow.isDestroyed() ||
        event.sender !== dictationWindow.webContents
      ) {
        return { success: false, error: "Not the dictation window" };
      }
      this.windowManager.setAssistantPanelOpen(open);
      return { success: true };
    });

    // Busy state is enforced in the main process so a hotkey cannot trigger
    // native capture side effects before the renderer has a chance to reject it.
    ipcMain.handle("set-assistant-panel-busy", (event, busy) => {
      const dictationWindow = this.windowManager?.mainWindow;
      if (
        !dictationWindow ||
        dictationWindow.isDestroyed() ||
        event.sender !== dictationWindow.webContents
      ) {
        return { success: false, error: "Not the dictation window" };
      }
      this.windowManager.setAssistantPanelBusy(busy);
      return { success: true };
    });

    const isAgentDictationPill = (event) => {
      const pillWindow = this.windowManager?.agentDictationPillWindow;
      return pillWindow && !pillWindow.isDestroyed() && event.sender === pillWindow.webContents;
    };

    // The pill disables its own controls when an assistant or translation
    // capture owns the lifecycle, but that state travels by IPC — a click can
    // race it. Re-check here so a stale pill can never toggle or cancel a
    // recording it does not own.
    const isAgentDictationPillInteractive = () =>
      this.windowManager.getAgentDictationPillState().interactive;

    ipcMain.handle("toggle-agent-panel-dictation", (event) => {
      if (!isAgentDictationPill(event) || !isAgentDictationPillInteractive()) {
        return { success: false };
      }
      this.windowManager.sendToggleDictation();
      return { success: true };
    });

    ipcMain.handle("cancel-agent-panel-dictation", (event) => {
      if (!isAgentDictationPill(event) || !isAgentDictationPillInteractive()) {
        return { success: false };
      }
      this.windowManager.sendCancelActiveDictation();
      return { success: true };
    });

    ipcMain.handle("get-agent-dictation-pill-state", (event) => {
      return isAgentDictationPill(event)
        ? this.windowManager.getAgentDictationPillState()
        : { lifecycle: "idle", interactive: false, horizontalDirection: "left" };
    });

    ipcMain.handle("resize-agent-dictation-pill-to-content", (event, surfaceHeight = null) => {
      if (!isAgentDictationPill(event)) return { success: false };
      return this.windowManager.resizeAgentDictationPillToContent(surfaceHeight);
    });

    ipcMain.handle("set-agent-dictation-pill-interactivity", (event, interactive) => {
      if (!isAgentDictationPill(event)) return { success: false };
      this.windowManager.setAgentDictationPillInteractivity(Boolean(interactive));
      return { success: true };
    });

    ipcMain.handle("open-calendar-privacy-settings", () => openSystemSettings("calendars"));

    ipcMain.handle("toggle-media-playback", () => {
      const mediaPlayer = require("./mediaPlayer");
      return mediaPlayer.toggleMedia();
    });

    ipcMain.handle("pause-media-playback", () => {
      const mediaPlayer = require("./mediaPlayer");
      return mediaPlayer.pauseMedia();
    });

    ipcMain.handle("resume-media-playback", () => {
      const mediaPlayer = require("./mediaPlayer");
      return mediaPlayer.resumeMedia();
    });

    ipcMain.handle("request-microphone-access", async () => {
      if (process.platform !== "darwin") {
        return { granted: true, status: "granted" };
      }
      const granted = await systemPreferences.askForMediaAccess("microphone");
      return { granted };
    });

    ipcMain.handle("check-microphone-access", () => {
      if (process.platform !== "darwin") {
        return { granted: true, status: "granted" };
      }
      const status = systemPreferences.getMediaAccessStatus("microphone");
      return { granted: status === "granted", status };
    });

    const buildSystemAudioAccess = (partial = {}) => ({
      granted: false,
      status: "unsupported",
      mode: "unsupported",
      supportsPersistentGrant: false,
      supportsPersistentPortalGrant: false,
      supportsNativeCapture: false,
      supportsOnboardingGrant: false,
      requiresRuntimeSharePrompt: false,
      strategy: "unsupported",
      restoreTokenAvailable: false,
      portalVersion: null,
      ...partial,
    });

    const getLinuxSystemAudioAccess = async () => {
      const capability = await this.linuxPortalAudioManager?.getCapability().catch((error) => ({
        available: false,
        supportsPersistentGrant: false,
        supportsPersistentPortalGrant: false,
        supportsSystemAudio: false,
        supportsNativeCapture: false,
        portalVersion: null,
        error: error.message,
      }));
      const available = !!capability?.available;
      const supportsSystemAudio = !!capability?.supportsSystemAudio;
      const supportsNativeCapture = !!capability?.supportsNativeCapture;
      const granted = available && supportsSystemAudio && supportsNativeCapture;
      const helperError =
        typeof capability?.error === "string" &&
        !capability.error.includes("helper binary not found")
          ? capability.error
          : undefined;

      return buildSystemAudioAccess({
        granted,
        status: granted ? "granted" : "unknown",
        mode: granted ? "loopback" : "unsupported",
        supportsNativeCapture,
        strategy: granted ? "pipewire-loopback" : "unsupported",
        portalVersion: capability?.portalVersion ?? null,
        error: helperError,
      });
    };

    // System audio is always capturable on Windows: via the native WASAPI
    // process-loopback helper when available (hears every output device),
    // otherwise via Chromium's default-device loopback in the renderer.
    const getWindowsSystemAudioAccess = async ({ refreshCapability = false } = {}) => {
      const capability = await this.windowsLoopbackAudioManager
        ?.getCapability({ force: refreshCapability })
        .catch(() => ({
          available: false,
        }));
      const helperAvailable = !!capability?.available;

      return buildSystemAudioAccess({
        granted: true,
        status: "granted",
        mode: "loopback",
        supportsNativeCapture: helperAvailable,
        strategy: helperAvailable ? "wasapi-loopback" : "loopback",
      });
    };

    const getSystemAudioAccess = async () => {
      if (process.platform === "win32") {
        return getWindowsSystemAudioAccess();
      }

      if (process.platform === "linux") {
        return getLinuxSystemAudioAccess();
      }

      if (!this.audioTapManager?.isSupported()) {
        return buildSystemAudioAccess();
      }

      const result = this.audioTapManager.checkAccess();
      return buildSystemAudioAccess({
        granted: result.granted,
        status: result.status,
        mode: "native",
        strategy: "native",
      });
    };

    ipcMain.handle("check-system-audio-access", () => getSystemAudioAccess());

    ipcMain.handle("permission-guide-verify-system-audio", async () => {
      if (!this.audioTapManager?.isSupported()) return buildSystemAudioAccess();
      const result = await this.audioTapManager.requestAccess();
      return buildSystemAudioAccess({ ...result, mode: "native", strategy: "native" });
    });

    ipcMain.handle("request-system-audio-access", async () => {
      if (process.platform === "win32") {
        return getWindowsSystemAudioAccess();
      }

      if (process.platform === "linux") {
        return getLinuxSystemAudioAccess();
      }

      if (!this.audioTapManager?.isSupported()) {
        return buildSystemAudioAccess();
      }

      try {
        const result = await this.audioTapManager.requestAccess();
        if (result.granted) {
          return buildSystemAudioAccess({
            granted: true,
            status: "granted",
            mode: "native",
            strategy: "native",
          });
        }
      } catch {
        // Falls through to opening System Settings
      }

      await openSystemSettings("systemAudio");
      const status = this.audioTapManager.getPermissionStatus();
      return buildSystemAudioAccess({
        granted: false,
        status,
        mode: "native",
        strategy: "native",
      });
    });

    // Honors system proxy via Electron's net stack. useSessionCookies:false so
    // Electron doesn't auto-attach jar cookies on top of our explicit headers.
    const proxyFetch = (url, init = {}) => net.fetch(url, { ...init, useSessionCookies: false });

    // The self-hosted server's key is optional; send it only when one is saved.
    const selfHostedAuthHeaders = () => {
      const apiKey = this.environmentManager.getCustomTranscriptionKey();
      return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
    };

    ipcMain.handle("retry-transcription", async (_event, id, settings) => {
      const buffer = this.audioStorageManager.getAudioBuffer(id);
      if (!buffer) return { success: false, error: "Audio file not found" };
      let providerErrorContext = null;
      try {
        let result;
        const preferredLanguage = settings?.preferredLanguage;
        const language =
          preferredLanguage && preferredLanguage !== "auto"
            ? preferredLanguage.split("-")[0]
            : undefined;
        const { resolveTranscriptionRoute } = await import("./transcriptionRoute.ts");
        // Renderer pre-flight owns policy; retry re-routes stored audio through
        // whatever is selected NOW.
        const route = resolveTranscriptionRoute({
          settings: settings || {},
          request: { effectiveLanguage: language },
        });

        if (route.transport === "error") {
          const err = new Error(route.message);
          if (route.code) err.code = route.code;
          if (route.messageKey) err.messageKey = route.messageKey;
          throw err;
        }

        if (route.transport === "http-batch") {
          providerErrorContext = {
            provider: "self-hosted",
            selfHosted: true,
            model: route.model,
            surface: "transcription",
          };
          // Fresh dictations re-encode WebM for servers that only take
          // WAV/MP3/FLAC (src/utils/audioContainer.ts); retries upload stored
          // audio from here, so they need the same step or every retry of a
          // dictation that failed for that reason fails again.
          const { convertBufferToWav, isWavFormat } = require("./ffmpegUtils");
          let uploadBuffer = buffer;
          let uploadType = "audio/webm";
          let uploadName = "audio.webm";
          if (buffer.length && !isWavFormat(buffer)) {
            try {
              const wavBuffer = await convertBufferToWav(buffer);
              // Match fresh dictation: PCM expansion must not break an upload
              // the server could accept in its original container.
              if (wavBuffer.length <= WAV_UPLOAD_LIMIT_BYTES) {
                uploadBuffer = wavBuffer;
                uploadType = "audio/wav";
                uploadName = "audio.wav";
              }
            } catch (conversionError) {
              debugLogger.warn("WAV re-encode failed on retry; uploading stored container", {
                error: conversionError?.message,
              });
            }
          }

          const formData = new FormData();
          formData.append("file", new Blob([uploadBuffer], { type: uploadType }), uploadName);
          if (route.model) {
            formData.append("model", route.model);
          }
          if (route.language) {
            formData.append("language", route.language);
          }

          const response = await proxyFetch(route.endpoint, {
            method: "POST",
            headers: selfHostedAuthHeaders(),
            body: formData,
          });
          if (!response.ok) {
            const errorText = await response.text();
            debugLogger.warn("Self-hosted retry failed", {
              status: response.status,
              body: redactProviderBody(errorText),
            });
            throw providerHttpError({
              ...providerErrorContext,
              status: response.status,
              body: errorText,
              headers: response.headers,
            });
          }
          const data = await response.json();
          result = {
            text: data?.text,
            source: "self-hosted",
            model: route.model,
          };
        } else if (isSherpaLocalProvider(settings.localTranscriptionProvider)) {
          const model =
            (settings.localTranscriptionProvider === "cohere"
              ? settings.cohereModel
              : settings.parakeetModel) ||
            process.env.PARAKEET_MODEL ||
            "parakeet-tdt-0.6b-v3";
          result = await this.parakeetManager.transcribeLocalParakeet(buffer, {
            model,
            language,
          });
        } else if (this.whisperManager?.serverManager?.isAvailable?.()) {
          const vadOptions = this._resolveWhisperVadOptions("noteRecording");
          result = await this.whisperManager.transcribeLocalWhisper(buffer, {
            model: settings.whisperModel,
            language,
            ...vadOptions,
          });
        }

        if (result?.success === false) {
          throw localTranscriptionFailure(result);
        }
        if (!result) {
          return { success: false, error: "No transcription engine available" };
        }
        if (!result.text) {
          throw Object.assign(new Error("No speech detected in audio"), {
            code: "NO_SPEECH_DETECTED",
          });
        }

        this.databaseManager.updateTranscriptionText(id, result.text, result.text);
        this.databaseManager.updateTranscriptionStatus(id, "completed");
        this.noteFilesSync.appendDictation(result.text);
        const providerName = result.source || "local";
        const modelName = result.model || null;
        const existingRow = this.databaseManager.getTranscriptionById(id);
        this.databaseManager.updateTranscriptionAudio(id, {
          hasAudio: 1,
          audioDurationMs: existingRow?.audio_duration_ms ?? null,
          provider: providerName,
          model: modelName,
        });
        const updated = this.databaseManager.getTranscriptionById(id);
        if (updated) {
          setImmediate(() => {
            broadcastToWindows("transcription-updated", updated);
            // A row that just reached "completed" is newly eligible.
            void this._ensureAnalyticsHistoryBackfilled();
          });
        }
        // A partial result (local truncation, lost cloud chunks) still replaces the
        // row, as dictation keeps it, but the renderer must say so.
        return {
          success: true,
          transcription: updated,
          ...(result.warning ? { warning: result.warning } : {}),
        };
      } catch (rawError) {
        const error = providerErrorContext
          ? asProviderError(rawError, providerErrorContext)
          : rawError;
        debugLogger.error(
          "Retry transcription failed",
          { id, error: error.message, code: error.code },
          "audio-storage"
        );
        if (error.code === "NO_SPEECH_DETECTED" && !error.messageKey) {
          // Every engine reports silence with this code, so it is translated
          // here once rather than per route.
          error.messageKey = "notes.upload.noSpeechDetected";
        }
        if (error.code) {
          return { success: false, ...ipcErrorFields(error) };
        }
        return { success: false, error: error.message };
      }
    });

    let meetingTranscriptionStartInProgress = false;

    const DUPLICATE_TRANSCRIPT_WINDOW_MS = 6000;
    const DUPLICATE_TRANSCRIPT_MERGE_LIMIT = 3;
    const LOCAL_MEETING_CHUNK_INTERVAL_MS = 5000;
    // Must outlast one local transcription cycle so a straddling remote
    // utterance's next-cycle system transcript can confirm buffered echo.
    const LOCAL_RISKY_MIC_SEGMENT_HOLDBACK_MS = LOCAL_MEETING_CHUNK_INTERVAL_MS + 1000;
    const RACING_MIC_RETRACT_WINDOW_MS = 4000;

    const buildNearbyTranscriptCandidates = (
      targetSource,
      timestamp,
      { extraSegment = null } = {}
    ) => {
      const relevant = meetingDiarizationSegments.filter(
        (candidate) =>
          candidate.source === targetSource && candidate.timestamp != null && candidate.text
      );

      return buildMergedCandidates({
        segments: relevant,
        timestamp,
        windowMs: DUPLICATE_TRANSCRIPT_WINDOW_MS,
        mergeLimit: DUPLICATE_TRANSCRIPT_MERGE_LIMIT,
        extraSegment,
      });
    };

    const hasNearbyTranscriptMatch = (targetSource, text, timestamp, options = {}) => {
      if (!text) return false;

      const matcher = options.relaxed ? transcriptsLooselyOverlap : transcriptsOverlap;
      const candidates = buildNearbyTranscriptCandidates(targetSource, timestamp, options);
      for (const candidateText of candidates) {
        if (matcher(text, candidateText)) {
          return true;
        }
      }

      return false;
    };

    const shouldSkipDuplicateMicSegment = (text, timestamp, suppression = null) =>
      isDuplicateMicSegment({ text, timestamp, suppression, hasNearbyTranscriptMatch });

    const isWithinMeetingStartupWarmup = () =>
      meetingStartedAt != null && Date.now() - meetingStartedAt < MEETING_STARTUP_WARMUP_MS;

    const hasRiskyMicDuplicateProfile = (suppression = null) =>
      isRiskyMicDuplicateProfile({
        suppression,
        inStartupWarmup: isWithinMeetingStartupWarmup(),
      });

    const removeRacingMicEntriesFor = (systemText, systemTimestamp) => {
      const indices = selectRacingMicEntryIndices({
        segments: meetingDiarizationSegments,
        systemText,
        systemTimestamp,
        hasNearbyTranscriptMatch,
        duplicateWindowMs: DUPLICATE_TRANSCRIPT_WINDOW_MS,
        retractWindowMs: RACING_MIC_RETRACT_WINDOW_MS,
      });
      const removed = [];
      // Indices are descending, so splicing in order never shifts a later index.
      for (const index of indices) {
        removed.push(meetingDiarizationSegments[index]);
        meetingDiarizationSegments.splice(index, 1);
      }
      // The renderer stops applying retracts once a stop begins, so the
      // diarization result must name them for its persisted copy (#2781).
      meetingRetractedMicSegments.push(...removed);
      return removed;
    };

    const appendMeetingLocalTranscript = (text) => {
      if (!text) return;
      meetingLocalTranscript += `${meetingLocalTranscript ? " " : ""}${text}`;
    };

    // Held-back mic segments are appended at release time, so insertion order
    // is not spoken order.
    const buildOrderedTranscriptText = (segments) =>
      segments
        .slice()
        .sort((left, right) => (left.timestamp ?? 0) - (right.timestamp ?? 0))
        .map((segment) => segment.text)
        .join(" ")
        .trim();

    const storeMeetingDiarizationSegment = (
      text,
      source,
      timestamp,
      micSuppression = null,
      audioStartedAt = null
    ) => {
      meetingDiarizationSegments.push({
        text,
        source,
        timestamp,
        audioStartedAt,
        committedAt: Date.now(),
        suppressionReason: source === "mic" ? micSuppression?.reason || null : null,
        hasBleedEvidence: source === "mic" ? !!micSuppression?.hasBleedEvidence : false,
        likelyRenderBleed: source === "mic" ? !!micSuppression?.likelyRenderBleed : false,
      });
    };

    const sendMeetingFinalSegment = ({
      text,
      source,
      timestamp,
      micSuppression = null,
      audioStartedAt = null,
      send = null,
      includeInLocalTranscript = false,
    }) => {
      if (includeInLocalTranscript) {
        appendMeetingLocalTranscript(text);
      }

      storeMeetingDiarizationSegment(text, source, timestamp, micSuppression, audioStartedAt);

      if (send) {
        send("meeting-transcription-segment", {
          text,
          source,
          type: "final",
          timestamp,
        });
      }
    };

    function flushPendingMicFinals(force = false) {
      if (meetingPendingMicFinals.length === 0) {
        if (meetingPendingMicFinalTimer) {
          clearTimeout(meetingPendingMicFinalTimer);
          meetingPendingMicFinalTimer = null;
        }
        return;
      }

      const { deferred, duplicates, releases } = partitionPendingMicFinals({
        pending: meetingPendingMicFinals,
        now: Date.now(),
        force,
        isDuplicate: (entry) =>
          shouldSkipDuplicateMicSegment(entry.text, entry.timestamp, entry.micSuppression),
      });

      meetingPendingMicFinals = deferred;
      schedulePendingMicFinalFlush();

      for (const pending of duplicates) {
        debugLogger.debug(
          "Dropping buffered mic segment after system context confirmed duplicate",
          {
            text: pending.text.slice(0, 80),
            averageCorrelation: pending.micSuppression?.averageCorrelation?.toFixed(3),
            averageResidual: pending.micSuppression?.averageResidual?.toFixed(3),
          }
        );
      }

      for (const pending of releases) {
        debugLogger.debug(
          pending.micSuppression?.hasBleedEvidence
            ? "Releasing bleed-flagged mic segment after holdback (no transcript match)"
            : "Releasing buffered mic segment after duplicate holdback",
          {
            text: pending.text.slice(0, 80),
            holdbackMs: pending.holdbackMs,
            reason: pending.micSuppression?.reason,
            averageCorrelation: pending.micSuppression?.averageCorrelation?.toFixed(3),
            averageResidual: pending.micSuppression?.averageResidual?.toFixed(3),
          }
        );
        pending.emit();
      }
    }

    const schedulePendingMicFinalFlush = () => {
      if (meetingPendingMicFinalTimer) {
        clearTimeout(meetingPendingMicFinalTimer);
        meetingPendingMicFinalTimer = null;
      }

      if (meetingPendingMicFinals.length === 0) {
        return;
      }

      const nextDelay = Math.max(0, meetingPendingMicFinals[0].releaseAt - Date.now());
      meetingPendingMicFinalTimer = setTimeout(() => {
        meetingPendingMicFinalTimer = null;
        flushPendingMicFinals();
      }, nextDelay);
    };

    const resetPendingMicFinals = () => {
      meetingPendingMicFinals = [];
      if (meetingPendingMicFinalTimer) {
        clearTimeout(meetingPendingMicFinalTimer);
        meetingPendingMicFinalTimer = null;
      }
    };

    const removePendingMicFinalsFor = (systemText, systemTimestamp) => {
      const { kept, removed } = partitionOverlappingPendingMicFinals({
        pending: meetingPendingMicFinals,
        systemText,
        systemTimestamp,
        hasNearbyTranscriptMatch,
      });
      meetingPendingMicFinals = kept;
      schedulePendingMicFinalFlush();
      return removed;
    };

    const queuePendingMicFinal = ({ text, timestamp, micSuppression, holdbackMs, emit }) => {
      meetingPendingMicFinals.push({
        text,
        timestamp,
        micSuppression,
        holdbackMs,
        releaseAt: Date.now() + holdbackMs,
        emit,
      });
      meetingPendingMicFinals.sort((left, right) => left.releaseAt - right.releaseAt);
      schedulePendingMicFinalFlush();
    };

    const captureMeetingDiarizationState = async () => {
      const systemPcmPath = meetingDiarizationPath;
      const systemStartedAt = meetingDiarizationStartedAt;
      const micPcmPath = meetingMicDiarizationPath;
      const micStartedAt = meetingMicDiarizationStartedAt;
      const systemAudioHeard = meetingSystemAudioHeard;
      const diarizationSegments = meetingDiarizationSegments;
      const retractedSegments = meetingRetractedMicSegments;
      if (meetingDiarizationStream) {
        await new Promise((resolve) => meetingDiarizationStream.end(resolve));
        meetingDiarizationStream = null;
      }
      if (meetingMicDiarizationStream) {
        await new Promise((resolve) => meetingMicDiarizationStream.end(resolve));
        meetingMicDiarizationStream = null;
      }
      meetingDiarizationPath = null;
      meetingDiarizationStartedAt = null;
      meetingMicDiarizationPath = null;
      meetingMicDiarizationStartedAt = null;
      meetingSystemAudioHeard = false;
      meetingSystemAudioHandover.reset();
      meetingDiarizationSegments = [];
      meetingRetractedMicSegments = [];
      let systemIsCall = systemAudioHeard;
      if (systemPcmPath && micPcmPath) {
        try {
          const systemAudio = await measurePcmAudio(systemPcmPath);
          systemIsCall = isCallAudio(systemAudio);
          debugLogger.info("Meeting diarization source chosen", { ...systemAudio, systemIsCall });
        } catch (error) {
          debugLogger.warn("Measuring meeting system audio failed", { error: error.message });
        }
      }
      const { pcmPath, startedAt, diarizedSource, alternate } = resolveDiarizationInput({
        systemPcmPath,
        micPcmPath,
        systemIsCall,
        systemStartedAt,
        micStartedAt,
      });
      return {
        diarizationPcmPath: pcmPath,
        diarizationSegments,
        retractedSegments,
        diarizationStartedAt: startedAt,
        diarizedSource,
        alternateCapture: alternate,
      };
    };

    const getMeetingSystemAudioCapabilityMode = () => {
      if (this.audioTapManager?.isSupported()) return "native";
      if (process.platform === "win32") return "loopback";
      if (process.platform === "linux") return "loopback";
      return "unsupported";
    };

    const getMeetingSystemAudioMode = () => getMeetingSystemAudioCapabilityMode();

    const getMeetingSystemAudioPlan = async ({ refreshWindowsCapability = false } = {}) => {
      const mode = getMeetingSystemAudioMode();
      if (mode === "unsupported") {
        return { mode, strategy: "unsupported" };
      }

      if (mode === "native") {
        return { mode, strategy: "native" };
      }

      if (process.platform === "linux") {
        const linuxAccess = await getLinuxSystemAudioAccess();
        return {
          mode: linuxAccess.mode,
          strategy: linuxAccess.strategy || "unsupported",
        };
      }

      if (process.platform === "win32") {
        const windowsAccess = await getWindowsSystemAudioAccess({
          refreshCapability: refreshWindowsCapability,
        });
        return { mode: windowsAccess.mode, strategy: windowsAccess.strategy };
      }

      // Unreachable today (loopback implies win32 or linux, both handled
      // above), but callers destructure the result, so never return undefined.
      return { mode, strategy: "unsupported" };
    };

    const hasNativeMeetingSystemAudio = () => getMeetingSystemAudioMode() === "native";

    const MEETING_MIC_REFERENCE_ALIGNMENT_MS = 320;
    const MEETING_STARTUP_WARMUP_MS = 1500;
    const MEETING_SYSTEM_AUDIO_SILENCE_WARNING_MS = 45000;
    const MEETING_SYSTEM_AUDIO_TICK_MS = 2000;
    let meetingSystemAudioSilenceTimer = null;
    let meetingSystemAudioTicker = null;
    let meetingSystemAudioWatchdogWin = null;

    const meetingSystemAudioWatchdog = createMeetingSystemAudioWatchdog({
      onResumed: () => {
        const win = meetingSystemAudioWatchdogWin;
        if (win && !win.isDestroyed()) {
          win.webContents.send("meeting-system-audio-resumed");
        }
      },
      onInterrupted: (payload) => {
        // debugLogger.error flattens its arguments into one string, dropping
        // both the meta and the scope, so the give-up event would vanish from a
        // log filtered on "meeting", the one filter used to triage this bug.
        if (payload.recovering) {
          debugLogger.warn("Meeting system audio interrupted, restarting", payload, "meeting");
        } else {
          debugLogger.warn("Meeting system audio capture gave up", payload, "meeting");
        }
        const win = meetingSystemAudioWatchdogWin;
        if (win && !win.isDestroyed()) {
          win.webContents.send("meeting-system-audio-interrupted", payload);
        }
      },
    });
    let meetingStartedAt = null;
    const meetingEchoLeakDetector = new MeetingEchoLeakDetector();

    const fs = require("fs");
    let meetingDiarizationStream = null;
    let meetingDiarizationPath = null;
    let meetingDiarizationStartedAt = null;
    // Parallel raw mic capture so an in-person session (no audible system
    // audio) can be diarized; dropped as soon as the session proves to be a call.
    let meetingMicDiarizationStream = null;
    let meetingMicDiarizationPath = null;
    let meetingMicDiarizationStartedAt = null;
    let meetingSystemAudioHeard = false;
    const meetingSystemAudioHandover = createMeetingSystemAudioHandover();
    let meetingDiarizationSegments = [];
    let meetingRetractedMicSegments = [];
    let meetingLiveSpeakerActive = false;
    let meetingLiveSpeakerState = null;
    let meetingLiveSpeakerStartedAt = null;
    let meetingReclusterTimer = null;

    let meetingLocalMode = false;
    let meetingLocalBuffers = { mic: [], system: [] };
    let meetingLocalTimer = null;
    let meetingLocalWin = null;
    let meetingLocalTranscript = "";
    let meetingLocalProvider = null;
    let meetingLocalModel = null;
    let meetingLocalLanguage = null;
    // The pass that is transcribing buffered audio, if any. Stop and rollback
    // await it: a pass that finished after the reset would push its finals into
    // the next session and send them to no window.
    let meetingLocalTranscribePromise = null;
    // Set when Note Recording transcribes on a self-hosted server instead of
    // the local engine; see selfHostedMeetingTranscriber.js for the queue policy.
    let meetingRemoteTranscriber = null;
    let meetingRemoteFailureReported = false;
    let meetingPendingMicChunks = [];
    let meetingPendingMicFinals = [];
    let meetingPendingMicFinalTimer = null;
    let meetingAecEnabled = false;
    // The options of the meeting being started (echo cancellation opt-in).
    let meetingConnectionOptions = null;
    let meetingOneOnOneAttendee = null;
    let meetingOneOnOneProfileBound = false;
    let meetingNoteId = null;
    // First speaker index this session may mint; past a resumed note's ids.
    let meetingSpeakerIndexBase = 0;

    const getLiveSpeakerProfiles = () => {
      const attendees = this._getNoteNonSelfParticipants(meetingNoteId);
      const attendeeEmails = new Set();
      for (const p of attendees) {
        const email = (p.email || "").toLowerCase().trim();
        if (email) attendeeEmails.add(email);
      }
      if (attendeeEmails.size === 0) return [];
      return this.databaseManager
        .getSpeakerProfiles(true)
        .filter((p) => p.email && attendeeEmails.has(p.email.toLowerCase()));
    };
    const shouldSuppressMicTranscriptSegment = (startedAt, endedAt = Date.now()) =>
      meetingEchoLeakDetector.shouldSuppressMicSegment(startedAt, endedAt);

    const resolveOneOnOneAttendeeForNote = (noteId) => {
      if (!noteId) return null;
      try {
        const note = this.databaseManager.getNote(noteId);
        return this._resolveOneOnOneOtherParticipant(note?.participants);
      } catch (_) {
        return null;
      }
    };

    const resolveDiarizationEnabled = () =>
      (this.activeMeetingSpeakerConfig?.enabled ?? this.speakerDiarizationEnabled) !== false;

    const resolveSessionMaxSpeakers = () => {
      const count = this.activeMeetingSpeakerConfig?.expectedCount;
      const total = count ? Math.min(count, LIVE_SPEAKER_LIMIT) : DEFAULT_EXPECTED_SPEAKER_COUNT;
      return Math.max(1, total - 1);
    };

    const bindOneOnOneAttendeeToSpeaker = (speakerId) => {
      if (!meetingOneOnOneAttendee || meetingOneOnOneProfileBound || !speakerId) return;
      if (!resolveDiarizationEnabled()) return;
      const embedding = liveSpeakerIdentifier.getSpeakerEmbedding(speakerId);
      if (!embedding) return;
      try {
        const buffer = Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
        const profile = this.databaseManager.upsertSpeakerProfile(
          meetingOneOnOneAttendee.displayName,
          meetingOneOnOneAttendee.email,
          buffer
        );
        liveSpeakerIdentifier.mapSpeaker(
          speakerId,
          profile.id,
          meetingOneOnOneAttendee.displayName,
          null
        );
        meetingOneOnOneProfileBound = true;
      } catch (error) {
        debugLogger.warn(
          "1-on-1 attendee profile binding failed",
          { error: error.message },
          "speaker"
        );
      }
    };

    const dispatchMeetingAudioBuffer = (buffer, source, synthetic = false) => {
      if (!meetingLocalMode) return;
      // Local STT timestamps each batch with wall time, not a sample cursor.
      // Large synthetic gaps would dilute speech and inflate the next batch.
      if (synthetic) return;
      meetingLocalBuffers[source].push(buffer);
    };

    const stopMeetingAec = async () => {
      meetingAecEnabled = false;
      if (this.meetingAecManager) {
        await this.meetingAecManager.stop().catch(() => {});
      }
    };

    const startMeetingAec = async (systemAudioMode) => {
      meetingAecEnabled = false;
      if (meetingConnectionOptions?.aecEnabled !== true) {
        return false;
      }
      if (systemAudioMode === "unsupported" || !this.meetingAecManager?.isAvailable()) {
        return false;
      }

      const started = await this.meetingAecManager
        .start({
          onMicChunk: (chunk) => {
            dispatchMeetingAudioBuffer(chunk, "mic");
          },
          onError: (error) => {
            debugLogger.warn("Meeting AEC helper disabled", { error: error.message }, "meeting");
            meetingAecEnabled = false;
            void this.meetingAecManager.stop().catch(() => {});
          },
          onWarning: (warning) => {
            debugLogger.debug("Meeting AEC helper warning", warning, "meeting");
          },
        })
        .catch((error) => {
          debugLogger.warn("Meeting AEC helper start failed", { error: error.message }, "meeting");
          return false;
        });

      meetingAecEnabled = !!started;
      if (meetingAecEnabled) {
        debugLogger.info("Meeting AEC helper started", { systemAudioMode }, "meeting");
      }
      return meetingAecEnabled;
    };

    const flushPendingMeetingMicChunks = (force = false) => {
      if (!meetingPendingMicChunks.length) {
        return;
      }

      const now = Date.now();
      while (meetingPendingMicChunks.length > 0) {
        const next = meetingPendingMicChunks[0];
        if (!force && now - next.queuedAt < MEETING_MIC_REFERENCE_ALIGNMENT_MS) {
          break;
        }

        meetingPendingMicChunks.shift();
        const analysis = meetingEchoLeakDetector.analyzeMicChunk(next.buffer);
        if (next.analysisOnly) {
          continue;
        }
        if (analysis?.shouldMute && !meetingAecEnabled) continue;

        dispatchMeetingAudioBuffer(next.buffer, "mic");
      }
    };

    const processMeetingMicWithAec = (buffer) => {
      if (!meetingAecEnabled) {
        return false;
      }

      const sent = this.meetingAecManager?.processMicBuffer(buffer);
      if (sent) {
        meetingPendingMicChunks.push({
          buffer,
          queuedAt: Date.now(),
          analysisOnly: true,
        });
        flushPendingMeetingMicChunks();
        return true;
      }

      meetingAecEnabled = false;
      return false;
    };

    const stopLiveSpeakerIdentification = async () => {
      if (!meetingLiveSpeakerActive) {
        return null;
      }

      if (meetingReclusterTimer) {
        clearInterval(meetingReclusterTimer);
        meetingReclusterTimer = null;
      }

      meetingLiveSpeakerActive = false;
      meetingLiveSpeakerState = await liveSpeakerIdentifier.stop();
      return meetingLiveSpeakerState;
    };

    const startLiveSpeakerIdentification = async (win, systemAudioMode) => {
      await stopLiveSpeakerIdentification();

      if (
        !supportsLiveSpeakerIdentification(systemAudioMode) ||
        !liveSpeakerIdentifier.isAvailable()
      ) {
        return false;
      }

      const diarizationEnabled = resolveDiarizationEnabled();
      if (!diarizationEnabled) {
        return false;
      }

      meetingLiveSpeakerState = null;
      // Anchored on the first system chunk instead, in sendMeetingAudio.
      meetingLiveSpeakerStartedAt = null;
      const started = await liveSpeakerIdentifier
        .start(
          (identification) => {
            if (!win || win.isDestroyed() || meetingLiveSpeakerStartedAt == null) {
              return;
            }

            bindOneOnOneAttendeeToSpeaker(identification.speakerId);

            const displayName = meetingOneOnOneAttendee
              ? meetingOneOnOneAttendee.displayName
              : identification.displayName;

            const startTime = Math.max(
              meetingLiveSpeakerStartedAt,
              meetingLiveSpeakerStartedAt + identification.startTime * 1000
            );
            const endTime = Math.max(
              startTime,
              meetingLiveSpeakerStartedAt + identification.endTime * 1000
            );
            const enrichedIdentification = {
              ...identification,
              displayName,
              startTime,
              endTime,
            };

            win.webContents.send("meeting-speaker-identified", enrichedIdentification);

            for (const seg of meetingDiarizationSegments) {
              if (
                seg.source === "system" &&
                seg.timestamp != null &&
                seg.timestamp >= startTime &&
                seg.timestamp <= endTime &&
                (!seg.speaker || seg.speakerIsPlaceholder)
              ) {
                applyConfirmedSpeaker(seg, {
                  speaker: identification.speakerId,
                  speakerName: displayName || seg.speakerName,
                  speakerIsPlaceholder: false,
                });
              }
            }
          },
          {
            getSpeakerProfiles: getLiveSpeakerProfiles,
            maxSpeakers: resolveSessionMaxSpeakers(),
            enabled: true,
            speakerIndexBase: meetingSpeakerIndexBase,
          }
        )
        .catch((error) => {
          // isAvailable() only stats the model file, so a corrupt model or an
          // onnxruntime binding that won't load still throws here. Speaker labels
          // are an enhancement — never let them take the recording down with them.
          debugLogger.warn(
            "Live speaker identification start failed",
            { error: error.message },
            "speaker"
          );
          return false;
        });

      if (started) {
        meetingLiveSpeakerActive = true;
        meetingReclusterTimer = setInterval(async () => {
          if (!meetingLiveSpeakerActive || !win || win.isDestroyed()) return;

          const merges = await liveSpeakerIdentifier.recluster();
          if (!merges.length) return;

          for (const { keep, remove, displayName } of merges) {
            for (const seg of meetingDiarizationSegments) {
              if (seg.speaker === remove) {
                seg.speaker = keep;
                if (displayName) seg.speakerName = displayName;
              }
            }
          }

          win.webContents.send("meeting-speakers-merged", merges);
        }, 30_000);
      } else {
        meetingLiveSpeakerStartedAt = null;
      }

      return started;
    };

    // Once per failure streak, so a down server raises one warning rather than
    // one every chunk; the recording itself keeps running.
    const reportRemoteMeetingFailure = () => {
      if (meetingRemoteFailureReported) return;
      meetingRemoteFailureReported = true;
      if (meetingLocalWin && !meetingLocalWin.isDestroyed()) {
        meetingLocalWin.webContents.send(
          "meeting-transcription-error",
          "remoteTranscriptionFailed"
        );
      }
    };

    const transcribeLocalMeetingChunk = async (source) => {
      let chunks = meetingLocalBuffers[source];
      if (!chunks.length) return;
      meetingLocalBuffers[source] = [];

      if (meetingRemoteTranscriber) {
        const capped = capMeetingBacklog(chunks);
        chunks = capped.chunks;
        if (capped.droppedBytes > 0) {
          debugLogger.warn("Self-hosted meeting transcription fell behind; dropped oldest audio", {
            source,
            droppedMs: Math.round((capped.droppedBytes / 2 / 24000) * 1000),
          });
          reportRemoteMeetingFailure();
        }
      }

      const pcm24k = Buffer.concat(chunks);
      // The batch is the audio that arrived up to now. Its text comes back a
      // transcription round trip later, so segment timestamps mark when the
      // text arrived; diarization needs where the audio sits on the timeline.
      const audioStartedAt = Date.now() - (pcm24k.length / 2 / 24000) * 1000;

      const pcm16k = downsample24kTo16k(pcm24k);

      const { rms, peak, sampleCount } = computeChunkStats(pcm16k);
      const verdict = resolveMicChunkAction({
        mode: "local",
        source,
        rms,
        peak,
        sampleCount,
        isSystemSpeaking: () =>
          meetingEchoLeakDetector.isSystemSpeaking(Date.now() - LOCAL_MEETING_CHUNK_INTERVAL_MS),
      });
      if (verdict.action === "skip") {
        debugLogger.debug(
          verdict.reason === "silence"
            ? "Skipping silent meeting chunk"
            : "Skipping system-dominant mic chunk",
          {
            source,
            rms: rms.toFixed(4),
            peak: peak.toFixed(4),
          }
        );
        return;
      }

      const wav = pcm16ToWav(pcm16k);

      try {
        let result;
        if (meetingRemoteTranscriber) {
          result = await meetingRemoteTranscriber.transcribe(wav);
          meetingRemoteFailureReported = false;
        } else if (isSherpaLocalProvider(meetingLocalProvider)) {
          result = await this.parakeetManager.transcribeLocalParakeet(wav, {
            model: meetingLocalModel,
            language: meetingLocalLanguage,
          });
        } else {
          const vadOptions = this._resolveWhisperVadOptions("meeting");
          result = await this.whisperManager.transcribeLocalWhisper(wav, {
            model: meetingLocalModel,
            language: meetingLocalLanguage,
            // Keep whisper.cpp's default decoder thresholds on this continuous
            // load: the raised #1458 values multiply temperature-fallback
            // re-decodes, and meeting chunks already have RMS-gate, VAD, and
            // holdback/dedup hallucination protection.
            skipDecoderThresholds: true,
            ...vadOptions,
          });
        }

        if (result?.success && result.text?.trim()) {
          const text = result.text.trim();
          const segTimestamp = Date.now();
          let micSuppression = null;
          if (source === "mic") {
            const chunkDurationMs = (pcm24k.length / 2 / 24000) * 1000;
            micSuppression = shouldSuppressMicTranscriptSegment(
              segTimestamp - chunkDurationMs,
              segTimestamp
            );
            debugLogger.debug("Local meeting transcription candidate", {
              source,
              text: text.slice(0, 80),
              suppress: micSuppression.suppress,
              reason: micSuppression.reason,
              hasBleedEvidence: micSuppression.hasBleedEvidence,
              likelyRenderBleed: micSuppression.likelyRenderBleed,
              averageCorrelation: micSuppression.averageCorrelation?.toFixed(3),
              averageResidual: micSuppression.averageResidual?.toFixed(3),
            });
            if (micSuppression.suppress) {
              debugLogger.debug("Suppressing contaminated local mic segment", {
                reason: micSuppression.reason,
                averageCorrelation: micSuppression.averageCorrelation?.toFixed(3),
                averageResidual: micSuppression.averageResidual?.toFixed(3),
                text: text.slice(0, 80),
              });
              return;
            }

            if (shouldSkipDuplicateMicSegment(text, segTimestamp, micSuppression)) {
              debugLogger.debug("Skipping duplicate local mic segment that matches system audio", {
                text: text.slice(0, 80),
                averageCorrelation: micSuppression.averageCorrelation?.toFixed(3),
                averageResidual: micSuppression.averageResidual?.toFixed(3),
              });
              return;
            }
          } else {
            debugLogger.debug("Local meeting transcription candidate", {
              source,
              text: text.slice(0, 80),
            });
          }

          if (source === "system") {
            const pending = removePendingMicFinalsFor(text, segTimestamp);
            if (pending.length > 0) {
              debugLogger.debug(
                "Dropping buffered local mic segments after system transcript arrived",
                {
                  count: pending.length,
                  text: text.slice(0, 80),
                }
              );
            }

            const retracted = removeRacingMicEntriesFor(text, segTimestamp);
            for (const stale of retracted) {
              if (meetingLocalWin && !meetingLocalWin.isDestroyed()) {
                meetingLocalWin.webContents.send("meeting-transcription-segment", {
                  text: stale.text,
                  source: "mic",
                  type: "retract",
                  timestamp: stale.timestamp,
                });
              }
            }
          }

          const sendLocalSegment = (channel, payload) => {
            if (channel !== "meeting-transcription-segment") {
              return;
            }

            if (meetingLocalWin && !meetingLocalWin.isDestroyed()) {
              meetingLocalWin.webContents.send(channel, payload);
            }
          };

          if (source === "mic" && hasRiskyMicDuplicateProfile(micSuppression)) {
            debugLogger.debug("Buffering risky local mic segment before renderer commit", {
              text: text.slice(0, 80),
              holdbackMs: LOCAL_RISKY_MIC_SEGMENT_HOLDBACK_MS,
              reason: micSuppression?.reason,
              hasBleedEvidence: micSuppression?.hasBleedEvidence,
            });
            queuePendingMicFinal({
              text,
              timestamp: segTimestamp,
              micSuppression,
              holdbackMs: LOCAL_RISKY_MIC_SEGMENT_HOLDBACK_MS,
              emit: () =>
                sendMeetingFinalSegment({
                  text,
                  source,
                  timestamp: segTimestamp,
                  micSuppression,
                  audioStartedAt,
                  send: sendLocalSegment,
                  includeInLocalTranscript: true,
                }),
            });
            return;
          }

          sendMeetingFinalSegment({
            text,
            source,
            timestamp: segTimestamp,
            micSuppression,
            audioStartedAt,
            send: sendLocalSegment,
            includeInLocalTranscript: true,
          });
        }
      } catch (error) {
        debugLogger.error("Local meeting transcription chunk failed", {
          source,
          remote: !!meetingRemoteTranscriber,
          error: error.message,
        });
        if (meetingRemoteTranscriber) {
          reportRemoteMeetingFailure();
        } else if (meetingLocalWin && !meetingLocalWin.isDestroyed()) {
          meetingLocalWin.webContents.send("meeting-transcription-error", error.message);
        }
      }
    };

    const transcribeAllLocalBuffers = () => {
      if (meetingLocalTranscribePromise) return meetingLocalTranscribePromise;
      meetingLocalTranscribePromise = (async () => {
        try {
          await transcribeLocalMeetingChunk("system");
          await transcribeLocalMeetingChunk("mic");
        } finally {
          meetingLocalTranscribePromise = null;
        }
      })();
      return meetingLocalTranscribePromise;
    };

    const settleLocalMeetingTranscription = async () => {
      if (meetingLocalTimer) {
        clearInterval(meetingLocalTimer);
        meetingLocalTimer = null;
      }
      await meetingLocalTranscribePromise?.catch(() => {});
    };

    const dropMeetingMicDiarizationCapture = () => {
      if (meetingMicDiarizationStream) {
        meetingMicDiarizationStream.end();
        meetingMicDiarizationStream = null;
      }
      if (meetingMicDiarizationPath) {
        fs.unlink(meetingMicDiarizationPath, () => {});
        meetingMicDiarizationPath = null;
      }
      meetingMicDiarizationStartedAt = null;
    };

    const resetMeetingLocalState = () => {
      if (meetingLocalTimer) {
        clearInterval(meetingLocalTimer);
        meetingLocalTimer = null;
      }
      if (meetingReclusterTimer) {
        clearInterval(meetingReclusterTimer);
        meetingReclusterTimer = null;
      }
      void stopLiveSpeakerIdentification();
      meetingLiveSpeakerState = null;
      meetingLiveSpeakerStartedAt = null;
      meetingOneOnOneAttendee = null;
      meetingOneOnOneProfileBound = false;
      meetingNoteId = null;
      meetingSpeakerIndexBase = 0;
      this._activeMeetingNoteId = null;
      meetingLocalMode = false;
      meetingLocalBuffers = { mic: [], system: [] };
      if (meetingDiarizationStream) {
        meetingDiarizationStream.end();
        meetingDiarizationStream = null;
      }
      if (meetingDiarizationPath) {
        fs.unlink(meetingDiarizationPath, () => {});
        meetingDiarizationPath = null;
      }
      meetingDiarizationStartedAt = null;
      dropMeetingMicDiarizationCapture();
      meetingSystemAudioHeard = false;
      meetingSystemAudioHandover.reset();
      meetingDiarizationSegments = [];
      meetingRetractedMicSegments = [];
      meetingLocalWin = null;
      meetingLocalTranscript = "";
      meetingLocalProvider = null;
      meetingLocalModel = null;
      meetingLocalLanguage = null;
      meetingRemoteTranscriber = null;
      meetingRemoteFailureReported = false;
      meetingPendingMicChunks = [];
      resetPendingMicFinals();
      meetingAecEnabled = false;
      meetingStartedAt = null;
      meetingEchoLeakDetector.reset();
    };

    let dictationPreviewMode = false;
    let dictationPreviewBuffer = [];
    let dictationPreviewTimer = null;
    let dictationPreviewTranscribing = false;
    let dictationPreviewProvider = null;
    let dictationPreviewModel = null;
    let dictationPreviewLanguage = null;
    let dictationPreviewSessionActive = false;
    let dictationPreviewChunkCount = 0;
    // Online-runtime models stream here instead of the 1.5s chunked path.
    let dictationPreviewStream = null;
    // false = headless streaming session (commit-only, no preview window).
    let dictationPreviewDisplay = true;
    // Bumped on every reset so async preview work can detect a stale session.
    let dictationPreviewGen = 0;
    // Keep preview completion and dismissal ordered so a late completion can
    // never reopen a dismissed window.
    let dictationPreviewOperation = Promise.resolve();

    const queueDictationPreviewOperation = (operation) => {
      const result = dictationPreviewOperation.catch(() => {}).then(operation);
      dictationPreviewOperation = result.then(
        () => undefined,
        () => undefined
      );
      return result;
    };

    const resetDictationPreviewState = ({ preserveSession = false } = {}) => {
      dictationPreviewGen++;
      if (dictationPreviewTimer) {
        clearInterval(dictationPreviewTimer);
        dictationPreviewTimer = null;
      }
      if (dictationPreviewStream) {
        dictationPreviewStream.abort();
        dictationPreviewStream = null;
      }
      dictationPreviewMode = false;
      if (!preserveSession) {
        dictationPreviewSessionActive = false;
      }
      dictationPreviewBuffer = [];
      dictationPreviewTranscribing = false;
      dictationPreviewProvider = null;
      dictationPreviewModel = null;
      dictationPreviewLanguage = null;
      dictationPreviewDisplay = true;
    };

    const startDictationPreviewTimer = () => {
      if (!dictationPreviewTimer) {
        dictationPreviewTimer = setInterval(() => transcribeDictationPreviewChunk(), 1500);
      }
    };

    const transcribeDictationPreviewChunk = async () => {
      // The chunked path only feeds the preview window.
      if (!dictationPreviewDisplay) return;
      if (dictationPreviewTranscribing) return;
      if (!dictationPreviewBuffer.length) return;

      const gen = dictationPreviewGen;
      const provider = dictationPreviewProvider;
      const model = dictationPreviewModel;
      const language = dictationPreviewLanguage;
      dictationPreviewTranscribing = true;
      try {
        const pcm = Buffer.concat(dictationPreviewBuffer);
        dictationPreviewBuffer = [];

        const samples = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.length / 2);
        let sumSq = 0;
        for (let i = 0; i < samples.length; i++) {
          const n = samples[i] / 0x7fff;
          sumSq += n * n;
        }
        const rms = Math.sqrt(sumSq / samples.length);
        debugLogger.debug("Dictation preview chunk", {
          pcmBytes: pcm.length,
          rms: rms.toFixed(6),
          samples: samples.length,
        });
        if (rms < 0.002) return;

        const wav = pcm16ToWav(pcm);

        let result;
        if (isSherpaLocalProvider(provider)) {
          result = await this.parakeetManager.transcribeLocalParakeet(wav, {
            model,
            language,
          });
        } else {
          const vadOptions = this._resolveWhisperVadOptions("dictation");
          result = await this.whisperManager.transcribeLocalWhisper(wav, {
            model,
            language,
            ...vadOptions,
          });
        }

        if (gen !== dictationPreviewGen) return;
        if (result?.success && result.text?.trim()) {
          this.windowManager.appendTranscriptionPreview(result.text.trim());
        } else if (result && !result.success) {
          debugLogger.warn("Dictation preview chunk returned failure", {
            error: result.error || result.message,
            provider,
          });
        }
      } catch (error) {
        if (gen !== dictationPreviewGen) return;
        debugLogger.error("Dictation preview transcription chunk failed", {
          error: error.message,
          provider,
        });
      } finally {
        if (gen === dictationPreviewGen) dictationPreviewTranscribing = false;
      }
    };

    const clearMeetingSystemAudioSilenceTimer = () => {
      if (meetingSystemAudioSilenceTimer) {
        clearTimeout(meetingSystemAudioSilenceTimer);
        meetingSystemAudioSilenceTimer = null;
      }
    };

    // One-shot: system capture is active but nothing audible has arrived by the
    // deadline, so tell the meeting window the remote side may be missing from
    // the transcript. Audio arriving before the deadline cancels it outright;
    // the toast itself is time-boxed by the renderer, not by later audio.
    const armMeetingSystemAudioSilenceTimer = (win, systemAudioStrategy) => {
      clearMeetingSystemAudioSilenceTimer();
      meetingSystemAudioSilenceTimer = setTimeout(() => {
        meetingSystemAudioSilenceTimer = null;
        if (meetingSystemAudioHeard) return;
        debugLogger.debug(
          "Meeting system audio still silent past warning window",
          { systemAudioStrategy, timeoutMs: MEETING_SYSTEM_AUDIO_SILENCE_WARNING_MS },
          "meeting"
        );
        if (win && !win.isDestroyed()) {
          win.webContents.send("meeting-system-audio-silent", { systemAudioStrategy });
        }
      }, MEETING_SYSTEM_AUDIO_SILENCE_WARNING_MS);
    };

    const clearMeetingSystemAudioTicker = () => {
      if (meetingSystemAudioTicker) {
        clearInterval(meetingSystemAudioTicker);
        meetingSystemAudioTicker = null;
      }
    };

    const stopMeetingSystemAudioWatchdog = () => {
      clearMeetingSystemAudioTicker();
      // Detaches the capture too, which strands any restart still in flight.
      meetingSystemAudioWatchdog.stop();
      meetingSystemAudioWatchdogWin = null;
    };

    // Rolling counterpart to the one-shot warning above, which only covers a
    // session that never produced audio and stops watching once any arrives.
    const startMeetingSystemAudioWatchdog = (win, systemAudioStrategy) => {
      // Deliberately not stopMeetingSystemAudioWatchdog(): capture is already
      // running and attached by this point, and detaching it here would leave a
      // watchdog that reports stalls it cannot recover from.
      clearMeetingSystemAudioTicker();
      meetingSystemAudioWatchdogWin = win;
      meetingSystemAudioWatchdog.start({
        systemAudioStrategy,
        // Only the macOS tap delivers a chunk every period regardless of what
        // is playing; a gap from the loopback helpers proves nothing.
        watchesDelivery: systemAudioStrategy === "native",
      });
      meetingSystemAudioTicker = setInterval(
        () => meetingSystemAudioWatchdog.tick(),
        MEETING_SYSTEM_AUDIO_TICK_MS
      );
    };

    const rollbackMeetingTranscriptionStart = async () => {
      clearMeetingSystemAudioSilenceTimer();
      stopMeetingSystemAudioWatchdog();
      if (this.audioTapManager) {
        await this.audioTapManager.stop().catch(() => {});
      }
      if (this.linuxPortalAudioManager) {
        await this.linuxPortalAudioManager.stop().catch(() => {});
      }
      if (this.windowsLoopbackAudioManager) {
        await this.windowsLoopbackAudioManager.stop().catch(() => {});
      }
      await stopMeetingAec();
      await stopLiveSpeakerIdentification().catch(() => {});
      // Late finals must land before the reset clears them.
      await settleLocalMeetingTranscription();
      resetMeetingLocalState();
      this.activeMeetingSpeakerConfig = null;
    };

    const startMeetingTranscription = async (event, options = {}) => {
      if (meetingTranscriptionStartInProgress) {
        debugLogger.debug("Meeting transcription start already in progress, ignoring");
        return { success: false, error: "Operation in progress" };
      }

      if (options.provider !== "local" && options.provider !== "self-hosted") {
        return { success: false, error: `Unsupported provider: ${options.provider}` };
      }

      meetingTranscriptionStartInProgress = true;
      // The lifecycle wrapper is the only caller and always injects the same
      // sessionId it registered; re-deriving one here would silently break
      // scoped stop/auto-end matching.
      const recordingSessionId = options.sessionId;
      meetingStartedAt = Date.now();
      // Stop captures and clears the segments, but a stop that fails partway
      // (the audio tap won't stop) never gets there.
      meetingDiarizationSegments = [];
      meetingConnectionOptions = options;
      const win = BrowserWindow.fromWebContents(event.sender);
      this.meetingDetectionEngine?.endRecordingSession();
      this.meetingDetectionEngine?.setUserRecording(true);

      const completeStart = async (result) => {
        await this.meetingDetectionEngine?.beginRecordingSession({
          sessionId: recordingSessionId,
          autoEndEligible: options.autoEndEligible === true,
          ownerWebContents: event.sender,
          noteId: options.noteId ?? null,
          // Renderer loopback may still fail after main chooses its strategy.
          // Auto-end stays fail-safe until the renderer confirms a real source.
          systemAudioAvailable: false,
        });
        // Arms on any active system-audio strategy — capture follows platform
        // capability, not call detection — so the warning copy also covers
        // in-person recordings where a silent system tap is expected.
        if (result.systemAudioStrategy && result.systemAudioStrategy !== "unsupported") {
          armMeetingSystemAudioSilenceTimer(win, result.systemAudioStrategy);
          startMeetingSystemAudioWatchdog(win, result.systemAudioStrategy);
        }
        return {
          ...result,
          sessionId: recordingSessionId,
          speakerIndexBase: meetingSpeakerIndexBase,
        };
      };

      try {
        const systemAudioPlan = await getMeetingSystemAudioPlan({ refreshWindowsCapability: true });
        let { mode: systemAudioMode, strategy: systemAudioStrategy } = systemAudioPlan;
        meetingEchoLeakDetector.reset();
        meetingOneOnOneAttendee = resolveOneOnOneAttendeeForNote(options.noteId);
        meetingOneOnOneProfileBound = false;
        meetingNoteId = options.noteId ?? null;
        meetingSpeakerIndexBase = this._resolveMeetingSpeakerIndexBase(
          meetingNoteId,
          options.speakerIndexBase
        );
        this._activeMeetingNoteId = meetingNoteId;

        // Seed the speaker cap from the note/calendar participants up front so live
        // identification isn't stuck at the default if the renderer never pushes a config.
        if (!this.activeMeetingSpeakerConfig) {
          this.activeMeetingSpeakerConfig = this._resolveInitialMeetingSpeakerConfig(meetingNoteId);
        }

        meetingRemoteTranscriber = null;
        meetingRemoteFailureReported = false;
        if (options.provider === "self-hosted") {
          const { resolveTranscriptionRoute } = await import("./transcriptionRoute.ts");
          const route = resolveTranscriptionRoute({
            settings: {
              transcriptionMode: "self-hosted",
              remoteTranscriptionUrl: options.remoteTranscriptionUrl,
              remoteTranscriptionModel: options.remoteTranscriptionModel,
            },
            request: { effectiveLanguage: options.language || undefined },
          });
          // A sentinel the renderer translates (MeetingRecordingMount).
          if (route.transport !== "http-batch") throw new Error("selfHostedNotConfigured");
          meetingRemoteTranscriber = createSelfHostedChunkTranscriber({
            endpoint: route.endpoint,
            model: route.model,
            language: route.language,
            getHeaders: selfHostedAuthHeaders,
            fetchImpl: proxyFetch,
          });
        }

        meetingLocalMode = true;
        meetingLocalProvider = options.localProvider || "whisper";
        meetingLocalModel = options.localModel || null;
        meetingLocalLanguage = options.language || null;
        meetingLocalWin = win;
        meetingLocalBuffers = { mic: [], system: [] };
        meetingLocalTranscript = "";

        await startLiveSpeakerIdentification(meetingLocalWin, systemAudioMode);
        await startMeetingAec(systemAudioMode);

        meetingLocalTimer = setInterval(() => {
          transcribeAllLocalBuffers();
        }, LOCAL_MEETING_CHUNK_INTERVAL_MS);

        ({ systemAudioMode, systemAudioStrategy } = await startMeetingSystemAudio(
          event,
          systemAudioMode,
          systemAudioStrategy,
          "in local meeting mode"
        ));

        debugLogger.debug("Meeting transcription started in local mode", {
          provider: meetingRemoteTranscriber ? "self-hosted" : meetingLocalProvider,
          systemAudioMode,
          systemAudioStrategy,
        });

        return await completeStart({
          success: true,
          systemAudioMode,
          systemAudioStrategy,
          oneOnOneAttendee: meetingOneOnOneAttendee,
        });
      } catch (error) {
        await rollbackMeetingTranscriptionStart();
        this.meetingDetectionEngine?.endRecordingSession(recordingSessionId);
        this.meetingDetectionEngine?.setUserRecording(false);
        debugLogger.error("Meeting transcription start error", { error: error.message });
        return { success: false, error: error.message, code: error.code };
      } finally {
        meetingTranscriptionStartInProgress = false;
      }
    };

    const sendMeetingAudio = (audioBuffer, source, synthetic = false) => {
      const outboundBuffer = Buffer.isBuffer(audioBuffer) ? audioBuffer : Buffer.from(audioBuffer);
      // Auto-end judges "is anyone audible" from the raw chunk of either
      // channel, before AEC/holdback/muting can swallow it.
      if (!synthetic) {
        this.meetingDetectionEngine?.recordMeetingAudioChunk(source, outboundBuffer);
      }

      if (source === "system") {
        const receivedAt = Date.now();
        // Recovery silence repairs sample clocks, but is not current capture
        // evidence or an AEC reference for the mic arriving now.
        if (!synthetic) {
          meetingEchoLeakDetector.recordSystemChunk(outboundBuffer, receivedAt);
          if (meetingAecEnabled && !this.meetingAecManager?.processSystemBuffer(outboundBuffer)) {
            meetingAecEnabled = false;
          }
          flushPendingMeetingMicChunks();
        }

        if (meetingLiveSpeakerActive) {
          // identification.startTime counts samples from the first chunk the
          // identifier sees, so the wall-clock anchor has to be the arrival of
          // that chunk. Stamping it when identification starts is only correct
          // when capture is already running (the macOS tap); the Windows
          // loopback helper can take seconds to hand over its first buffer, and
          // a stale anchor shifts every label earlier by that gap.
          meetingLiveSpeakerStartedAt ??= receivedAt;
          void liveSpeakerIdentifier.feedAudio(outboundBuffer);
        }

        if (!meetingDiarizationStream) {
          const os = require("os");
          meetingDiarizationPath = path.join(os.tmpdir(), `ow-diarize-raw-${Date.now()}.pcm`);
          meetingDiarizationStream = fs.createWriteStream(meetingDiarizationPath);
          meetingDiarizationStartedAt = receivedAt;
        }
        meetingDiarizationStream.write(outboundBuffer);

        if (!synthetic) {
          // Every real chunk feeds the watchdog, including actual silence.
          const { rms, peak } = computeChunkStats(outboundBuffer);
          const audible = rms >= MEETING_MIC_SILENCE_RMS || peak >= MEETING_MIC_SILENCE_PEAK;
          meetingSystemAudioWatchdog.recordChunk(audible);
          if (audible) meetingSystemAudioHeard = true;
        }

        dispatchMeetingAudioBuffer(outboundBuffer, "system", synthetic);
        return;
      }

      if (source === "mic") {
        // Keep a raw mic capture for the whole session beside the system one:
        // a speakerphone call puts both sides on the mic, and a chime on the
        // system channel must not cost it. Written pre-AEC/pre-gate so the
        // timeline stays continuous, like the system capture above.
        if (!meetingMicDiarizationStream) {
          const receivedAt = Date.now();
          meetingMicDiarizationPath = path.join(
            os.tmpdir(),
            `ow-diarize-raw-mic-${receivedAt}.pcm`
          );
          meetingMicDiarizationStream = fs.createWriteStream(meetingMicDiarizationPath);
          meetingMicDiarizationStartedAt = receivedAt;
        }
        meetingMicDiarizationStream.write(outboundBuffer);

        if (processMeetingMicWithAec(outboundBuffer)) {
          return;
        }

        if (!hasNativeMeetingSystemAudio()) {
          const analysis = meetingEchoLeakDetector.analyzeMicChunk(outboundBuffer);
          if (analysis?.shouldMute && !meetingAecEnabled) return;

          dispatchMeetingAudioBuffer(outboundBuffer, "mic");
          return;
        }

        meetingPendingMicChunks.push({
          buffer: outboundBuffer,
          queuedAt: Date.now(),
        });
        flushPendingMeetingMicChunks();
        return;
      }
    };

    // The Windows helper reports capture_silent when its own stream is silent
    // while a render endpoint is playing, which activation success cannot
    // detect. Start renderer loopback beside it; the handover decides whether
    // it takes the channel.
    const degradeMeetingSystemAudioToLoopback = (event) => {
      if (!meetingSystemAudioHandover.begin()) return;
      debugLogger.warn(
        "Windows system audio helper captured only silence, starting renderer loopback beside it",
        {},
        "meeting"
      );
      const win = BrowserWindow.fromWebContents(event.sender);
      if (win && !win.isDestroyed()) {
        win.webContents.send("meeting-system-audio-degraded");
      }
    };

    const completeMeetingSystemAudioHandover = () => {
      debugLogger.info("Renderer loopback took over system audio capture", {}, "meeting");
      meetingSystemAudioWatchdog.detachCapture();
      void this.windowsLoopbackAudioManager?.stop().catch(() => {});
    };

    const startManagedMeetingSystemAudio = (event, manager, warningLabel, onWarningCode) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      const timeline =
        manager === this.audioTapManager ? require("./meetingAudioTimeline")() : null;
      let captureStarted = false;
      const startCapture = () => {
        if (captureStarted) timeline?.markRestart();
        captureStarted = true;
        return manager.start({
          onChunk: (chunk) => {
            if (!meetingSystemAudioHandover.acceptNativeChunk(chunk)) return;
            if (timeline) {
              timeline.write(chunk, (buffer, synthetic) =>
                sendMeetingAudio(buffer, "system", synthetic)
              );
            } else {
              sendMeetingAudio(chunk, "system");
            }
          },
          onError: (error) => {
            if (win && !win.isDestroyed()) {
              win.webContents.send("meeting-transcription-error", error.message);
            }
          },
          onWarning: (warning) => {
            debugLogger.warn(
              warningLabel,
              { code: warning.code, message: warning.message },
              "meeting"
            );
            onWarningCode?.(warning.code);
          },
        });
      };

      // Keep the native sample timeline through recovery, including the stall
      // before detection and the helper restart. New sessions get a new timeline.
      meetingSystemAudioWatchdog.attachCapture({
        stop: () => manager.stop(),
        start: startCapture,
      });

      return startCapture();
    };

    const fallBackToMicOnly = async () => {
      // No system capture left to recover, so drop the restart hook with it.
      stopMeetingSystemAudioWatchdog();
      await stopLiveSpeakerIdentification().catch(() => {});
    };

    const startMeetingSystemAudio = async (
      event,
      systemAudioMode,
      systemAudioStrategy,
      context
    ) => {
      if (systemAudioMode === "native") {
        try {
          await startManagedMeetingSystemAudio(
            event,
            this.audioTapManager,
            "macOS system audio tap warning",
            (code) => {
              // The tap is pinned to the devices it saw at creation, so a route
              // change can strand it. Restart before the stall window elapses.
              if (code === "device_invalidated") {
                meetingSystemAudioWatchdog.reportDeviceInvalidated();
              }
            }
          );
          return { systemAudioMode, systemAudioStrategy };
        } catch (error) {
          debugLogger.warn(
            `Native system audio tap failed ${context}, falling back to mic-only`,
            { error: error.message },
            "meeting"
          );
          await fallBackToMicOnly();
          return { systemAudioMode: "unsupported", systemAudioStrategy: "unsupported" };
        }
      }

      if (systemAudioStrategy === "wasapi-loopback") {
        try {
          await startManagedMeetingSystemAudio(
            event,
            this.windowsLoopbackAudioManager,
            "Windows system audio warning",
            (code) => {
              if (code === "capture_silent") {
                degradeMeetingSystemAudioToLoopback(event);
              }
            }
          );
          return { systemAudioMode, systemAudioStrategy };
        } catch (error) {
          debugLogger.warn(
            `Windows system audio helper failed ${context}, falling back to renderer loopback`,
            { error: error.message },
            "meeting"
          );
          // The renderer captures via Chromium's display-media loopback when
          // it sees the downgraded strategy in the start result.
          return { systemAudioMode, systemAudioStrategy: "loopback" };
        }
      }

      if (systemAudioStrategy !== "pipewire-loopback") {
        return { systemAudioMode, systemAudioStrategy };
      }

      try {
        await startManagedMeetingSystemAudio(
          event,
          this.linuxPortalAudioManager,
          "Linux PipeWire system audio warning"
        );
        return { systemAudioMode, systemAudioStrategy };
      } catch (error) {
        debugLogger.warn(
          `Linux PipeWire helper failed ${context}, falling back to mic-only`,
          { error: error.message },
          "meeting"
        );
        await fallBackToMicOnly();
        return { systemAudioMode: "unsupported", systemAudioStrategy: "unsupported" };
      }
    };

    ipcMain.on("meeting-transcription-send", (_event, audioBuffer, source) => {
      const buffer = Buffer.isBuffer(audioBuffer) ? audioBuffer : Buffer.from(audioBuffer);
      if (source === "system") {
        const route = meetingSystemAudioHandover.acceptRendererChunk(buffer);
        if (route === "drop") return;
        if (route === "takeover") completeMeetingSystemAudioHandover();
      }
      sendMeetingAudio(buffer, source);
    });

    const stopMeetingTranscription = async (expectedSessionId) => {
      // Only a *different* live session blocks teardown — it owns the shared
      // capture now. With no engine session (e.g. after quit-path engine stop)
      // the capture below must still be torn down.
      if (this.meetingDetectionEngine?.endRecordingSession(expectedSessionId) === false) {
        return { success: false, reason: "stale-session" };
      }
      this.meetingDetectionEngine?.setUserRecording(false);
      clearMeetingSystemAudioSilenceTimer();
      stopMeetingSystemAudioWatchdog();
      try {
        if (this.audioTapManager) {
          await this.audioTapManager.stop();
        }
        if (this.linuxPortalAudioManager) {
          await this.linuxPortalAudioManager.stop().catch(() => {});
        }
        if (this.windowsLoopbackAudioManager) {
          await this.windowsLoopbackAudioManager.stop().catch(() => {});
        }

        flushPendingMeetingMicChunks(true);
        await stopMeetingAec();

        const liveSpeakerState = await stopLiveSpeakerIdentification().catch(() => null);

        const diarizationSessionId = `diar-${Date.now()}`;
        const diarizationWin = meetingLocalWin || this.windowManager.controlPanelWindow;

        try {
          await settleLocalMeetingTranscription();
          await transcribeAllLocalBuffers();
        } catch (err) {
          debugLogger.error("Local meeting final transcription failed", { error: err.message });
        }
        flushPendingMicFinals(true);
        const {
          diarizationPcmPath,
          diarizationSegments,
          retractedSegments,
          diarizationStartedAt,
          diarizedSource,
          alternateCapture,
        } = await captureMeetingDiarizationState();
        const transcript =
          buildOrderedTranscriptText(diarizationSegments) || meetingLocalTranscript;
        const sessionSpeakerConfigSnapshot = this.activeMeetingSpeakerConfig;
        const noteIdSnapshot = meetingNoteId;
        const speakerIndexBaseSnapshot = meetingSpeakerIndexBase;
        this.activeMeetingSpeakerConfig = null;
        resetMeetingLocalState();

        // Fire-and-forget background diarization (or notify skip)
        this._startOrSkipDiarization(
          diarizationSessionId,
          diarizationPcmPath,
          diarizationStartedAt,
          diarizationSegments,
          diarizationWin,
          liveSpeakerState,
          sessionSpeakerConfigSnapshot,
          noteIdSnapshot,
          diarizedSource,
          speakerIndexBaseSnapshot,
          retractedSegments,
          alternateCapture
        );

        return { success: true, transcript, diarizationSessionId };
      } catch (error) {
        debugLogger.error("Meeting transcription stop error", { error: error.message });
        return { success: false, error: error.message };
      }
    };

    const meetingTranscriptionLifecycle = createMeetingTranscriptionLifecycle({
      start: ({ sessionId, ownerWebContents, options }) =>
        startMeetingTranscription({ sender: ownerWebContents }, { ...options, sessionId }),
      stop: (sessionId) => stopMeetingTranscription(sessionId),
      onError: (error, sessionId) => {
        debugLogger.error(
          "Meeting transcription owner-loss teardown failed",
          { error: error?.message, sessionId },
          "meeting"
        );
      },
    });

    ipcMain.handle("meeting-transcription-start", (event, options = {}) => {
      const sessionId =
        typeof options.sessionId === "string" && options.sessionId.length > 0
          ? options.sessionId
          : crypto.randomUUID();
      return meetingTranscriptionLifecycle.startSession({
        sessionId,
        ownerWebContents: event.sender,
        options,
      });
    });

    ipcMain.handle("meeting-transcription-stop", (_event, expectedSessionId) =>
      meetingTranscriptionLifecycle.stopSession(expectedSessionId)
    );

    ipcMain.handle(
      "meeting-transcription-set-system-audio-available",
      async (event, sessionId, available) => {
        const updated = await this.meetingDetectionEngine?.setRecordingSystemAudioAvailable(
          sessionId,
          available === true,
          event.sender
        );
        return updated === true ? { success: true } : { success: false, reason: "stale-session" };
      }
    );

    ipcMain.handle(
      "start-dictation-preview",
      async (_event, { provider, model, language, display = true }) => {
        resetDictationPreviewState();
        const gen = dictationPreviewGen;
        dictationPreviewMode = true;
        dictationPreviewSessionActive = true;
        dictationPreviewProvider = provider;
        dictationPreviewModel = model;
        dictationPreviewLanguage = language || null;
        dictationPreviewDisplay = display;
        dictationPreviewChunkCount = 0;
        if (display) this.windowManager.showTranscriptionPreview("");

        if (provider === "nvidia" && this.parakeetManager.supportsOnlineStreaming(model)) {
          try {
            const stream = await this.parakeetManager.createOnlineStream(model, {
              onUpdate: (text) => {
                if (gen === dictationPreviewGen && text && dictationPreviewDisplay) {
                  this.windowManager.showTranscriptionPreview(text);
                }
              },
              onError: (error) => {
                if (gen !== dictationPreviewGen || dictationPreviewStream !== stream) return;
                // Keep the preview alive on the chunked path; the final
                // transcript falls back to decoding the full recording.
                debugLogger.warn("Online preview stream failed mid-session, falling back", {
                  model,
                  error: error.message,
                });
                dictationPreviewStream = null;
                if (dictationPreviewDisplay) startDictationPreviewTimer();
              },
            });
            if (gen !== dictationPreviewGen) {
              stream.abort();
              return { success: true };
            }
            dictationPreviewStream = stream;
            for (const chunk of dictationPreviewBuffer) {
              stream.sendPcm16(chunk);
            }
            dictationPreviewBuffer = [];
            return { success: true };
          } catch (error) {
            debugLogger.warn("Online preview stream unavailable, falling back to chunked preview", {
              model,
              error: error.message,
            });
          }
        }

        if (gen !== dictationPreviewGen) return { success: true };
        if (!display) {
          // A headless session exists only to feed the online stream; without
          // one, buffered PCM would just accumulate with no consumer.
          resetDictationPreviewState();
          return { success: true };
        }
        startDictationPreviewTimer();
        return { success: true };
      }
    );

    ipcMain.on("dictation-preview-audio", (_event, audioBuffer) => {
      if (!dictationPreviewMode) return;
      dictationPreviewChunkCount++;
      if (dictationPreviewChunkCount <= 3 || dictationPreviewChunkCount % 50 === 0) {
        debugLogger.debug("Dictation preview audio received", {
          bytes: audioBuffer?.byteLength || audioBuffer?.length,
          count: dictationPreviewChunkCount,
          bufferSize: dictationPreviewBuffer.length,
        });
      }
      const pcm = Buffer.isBuffer(audioBuffer) ? audioBuffer : Buffer.from(audioBuffer);
      if (dictationPreviewStream) {
        dictationPreviewStream.sendPcm16(pcm);
        return;
      }
      dictationPreviewBuffer.push(pcm);
    });

    ipcMain.handle("dismiss-dictation-preview", () =>
      queueDictationPreviewOperation(async () => {
        resetDictationPreviewState();
        this.windowManager.hideTranscriptionPreview();
        return { success: true };
      })
    );

    ipcMain.handle("complete-dictation-preview", (_event, { text } = {}) =>
      queueDictationPreviewOperation(async () => {
        if (!dictationPreviewSessionActive) {
          return { success: true };
        }
        if (typeof text === "string" && text.trim()) {
          this.windowManager.completeTranscriptionPreview(text);
        } else {
          resetDictationPreviewState();
          this.windowManager.hideTranscriptionPreview();
        }
        return { success: true };
      })
    );

    ipcMain.handle("hide-dictation-preview", () =>
      queueDictationPreviewOperation(async () => {
        resetDictationPreviewState();
        this.windowManager.hideTranscriptionPreview();
        return { success: true };
      })
    );

    ipcMain.handle("stop-dictation-preview", async (_event, options = {}) => {
      if (!dictationPreviewMode && !dictationPreviewSessionActive) {
        return { success: true, streamed: false, text: "" };
      }
      clearInterval(dictationPreviewTimer);
      dictationPreviewTimer = null;
      const display = dictationPreviewDisplay;
      // Missing flag defaults to trusted so non-streaming callers never regress.
      const rendererFlushOk = options.flushed !== false;
      let streamed = false;
      let streamedText = "";
      if (dictationPreviewStream) {
        const stream = dictationPreviewStream;
        dictationPreviewStream = null;
        const gen = dictationPreviewGen;
        const result = await stream.finish().catch(() => null);
        if (gen !== dictationPreviewGen) {
          return { success: true, streamed: false, text: "" };
        }
        if (result) {
          streamedText = result.text || "";
          // Trust the streamed transcript only on a clean server flush and a clean renderer flush.
          streamed = !result.truncated && rendererFlushOk;
        }
        if (streamedText && display && dictationPreviewSessionActive) {
          this.windowManager.showTranscriptionPreview(streamedText);
        }
      }
      // Offline chunks only draw previews. The renderer decodes the full
      // recording separately, so another preview decode here competes with
      // final transcription without contributing to its result.
      resetDictationPreviewState({ preserveSession: display });
      if (!display || !dictationPreviewSessionActive) {
        return { success: true, streamed, text: streamedText };
      }
      this.windowManager.holdTranscriptionPreview(options);
      return { success: true, streamed, text: streamedText };
    });

    ipcMain.handle("update-transcription-text", async (_event, id, text, rawText) => {
      try {
        this.databaseManager.updateTranscriptionText(id, text, rawText);
        const updated = this.databaseManager.getTranscriptionById(id);
        return { success: true, transcription: updated };
      } catch (error) {
        debugLogger.error(
          "Failed to update transcription text",
          { id, error: error.message },
          "audio-storage"
        );
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("agent-open-note", async (_event, noteId) => {
      try {
        const note = this.databaseManager.getNote(noteId);
        await this.windowManager.queueNoteNavigation({
          noteId,
          folderId: note?.folder_id ?? null,
        });
        return { success: true };
      } catch (error) {
        debugLogger.error("Failed to open note from agent:", error);
        return { success: false, error: error.message };
      }
    });

    // The renderer passes its saved SearXNG URL; only the query and the model's
    // search options go to that server. Result bodies are never logged.
    ipcMain.handle("agent-web-search", async (_event, query, numResults, options = {}) => {
      const result = await searxngSearch(
        {
          baseUrl: options?.baseUrl,
          query,
          numResults,
          timeRange: options?.timeRange,
        },
        { fetchImpl: (url, init) => net.fetch(url, { ...init, useSessionCookies: false }) }
      );
      if (result.success) {
        debugLogger.debug(
          "Agent web search completed",
          { resultCount: result.results.length, hasAnswers: !!result.answers },
          "web-search"
        );
      } else {
        debugLogger.warn(
          "Agent web search failed",
          { errorCode: result.errorCode, error: result.error },
          "web-search"
        );
      }
      return result;
    });

    // Unknown ids are a no-op; the renderer fires this for every cancel.
    ipcMain.handle("cancel-upload-transcription", async (_event, requestId) => {
      return { success: this._uploadCancelRegistry.cancel(requestId) > 0 };
    });

    ipcMain.handle(
      "transcribe-audio-file-self-hosted",
      async (
        _event,
        {
          filePath,
          language,
          transcriptionMode,
          remoteTranscriptionUrl,
          remoteTranscriptionModel,
          requestId,
        }
      ) => {
        const { signal, release } = this._uploadCancelRegistry.register(requestId);
        let cleanupUpload = null;
        let providerErrorContext = null;
        try {
          if (typeof filePath !== "string") {
            return { success: false, error: "Invalid file path" };
          }
          const sourcePath = resolveAllowedAudioPath(filePath);
          if (!sourcePath) return { success: false, error: "File path not allowed" };

          const { resolveTranscriptionRoute } = await import("./transcriptionRoute.ts");
          const route = resolveTranscriptionRoute({
            settings: { transcriptionMode, remoteTranscriptionUrl, remoteTranscriptionModel },
            request: { effectiveLanguage: language || undefined },
          });

          // Fail closed: a misconfigured route must never fall through to a default.
          if (route.transport !== "http-batch") {
            return {
              success: false,
              error:
                route.transport === "error"
                  ? route.message
                  : "Self-hosted transcription is not configured",
              code: route.code,
              messageKey: route.messageKey,
            };
          }

          providerErrorContext = {
            provider: "self-hosted",
            selfHosted: true,
            model: route.model,
            surface: "transcription",
          };
          const upload = await prepareProviderUpload(sourcePath, { signal });
          cleanupUpload = upload.cleanup;

          // Over the server's upload cap: split into fixed-length MP3 chunks and
          // stitch their segments back on one timeline.
          let parts = [{ path: upload.path, offsetSeconds: 0 }];
          if (fs.statSync(upload.path).size > SELF_HOSTED_UPLOAD_LIMIT_BYTES) {
            const { splitAudioFile } = require("./ffmpegUtils");
            const { getSafeTempDir } = require("./safeTempDir");
            const chunkDir = fs.mkdtempSync(path.join(getSafeTempDir(), "ow-selfhosted-"));
            const previousCleanup = cleanupUpload;
            cleanupUpload = () => {
              previousCleanup?.();
              fs.rmSync(chunkDir, { recursive: true, force: true });
            };
            const { chunkPaths } = await splitAudioFile(upload.path, chunkDir, {
              segmentDuration: SELF_HOSTED_CHUNK_SECONDS,
              audioBitrate: "64k",
              signal,
            });
            parts = chunkPaths.map((chunkPath, index) => ({
              path: chunkPath,
              offsetSeconds: index * SELF_HOSTED_CHUNK_SECONDS,
            }));
          }

          const results = [];
          for (const part of parts) {
            const fileBuffer = fs.readFileSync(part.path);
            // No language field: an uploaded file is often not in the dictation
            // language, and a wrong hint silently mistranscribes it.
            const post = (fields) => {
              const { body, boundary } = buildMultipartBody(
                fileBuffer,
                path.basename(part.path),
                providerContentType(part.path),
                fields
              );
              return postMultipart(
                new URL(route.endpoint),
                body,
                boundary,
                selfHostedAuthHeaders(),
                { signal }
              );
            };
            const data = await requestTranscription({
              post,
              endpoint: route.endpoint,
              model: route.model,
              offsetSeconds: part.offsetSeconds,
            });
            if (data.statusCode !== 200) {
              debugLogger.warn("Self-hosted file transcription failed", {
                status: data.statusCode,
                body: redactProviderBody(data.data),
              });
              throw providerHttpError({
                ...providerErrorContext,
                status: data.statusCode,
                body: data.data,
              });
            }
            results.push(data);
          }

          const { text, segments } = stitchTranscriptionChunks(results);
          return { success: true, text, ...(segments ? { segments } : {}) };
        } catch (rawError) {
          if (signal?.aborted) {
            debugLogger.debug("Self-hosted audio file transcription cancelled", { requestId });
            return { success: false, error: "Cancelled", code: "UPLOAD_CANCELLED" };
          }
          const error = providerErrorContext
            ? asProviderError(rawError, providerErrorContext)
            : rawError;
          debugLogger.error("Self-hosted audio file transcription error", { error: error.message });
          return { success: false, ...ipcErrorFields(error) };
        } finally {
          cleanupUpload?.();
          release();
        }
      }
    );

    ipcMain.handle("get-model-cache-root", () => {
      const { getCacheRoot } = require("./modelDirUtils");
      return getCacheRoot();
    });

    ipcMain.handle("open-whisper-models-folder", async () => {
      try {
        const { getCacheRoot } = require("./modelDirUtils");
        const cacheRoot = getCacheRoot();
        await fs.promises.mkdir(cacheRoot, { recursive: true });
        const errMsg = await shell.openPath(cacheRoot);
        if (errMsg) return { success: false, error: errMsg };
        return { success: true };
      } catch (error) {
        debugLogger.error("Failed to open model cache folder:", error);
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("get-ydotool-status", () => {
      const { getYdotoolStatus } = require("./ensureYdotool");
      return getYdotoolStatus();
    });

    ipcMain.handle("get-debug-state", async () => {
      try {
        return {
          enabled: debugLogger.isEnabled(),
          logPath: debugLogger.getLogPath(),
          logLevel: debugLogger.getLevel(),
        };
      } catch (error) {
        debugLogger.error("Failed to get debug state:", error);
        return { enabled: false, logPath: null, logLevel: "info" };
      }
    });

    ipcMain.handle("set-debug-logging", async (event, enabled) => {
      try {
        const path = require("path");
        const fs = require("fs");
        const envPath = path.join(app.getPath("userData"), ".env");

        // Read current .env content
        let envContent = "";
        if (fs.existsSync(envPath)) {
          envContent = fs.readFileSync(envPath, "utf8");
        }

        // Parse lines
        const lines = envContent.split("\n");
        const logLevelIndex = lines.findIndex((line) =>
          line.trim().startsWith("OPENWHISPR_LOG_LEVEL=")
        );

        if (enabled) {
          // Set to debug
          if (logLevelIndex !== -1) {
            lines[logLevelIndex] = "OPENWHISPR_LOG_LEVEL=debug";
          } else {
            // Add new line
            if (lines.length > 0 && lines[lines.length - 1] !== "") {
              lines.push("");
            }
            lines.push("# Debug logging setting");
            lines.push("OPENWHISPR_LOG_LEVEL=debug");
          }
        } else {
          // Remove or set to info
          if (logLevelIndex !== -1) {
            lines[logLevelIndex] = "OPENWHISPR_LOG_LEVEL=info";
          }
        }

        // Write back
        fs.writeFileSync(envPath, lines.join("\n"), "utf8");

        // Update environment variable
        process.env.OPENWHISPR_LOG_LEVEL = enabled ? "debug" : "info";

        // Refresh logger state
        debugLogger.refreshLogLevel();

        return {
          success: true,
          enabled: debugLogger.isEnabled(),
          logPath: debugLogger.getLogPath(),
        };
      } catch (error) {
        debugLogger.error("Failed to set debug logging:", error);
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("open-logs-folder", async () => {
      try {
        const logsDir = path.join(app.getPath("userData"), "logs");
        await shell.openPath(logsDir);
        return { success: true };
      } catch (error) {
        debugLogger.error("Failed to open logs folder:", error);
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("get-app-version", async () => ({ version: app.getVersion() }));

    ipcMain.handle("get-post-migration-state", () => ({
      justMigrated: postMigrationDetector.isReturningFromOldBundle(),
    }));

    ipcMain.handle("mark-bundle-migrated", () => {
      postMigrationDetector.markBundleMigrated();
    });

    ipcMain.handle("mark-bundle-migration-dismissed", () => {
      postMigrationDetector.markBundleMigrationDismissed();
    });

    // Agent mode handlers
    ipcMain.handle("update-voice-agent-hotkey", async (_event, hotkey) => {
      const hotkeyManager = this.windowManager.hotkeyManager;
      const voiceAgentCallback = this.windowManager._voiceAgentHotkeyCallback;
      if (!voiceAgentCallback) {
        return { success: false };
      }

      if (!hotkey) {
        const removed = await hotkeyManager.unregisterSlot("voiceAgent");
        if (removed === false) return { success: false };
        this.environmentManager.saveVoiceAgentKey?.("");
        this.windowManager.reconcileNativeKeyListeners();
        this._notifyHotkeyChanged("");
        return { success: true, message: "Voice agent hotkey cleared" };
      }

      const result = await hotkeyManager.registerSlot("voiceAgent", hotkey, voiceAgentCallback, {
        atomic: true,
      });
      this.windowManager.reconcileNativeKeyListeners();
      if (result.success) {
        this.environmentManager.saveVoiceAgentKey?.(hotkey);
        this._notifyHotkeyChanged(hotkey);
        return { success: true, message: `Voice agent hotkey updated to: ${hotkey}` };
      }

      return { success: false, message: result.error };
    });

    ipcMain.handle("get-voice-agent-key", async () => {
      return this.environmentManager.getVoiceAgentKey?.() || "";
    });

    ipcMain.handle("update-translation-hotkey", async (_event, hotkey) => {
      const hotkeyManager = this.windowManager.hotkeyManager;
      const translationCallback = this.windowManager._translationHotkeyCallback;
      if (!translationCallback) {
        return { success: false };
      }

      if (!hotkey) {
        const removed = await hotkeyManager.unregisterSlot("translation");
        if (removed === false) return { success: false };
        this.environmentManager.saveTranslationKey?.("");
        this.windowManager.reconcileNativeKeyListeners();
        this._notifyHotkeyChanged("");
        return { success: true, message: "Translation hotkey cleared" };
      }

      const result = await hotkeyManager.registerSlot("translation", hotkey, translationCallback, {
        atomic: true,
      });
      this.windowManager.reconcileNativeKeyListeners();
      if (result.success) {
        this.environmentManager.saveTranslationKey?.(hotkey);
        this._notifyHotkeyChanged(hotkey);
        return { success: true, message: `Translation hotkey updated to: ${hotkey}` };
      }

      return { success: false, message: result.error };
    });

    ipcMain.handle("get-translation-key", async () => {
      return this.environmentManager.getTranslationKey?.() || "";
    });

    ipcMain.handle("acquire-recording-lock", async (_event, pipeline) => {
      if (this._activeRecordingPipeline && this._activeRecordingPipeline !== pipeline) {
        return { success: false, holder: this._activeRecordingPipeline };
      }
      this._activeRecordingPipeline = pipeline;
      return { success: true };
    });

    ipcMain.handle("release-recording-lock", async (_event, pipeline) => {
      if (this._activeRecordingPipeline === pipeline) {
        this._activeRecordingPipeline = null;
      }
      return { success: true };
    });

    // Provider-neutral availability over the shared calendar cache.
    ipcMain.handle("calendar-get-availability", async (_event, request) => {
      try {
        return {
          success: true,
          availability: getCalendarAvailability({
            request,
            databaseManager: this.databaseManager,
            calendarProviders: [{ provider: "apple", manager: this.appleCalendarManager }],
          }),
        };
      } catch (error) {
        debugLogger.warn(
          "Calendar availability request failed",
          { error: error instanceof Error ? error.message : String(error) },
          "calendar"
        );
        return {
          success: false,
          error: error instanceof Error ? error.message : "Failed to check calendar availability",
        };
      }
    });

    // Provider-neutral reads over the shared calendar_events cache.
    ipcMain.handle("calendar-get-upcoming-events", async (_event, windowMinutes) => {
      try {
        return {
          success: true,
          events: this.databaseManager.getUpcomingEvents(windowMinutes),
        };
      } catch (error) {
        return { success: false, events: [] };
      }
    });

    ipcMain.handle("calendar-get-event", async (_event, eventId) => {
      try {
        const event = this.databaseManager.getCalendarEventById(eventId);
        return { success: true, event };
      } catch (error) {
        return { success: false, event: null };
      }
    });

    // Apple Calendar (macOS EventKit)
    ipcMain.handle("acal-connect", async () => {
      try {
        return await this.appleCalendarManager.connect();
      } catch (error) {
        debugLogger.error("Apple Calendar connect failed", { error: error.message }, "acal");
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("acal-disconnect", async () => {
      try {
        return this.appleCalendarManager.disconnect();
      } catch (error) {
        debugLogger.error("Apple Calendar disconnect failed", { error: error.message }, "acal");
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("acal-get-connection-status", async () => {
      try {
        return this.appleCalendarManager.getConnectionStatus();
      } catch (error) {
        debugLogger.error(
          "Apple Calendar connection status failed",
          { error: error.message },
          "acal"
        );
        return { connected: false, sourceNames: [] };
      }
    });

    ipcMain.handle("search-contacts", async (_event, query) => {
      try {
        const contacts = this.databaseManager.searchContacts(query);
        return { success: true, contacts };
      } catch (error) {
        return { success: false, contacts: [] };
      }
    });

    ipcMain.handle("upsert-contact", async (_event, contact) => {
      try {
        this.databaseManager.addManualContact(contact);
        return { success: true };
      } catch (error) {
        return { success: false };
      }
    });

    ipcMain.handle("get-md5-hash", (_event, text) => {
      return crypto.createHash("md5").update(text.toLowerCase().trim()).digest("hex");
    });

    const NOTIFICATION_PREF_KEYS = new Set([
      "notificationsEnabled",
      "notifyMeetingDetection",
      "notifyCalendarReminders",
    ]);

    ipcMain.handle("sync-notification-preferences", async (_event, prefs) => {
      try {
        if (!prefs || typeof prefs !== "object") {
          return { success: false, error: "Invalid preferences" };
        }
        for (const [key, value] of Object.entries(prefs)) {
          if (NOTIFICATION_PREF_KEYS.has(key)) {
            this.windowManager.notificationPrefs[key] = !!value;
          }
        }
        if (typeof prefs.meetingProcessDetection === "boolean") {
          this.meetingProcessDetection = prefs.meetingProcessDetection;
        }
        const { notificationsEnabled, notifyMeetingDetection } =
          this.windowManager.notificationPrefs;
        this.meetingDetectionEngine?.setPreferences(
          deriveDetectorPreferences({
            notificationsEnabled,
            notifyMeetingDetection,
            meetingProcessDetection: this.meetingProcessDetection,
          })
        );
        return { success: true };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("meeting-set-speaker-diarization-enabled", async (_event, payload) => {
      try {
        this.speakerDiarizationEnabled = payload?.enabled !== false;
        return { success: true };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("set-diarization-endpoint", async (_event, payload) => {
      try {
        const { resolveDiarizationRoute } = await import("./diarizationRoute.ts");
        this.diarizationRoute = resolveDiarizationRoute({
          mode: payload?.mode,
          url: typeof payload?.url === "string" ? payload.url : "",
        });
        return { success: true, transport: this.diarizationRoute.transport };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("whisper-vad-get-config", async () => {
      try {
        return { success: true, config: this._getWhisperVadSettings() };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("whisper-vad-set-config", async (_event, payload) => {
      try {
        const config = this._setWhisperVadSettings(payload || {});
        return { success: true, config };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("meeting-set-session-speaker-config", async (_event, payload) => {
      try {
        const enabled = payload?.enabled !== false;
        // A stepper count has no upper bound; the live identifier clamps its own labels.
        const expectedCount = Math.max(
          1,
          Math.trunc(Number(payload?.expectedCount)) || DEFAULT_EXPECTED_SPEAKER_COUNT
        );
        // Only a stepper-set count is explicit; the diarization toggle reuses this
        // channel and must not freeze the count against roster-driven refreshes.
        this.activeMeetingSpeakerConfig = {
          enabled,
          expectedCount,
          explicit: payload?.countIsExplicit === true,
        };
        liveSpeakerIdentifier.setEnabled(enabled);
        // Live identification only labels other speakers (the mic track is "you"),
        // so cap at expectedCount - 1 to match resolveSessionMaxSpeakers().
        liveSpeakerIdentifier.setMaxSpeakers(Math.max(1, expectedCount - 1));
        return { success: true };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("get-meeting-notification-destination", (event) =>
      this.getMeetingNotificationDestination(
        this.windowManager.captureMeetingNotificationOwner(event.sender)
      )
    );
    ipcMain.handle("select-meeting-notification-folder", (event, ref) =>
      this.selectMeetingNotificationFolder(
        this.windowManager.captureMeetingNotificationOwner(event.sender),
        ref
      )
    );
    ipcMain.handle("create-meeting-notification-folder", (event, request) =>
      this.createMeetingNotificationFolder(
        this.windowManager.captureMeetingNotificationOwner(event.sender),
        request
      )
    );

    ipcMain.handle("set-meeting-notification-surface", (event, state) => {
      const owner = this.windowManager.captureMeetingNotificationOwner(event.sender);
      return this.windowManager.setMeetingNotificationSurface(owner, state);
    });

    ipcMain.handle("meeting-notification-respond", (event, detectionId, action, options) => {
      const owner = this.windowManager.captureMeetingNotificationOwner(event.sender);
      if (!owner || owner.prompt.detectionId !== detectionId)
        return { success: false, code: "STALE_NOTIFICATION" };
      return this.meetingDetectionEngine.handleNotificationResponse(
        detectionId,
        action,
        options,
        owner
      );
    });
    ipcMain.handle("confirm-meeting-note-navigation", (event, navigationId, status) =>
      this.windowManager.confirmMeetingNoteNavigation(event.sender, navigationId, status)
    );

    ipcMain.handle("join-calendar-meeting", async (_event, eventId) => {
      try {
        // Sent from the open panel, which may have just opened the meeting
        // link: leave the meeting in front rather than pulling the panel back.
        await this.meetingDetectionEngine.joinCalendarMeeting(eventId, "calendar-join", {
          activate: false,
        });
        return { success: true };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("start-manual-meeting", () => this.windowManager.startManualMeeting());

    ipcMain.handle("get-meeting-notification-data", async (event) => {
      if (this.windowManager?.notificationWindow?.webContents !== event.sender) return null;
      return this.windowManager?._pendingNotificationData ?? null;
    });

    ipcMain.handle("get-pending-meeting-note-navigation", async (event) => {
      return this.windowManager?.consumePendingMeetingNoteNavigation(event.sender) ?? null;
    });

    ipcMain.handle("get-pending-note-navigation", async () => {
      return this.windowManager?.consumePendingNoteNavigation() ?? null;
    });

    ipcMain.handle("get-pending-settings-section", async () => {
      return this.windowManager?.consumePendingSettingsSection() ?? null;
    });

    ipcMain.handle("meeting-notification-ready", async (event) => {
      this.windowManager?.showNotificationWindow(event.sender);
    });

    // Note files (markdown mirror) handlers
    ipcMain.handle("note-files-set-enabled", async (_event, enabled, customPath, options) => {
      try {
        if (!enabled) {
          this.noteFilesSync.disable();
          return { success: true };
        }
        const basePath = customPath || path.join(app.getPath("userData"), "notes");
        this.noteFilesSync.enable(basePath, {
          skipRebuild: !!options?.skipRebuild,
          baseTag: options?.baseTag,
          exportDictations: options?.exportDictations,
        });
        return { success: true };
      } catch (error) {
        debugLogger.error(
          "Failed to set note-files enabled",
          { error: error.message },
          "note-files"
        );
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("note-files-set-options", async (_event, options) => {
      try {
        this.noteFilesSync.setOptions({
          baseTag: typeof options?.baseTag === "string" ? options.baseTag : undefined,
          exportDictations:
            typeof options?.exportDictations === "boolean" ? options.exportDictations : undefined,
        });
        return { success: true };
      } catch (error) {
        debugLogger.error(
          "Failed to set note-files options",
          { error: error.message },
          "note-files"
        );
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("note-files-set-path", async (_event, newPath) => {
      try {
        if (!this.noteFilesSync.enabled) {
          return { success: false, error: "Note files not enabled" };
        }
        this.noteFilesSync.rebuild(newPath);
        return { success: true };
      } catch (error) {
        debugLogger.error("Failed to set note-files path", { error: error.message }, "note-files");
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("note-files-rebuild", async () => {
      try {
        if (!this.noteFilesSync.enabled) {
          return { success: false, error: "Note files not enabled" };
        }
        this.noteFilesSync.rebuild();
        return { success: true };
      } catch (error) {
        debugLogger.error("Failed to rebuild note files", { error: error.message }, "note-files");
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("note-files-get-default-path", async () => {
      return path.join(app.getPath("userData"), "notes");
    });

    ipcMain.handle("note-files-get-resolved-paths", async () => {
      if (!this.noteFilesSync.enabled) return null;
      const mirror = this.noteFilesSync.mirror;
      const basePath = mirror.getBasePath();
      if (!basePath) return null;
      return {
        basePath,
        meetingsPath: mirror.getFolderDisplayPath("Meetings"),
        dictationsPath: mirror.getFolderDisplayPath(mirror.DICTATIONS_FOLDER),
      };
    });

    ipcMain.handle("note-files-has-note-file", async (_event, noteId) => {
      try {
        return !!this.noteFilesSync.getNotePath(noteId);
      } catch {
        return false;
      }
    });

    ipcMain.handle("show-note-file", async (_event, noteId) => {
      try {
        const filePath = this.noteFilesSync.getNotePath(noteId);
        if (!filePath) return { success: false };
        shell.showItemInFolder(filePath);
        return { success: true };
      } catch (error) {
        debugLogger.error(
          "Failed to show note file",
          { noteId, error: error.message },
          "note-files"
        );
        return { success: false };
      }
    });

    // The URL is built here from a path the mirror owns, so the renderer can
    // never hand an arbitrary obsidian:// URL to the OS.
    ipcMain.handle("note-files-open-in-obsidian", async (_event, noteId) => {
      try {
        const filePath = this.noteFilesSync.getNotePath(noteId);
        if (!filePath) return { success: false };
        await openExternalUrl(`obsidian://open?path=${encodeURIComponent(filePath)}`);
        return { success: true };
      } catch (error) {
        debugLogger.error(
          "Failed to open note in Obsidian",
          { noteId, error: error.message },
          "note-files"
        );
        return { success: false };
      }
    });

    ipcMain.handle("show-folder-in-explorer", async (_event, folderName) => {
      try {
        const dirPath = this.noteFilesSync.enabled
          ? this.noteFilesSync.mirror.getFolderPath(folderName)
          : null;
        if (!dirPath) return { success: false };
        await shell.openPath(dirPath);
        return { success: true };
      } catch (error) {
        debugLogger.error(
          "Failed to show folder",
          { folderName, error: error.message },
          "note-files"
        );
        return { success: false };
      }
    });

    ipcMain.handle("note-files-pick-folder", async () => {
      try {
        const { dialog } = require("electron");
        const result = await dialog.showOpenDialog({ properties: ["openDirectory"] });
        if (result.canceled || !result.filePaths.length) {
          return { canceled: true };
        }
        return { canceled: false, path: result.filePaths[0] };
      } catch (error) {
        debugLogger.error("Failed to pick folder", { error: error.message }, "note-files");
        return { canceled: true };
      }
    });

    ipcMain.handle("granola-import-pick-and-preview", async (event) => {
      try {
        const { dialog } = require("electron");
        // Parent the dialog so it opens as a sheet on the settings window —
        // a parentless panel can land invisible on another display/Space.
        const parentWindow = BrowserWindow.fromWebContents(event.sender);
        // Granola chunks large exports into numbered files (…-000.csv, -001, …),
        // so let the user grab the whole set in one pick.
        const dialogOptions = {
          properties: ["openFile", "multiSelections"],
          filters: [{ name: "CSV", extensions: ["csv"] }],
        };
        const result = parentWindow
          ? await dialog.showOpenDialog(parentWindow, dialogOptions)
          : await dialog.showOpenDialog(dialogOptions);
        if (result.canceled || !result.filePaths.length) {
          return { canceled: true };
        }
        const filePaths = [...result.filePaths].sort();
        const MAX_IMPORT_BYTES = 200 * 1024 * 1024;
        const { createGranolaNoteKeyAllocator, parseGranolaCsv } =
          await import("./granolaImport.js");
        const allocateNoteKey = createGranolaNoteKeyAllocator();
        const notes = [];
        const seenIds = new Set();
        let rowIssueCount = 0;
        for (const filePath of filePaths) {
          if (fs.statSync(filePath).size > MAX_IMPORT_BYTES) {
            return { canceled: false, success: false, error: "FILE_TOO_LARGE" };
          }
          const parsed = parseGranolaCsv(fs.readFileSync(filePath, "utf8"), {
            allocateNoteKey,
          });
          if (!parsed.ok) {
            return { canceled: false, success: false, error: parsed.error.code };
          }
          // File-level warnings (e.g. ignored columns) are expected on every
          // real export; only row-scoped problems belong in the issue count.
          rowIssueCount += parsed.warnings.filter((warning) => warning.row != null).length;
          for (const note of parsed.notes) {
            if (!seenIds.has(note.clientNoteId)) {
              seenIds.add(note.clientNoteId);
              notes.push(note);
            }
          }
        }
        const existing = new Set(
          this.databaseManager.getExistingClientNoteIds(notes.map((n) => n.clientNoteId))
        );
        const freshNotes = notes.filter((n) => !existing.has(n.clientNoteId));
        // The run handler only ever imports what this preview parsed — the
        // renderer never sends a file path across the bridge.
        this._granolaImportPending = { notes };
        return {
          canceled: false,
          success: true,
          fileName: filePaths.map((p) => path.basename(p)).join(", "),
          total: notes.length,
          newCount: freshNotes.length,
          duplicateCount: notes.length - freshNotes.length,
          sampleTitles: freshNotes.slice(0, 5).map((n) => n.title),
          rowIssueCount,
        };
      } catch (error) {
        debugLogger.error(
          "Granola import preview failed",
          { error: error.message },
          "granola-import"
        );
        return { canceled: false, success: false, error: "READ_FAILED" };
      }
    });

    ipcMain.handle("granola-import-run", async () => {
      const pending = this._granolaImportPending;
      this._granolaImportPending = null;
      if (!pending) return { success: false, error: "NO_PENDING_IMPORT" };
      try {
        const result = this.databaseManager.importNotes(pending.notes);
        if (result.imported > 0) {
          // One index wake-up: the SQLite triggers already journaled every
          // imported note, and the note-files mirror hears each insert itself.
          setImmediate(() => {
            try {
              this.notifyVectorChanges();
            } catch (sideEffectError) {
              debugLogger.error(
                "Granola import side effects failed",
                { error: sideEffectError.message },
                "granola-import"
              );
            }
          });
        }
        return {
          success: true,
          imported: result.imported,
          skipped: result.skipped,
          errors: result.errors,
        };
      } catch (error) {
        debugLogger.error("Granola import failed", { error: error.message }, "granola-import");
        return { success: false, error: "IMPORT_FAILED" };
      }
    });

    ipcMain.handle("get-speaker-mappings", async (_event, noteId) => {
      return this.databaseManager.getSpeakerMappings(noteId);
    });

    ipcMain.handle(
      "set-speaker-mapping",
      async (_event, noteId, speakerId, displayName, email, profileId) => {
        const embeddings = this.databaseManager.getNoteSpeakerEmbeddings(noteId);
        const noteSpeakerEmbedding = embeddings.find((e) => e.speaker_id === speakerId);
        const liveSpeakerEmbedding = liveSpeakerIdentifier.getSpeakerEmbedding(speakerId);
        const speakerEmbeddingBuffer =
          noteSpeakerEmbedding?.embedding ||
          (liveSpeakerEmbedding ? Buffer.from(liveSpeakerEmbedding.buffer) : null);

        let resolvedProfileId = profileId ?? null;
        if (speakerEmbeddingBuffer) {
          const profile = this.databaseManager.upsertSpeakerProfile(
            displayName,
            email || null,
            speakerEmbeddingBuffer,
            resolvedProfileId
          );
          resolvedProfileId = profile.id;
          this._retroactiveMapping(profile);
        }

        this.databaseManager.setSpeakerMapping(noteId, speakerId, resolvedProfileId, displayName);
        liveSpeakerIdentifier.mapSpeaker(speakerId, resolvedProfileId, displayName, noteId);
        return { success: true, profileId: resolvedProfileId };
      }
    );

    ipcMain.handle("remove-speaker-mapping", async (_event, noteId, speakerId) => {
      this.databaseManager.removeSpeakerMapping(noteId, speakerId);
      return { success: true };
    });

    ipcMain.handle("get-speaker-profiles", async () => {
      return this.databaseManager.getSpeakerProfiles();
    });

    ipcMain.handle("attach-speaker-email", async (_event, profileId, email) => {
      try {
        const profile = this.databaseManager.attachEmailToProfile(profileId, email);
        this._retroactiveMapping(profile);
        return {
          success: true,
          profile: {
            id: profile.id,
            display_name: profile.display_name,
            email: profile.email,
            sample_count: profile.sample_count,
          },
        };
      } catch (error) {
        debugLogger.error(
          "Failed to attach email to speaker profile",
          { error: error.message },
          "speaker"
        );
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("get-meeting-audio-info", async (_event, noteId) => {
      const sessions = await listMeetingAudioForNote(noteId);
      return { sessions: sessions.length, canDiarize: this._canDiarize() };
    });

    ipcMain.handle("rediarize-meeting-note", async (_event, noteId, speakerCount) =>
      this._rediarizeMeetingNote(noteId, speakerCount)
    );

    ipcMain.handle("save-note-speaker-embeddings", async (_event, noteId, embeddingsObj) => {
      const buffers = {};
      for (const [speakerId, arr] of Object.entries(embeddingsObj)) {
        buffers[speakerId] = Buffer.from(new Float32Array(arr).buffer);
      }
      this.databaseManager.saveNoteSpeakerEmbeddings(noteId, buffers);
      this._tryAutoLabelOneOnOne(noteId);
      return { success: true };
    });
  }

  _retroactiveMapping(profile) {
    setImmediate(async () => {
      try {
        const speakerEmbeddings = require("./speakerEmbeddings");
        const noteIds = this.databaseManager.getNotesWithUnmappedSpeakers();

        const profileEmb = new Float32Array(
          profile.embedding.buffer,
          profile.embedding.byteOffset,
          profile.embedding.byteLength / 4
        );

        for (const noteId of noteIds) {
          const embeddings = this.databaseManager.getNoteSpeakerEmbeddings(noteId);
          const existing = this.databaseManager.getSpeakerMappings(noteId);
          const mappedSpeakers = new Set(existing.map((m) => m.speaker_id));
          for (const emb of embeddings) {
            if (mappedSpeakers.has(emb.speaker_id)) continue;

            const speakerEmb = new Float32Array(
              emb.embedding.buffer,
              emb.embedding.byteOffset,
              emb.embedding.byteLength / 4
            );
            const similarity = speakerEmbeddings.cosineSimilarity(profileEmb, speakerEmb);

            if (similarity > 0.6) {
              this.databaseManager.setSpeakerMapping(
                noteId,
                emb.speaker_id,
                profile.id,
                profile.display_name
              );

              const note = this.databaseManager.getNote(noteId);
              if (note?.transcript) {
                try {
                  const segments = JSON.parse(note.transcript);
                  let changed = false;
                  for (const seg of segments) {
                    if (seg.speaker === emb.speaker_id && !seg.speakerName) {
                      if (canAutoRelabelSpeaker(seg)) {
                        applyConfirmedSpeaker(seg, {
                          speakerName: profile.display_name,
                          speakerIsPlaceholder: false,
                        });
                      } else {
                        seg.speakerName = profile.display_name;
                        seg.speakerIsPlaceholder = false;
                      }
                      changed = true;
                    }
                  }
                  if (changed) {
                    this.databaseManager.updateNote(noteId, {
                      transcript: JSON.stringify(segments),
                    });
                  }
                } catch (_) {}
              }
            }
          }
        }
      } catch (err) {
        debugLogger.warn("Retroactive speaker mapping failed", { error: err.message });
      }
    });
  }

  _tryAutoLabelOneOnOne(noteId) {
    setImmediate(async () => {
      try {
        const note = this.databaseManager.getNote(noteId);
        const other = this._resolveOneOnOneOtherParticipant(note?.participants);
        if (!other) return;
        const { displayName, email } = other;

        const embeddings = this.databaseManager.getNoteSpeakerEmbeddings(noteId);
        if (!embeddings.length) return;

        const existingMappings = this.databaseManager.getSpeakerMappings(noteId);
        const mappedSpeakers = new Set(existingMappings.map((m) => m.speaker_id));

        const transcript = note.transcript ? JSON.parse(note.transcript) : [];
        const systemSpeakers = new Set(
          transcript.filter((s) => s.source !== "mic" && s.speaker).map((s) => s.speaker)
        );

        const unmapped = embeddings.filter(
          (e) => !mappedSpeakers.has(e.speaker_id) && systemSpeakers.has(e.speaker_id)
        );
        if (!unmapped.length) return;

        let profile = null;
        for (const emb of unmapped) {
          profile = this.databaseManager.upsertSpeakerProfile(
            displayName,
            email,
            emb.embedding,
            profile?.id ?? null
          );
          this.databaseManager.setSpeakerMapping(noteId, emb.speaker_id, profile.id, displayName);
          liveSpeakerIdentifier.mapSpeaker(emb.speaker_id, profile.id, displayName, noteId);
        }

        const unmappedSystemSpeakers = new Set(unmapped.map((e) => e.speaker_id));
        let changed = false;
        for (const seg of transcript) {
          if (!unmappedSystemSpeakers.has(seg.speaker)) continue;
          if (seg.speakerName && !seg.speakerIsPlaceholder) continue;
          if (canAutoRelabelSpeaker(seg)) {
            applyConfirmedSpeaker(seg, { speakerName: displayName, speakerIsPlaceholder: false });
          } else {
            seg.speakerName = displayName;
            seg.speakerIsPlaceholder = false;
          }
          changed = true;
        }

        if (changed) {
          this.databaseManager.updateNote(noteId, { transcript: JSON.stringify(transcript) });
          const updated = this.databaseManager.getNote(noteId);
          if (updated) broadcastToWindows("note-updated", updated);
        }

        if (profile) this._retroactiveMapping(profile);

        debugLogger.info(
          "Auto-labeled 1-on-1 meeting speakers",
          { noteId, displayName, speakerCount: unmapped.length },
          "speaker"
        );
      } catch (err) {
        debugLogger.warn("Auto-label 1-on-1 failed", { noteId, error: err.message }, "speaker");
      }
    });
  }

  _applySpeakerName(segments, speakerId, displayName) {
    if (!displayName) {
      return;
    }

    for (const segment of segments) {
      if (segment.speaker !== speakerId) {
        continue;
      }

      applyConfirmedSpeaker(segment, {
        speakerName: displayName,
        speakerIsPlaceholder: false,
        suggestedName: undefined,
        suggestedProfileId: undefined,
      });
    }
  }

  _reconcileLiveSpeakerState(liveSpeakerState, speakerEmbeddingsMap, enrichedSegments) {
    if (!liveSpeakerState || !speakerEmbeddingsMap) {
      return new Set();
    }

    const speakerEmbeddings = require("./speakerEmbeddings");
    const reconciledSpeakers = new Set();
    const usedLiveSpeakers = new Set();
    const noteMappings = new Map();

    const liveEntries = Object.entries(liveSpeakerState)
      .map(([speakerId, data]) => ({
        speakerId,
        displayName: data?.displayName || null,
        profileId: data?.profileId ?? null,
        noteId: data?.noteId ?? null,
        embedding: Array.isArray(data?.embedding) ? new Float32Array(data.embedding) : null,
      }))
      .filter((entry) => entry.embedding);

    const getMappingsForNote = (noteId) => {
      if (!noteMappings.has(noteId)) {
        noteMappings.set(noteId, this.databaseManager.getSpeakerMappings(noteId));
      }
      return noteMappings.get(noteId);
    };

    for (const [mappedId, embeddingArray] of Object.entries(speakerEmbeddingsMap)) {
      let bestEntry = null;
      let bestSimilarity = 0;

      for (const entry of liveEntries) {
        if (usedLiveSpeakers.has(entry.speakerId)) {
          continue;
        }

        const similarity = speakerEmbeddings.cosineSimilarity(
          new Float32Array(embeddingArray),
          entry.embedding
        );
        if (similarity > bestSimilarity) {
          bestSimilarity = similarity;
          bestEntry = entry;
        }
      }

      if (!bestEntry || bestSimilarity <= 0.6) {
        continue;
      }

      usedLiveSpeakers.add(bestEntry.speakerId);
      reconciledSpeakers.add(mappedId);

      let displayName = bestEntry.displayName;
      let profileId = bestEntry.profileId;

      if (bestEntry.noteId) {
        const liveMapping = getMappingsForNote(bestEntry.noteId).find(
          (mapping) => mapping.speaker_id === bestEntry.speakerId
        );
        if (liveMapping) {
          displayName = liveMapping.display_name || displayName;
          profileId = liveMapping.profile_id ?? profileId;
          this.databaseManager.setSpeakerMapping(
            bestEntry.noteId,
            mappedId,
            profileId,
            displayName
          );
          // Live and offline ids share one namespace now, so they often match —
          // removing the "old" row would delete the mapping just written.
          if (bestEntry.speakerId !== mappedId) {
            this.databaseManager.removeSpeakerMapping(bestEntry.noteId, bestEntry.speakerId);
          }
        } else if (displayName) {
          this.databaseManager.setSpeakerMapping(
            bestEntry.noteId,
            mappedId,
            profileId,
            displayName
          );
        }
      }

      this._applySpeakerName(enrichedSegments, mappedId, displayName);
    }

    return reconciledSpeakers;
  }

  // The renderer's base covers the transcript it resumes; mappings and embeddings
  // can also hold ids no row carries any more (merged clusters, a cluster that
  // owned no segment), and a reused one would still name the new voice.
  // A note recorded again before its last session's diarization lands has neither
  // that result's ids in the seed nor its embeddings stored yet, so the session's
  // reserved ceiling counts too.
  _resolveMeetingSpeakerIndexBase(noteId, requestedBase) {
    let base = normalizeSpeakerIndexBase(requestedBase);
    if (noteId == null) return base;
    for (const reservation of this._diarizationSpeakerReservations.values()) {
      if (reservation.noteId === noteId) base = Math.max(base, reservation.ceiling);
    }
    try {
      const storedIds = [
        ...this.databaseManager.getSpeakerMappings(noteId).map((m) => m.speaker_id),
        ...this.databaseManager.getNoteSpeakerEmbeddings(noteId).map((e) => e.speaker_id),
      ];
      return resolveSpeakerIndexBase(base, storedIds);
    } catch (error) {
      debugLogger.warn(
        "Could not read stored speaker ids for the meeting note",
        { noteId, error: error.message },
        "speaker"
      );
      return base;
    }
  }

  // Only a count the user set (the stepper during recording, a stored note
  // count, Re-detect) is followed exactly. Anything else — an invite, the live
  // labels, nothing — lets the engine decide (numSpeakers -1, no cap): an invite
  // lists who may attend, not who talks, and a forced count merges whoever
  // speaks beyond it.
  _resolveSpeakerExpectation({ sessionConfig, noteId, diarizedSource }) {
    let expectedTotal = sessionConfig?.explicit ? sessionConfig.expectedCount : null;
    if (!expectedTotal && noteId != null) {
      try {
        expectedTotal = normalizeStoredSpeakerCount(
          this.databaseManager.getNote(noteId)?.expected_speaker_count
        );
      } catch (_) {
        expectedTotal = null;
      }
    }
    if (!expectedTotal) return { numSpeakers: -1, cap: null };

    // Diarizing the mic track (in-person session) means the user is one of the
    // diarized voices; on a call only the other side reaches the diarizer.
    const numSpeakers = diarizedSource === "mic" ? expectedTotal : Math.max(1, expectedTotal - 1);
    return { numSpeakers, cap: numSpeakers };
  }

  // Synchronous: the meeting stop path decides before any async work starts.
  _canDiarize() {
    const route = this.diarizationRoute;
    if (route.transport === "http") return true;
    if (route.transport === "local") return !!this.diarizationManager?.isAvailable();
    return false;
  }

  // One contract for both diarizers: 16 kHz mono WAV in, "speaker_N" segments
  // out, [] on any failure — speakers enrich a transcript and never fail it.
  // The server picks its own speaker count, so numSpeakers and threshold only
  // steer the local diarizer; callers cap clusters afterwards either way.
  async _diarizeWav(wavPath, options = {}) {
    const route = this.diarizationRoute;
    if (route.transport === "local") {
      return this.diarizationManager.diarize(wavPath, options);
    }
    if (route.transport === "error") {
      debugLogger.warn("Speaker detection skipped", { error: route.message });
      return [];
    }

    const signal = options.signal ?? null;
    if (signal?.aborted) return [];
    try {
      const wavBuffer = await fs.promises.readFile(wavPath);
      const apiKey = this.environmentManager.getCustomTranscriptionKey();
      const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
      const post = (fields, requestSignal) => {
        const { body, boundary } = buildMultipartBody(wavBuffer, "audio.wav", "audio/wav", fields);
        return postMultipart(new URL(route.endpoint), body, boundary, headers, {
          signal: requestSignal,
        });
      };
      debugLogger.info("Starting self-hosted diarization", { endpoint: route.endpoint });
      const { segments, mode, durationSeconds } = await diarizeViaServer({
        wavBuffer,
        post,
        signal,
      });
      debugLogger.info("Self-hosted diarization complete", {
        mode,
        durationSeconds: Math.round(durationSeconds),
        segmentCount: segments.length,
        speakerCount: new Set(segments.map((segment) => segment.speaker)).size,
      });
      return segments;
    } catch (error) {
      if (signal?.aborted) return [];
      debugLogger.warn("Self-hosted diarization failed", {
        endpoint: route.endpoint,
        statusCode: error.statusCode,
        error: error.message,
      });
      return [];
    }
  }

  async _archiveMeetingAudio(wavPath, noteId, startedAt, track) {
    try {
      const filePath = await archiveMeetingAudio(wavPath, { noteId, startedAt, track });
      debugLogger.info("Meeting audio kept", { noteId, filePath });
      broadcastToWindows("meeting-audio-saved", { noteId });
    } catch (error) {
      debugLogger.warn("Keeping meeting audio failed", { noteId, error: error.message });
    }
  }

  // Archives a raw capture diarization didn't run on (the skipped session's
  // track, or the other channel), then deletes it. offsetMs lines it up with
  // the session's start stamp.
  async _releaseMeetingCapture(rawPcmPath, noteId, startedAt, { track, offsetMs = 0 } = {}) {
    let wavPath = null;
    try {
      if (this._keepsMeetingAudio() && this.diarizationManager) {
        wavPath = await this.diarizationManager.convertRawPcmToWav(rawPcmPath, 24000, {
          offsetMs,
        });
        await this._archiveMeetingAudio(wavPath, noteId, startedAt, track);
      }
    } catch (error) {
      debugLogger.warn("Keeping meeting audio failed", { noteId, error: error.message });
    } finally {
      fs.unlink(rawPcmPath, () => {});
      if (wavPath) fs.unlink(wavPath, () => {});
    }
  }

  // Diarizes a 16 kHz mono WAV, labels the transcript rows of the diarized
  // source from it and names clusters from saved voice profiles. Shared by the
  // meeting stop path and re-detecting a saved meeting's speakers.
  async _diarizeTranscript({
    wavPath,
    segments,
    numSpeakers,
    cap,
    diarizedSource,
    speakerIndexBase = 0,
    liveSpeakerState = null,
  }) {
    // A count the user set is followed exactly. Otherwise the engine decides,
    // with the upload path's cleanup: a threshold that grows with length, a
    // collapsed run discarded, phantom slivers dropped.
    const auto = !(numSpeakers > 0);
    const threshold = auto
      ? resolveClusterThreshold(
          (fs.statSync(wavPath, { throwIfNoEntry: false })?.size ?? NaN) /
            PCM16_MONO_16K_BYTES_PER_SECOND
        )
      : undefined;
    let diarizationSegments = await this._diarizeWav(
      wavPath,
      auto ? { threshold } : { numSpeakers }
    );
    if (auto) {
      if (isCollapsedDiarization(diarizationSegments)) {
        debugLogger.warn("Discarding meeting diarization: one cluster holds nearly all speech");
        diarizationSegments = [];
      }
      diarizationSegments = dropNegligibleClusters(diarizationSegments);
    }
    if (cap != null) {
      diarizationSegments = this.diarizationManager.capSpeakerClusters(diarizationSegments, cap);
    }

    const enrichedSegments = this.diarizationManager.mergeWithTranscript(
      segments,
      diarizationSegments,
      { diarizedSource, speakerIndexBase }
    );

    const speakerSet = new Set(diarizationSegments.map((d) => d.speaker));
    const speakerRenumber = buildSpeakerRenumber(speakerSet, speakerIndexBase);
    // Mirrors the mic-mode single-cluster softening in mergeWithTranscript:
    // every segment stays "you", so persisting an embedding keyed to a
    // cluster id that owns no segments would leave the note inconsistent.
    const micSingleClusterSoftened = diarizedSource === "mic" && speakerSet.size === 1;

    let speakerEmbeddingsMap = null;
    const speakerEmb = require("./speakerEmbeddings");
    try {
      if (!micSingleClusterSoftened && speakerEmb.isAvailable() && wavPath) {
        const speakerIds = [...new Set(diarizationSegments.map((s) => s.speaker))];
        speakerEmbeddingsMap = {};

        for (const spk of speakerIds) {
          const segs = diarizationSegments.filter((s) => s.speaker === spk);
          const sorted = segs.sort((a, b) => b.end - b.start - (a.end - a.start)).slice(0, 3);
          const embeddings = [];
          for (const seg of sorted) {
            if (seg.end - seg.start < 1.5) continue;
            const emb = await speakerEmb.extractEmbedding(wavPath, seg.start, seg.end);
            if (emb) embeddings.push(emb);
          }
          if (embeddings.length > 0) {
            const centroid = speakerEmb.computeCentroid(embeddings);
            const mappedId = speakerRenumber.get(spk) || spk;
            speakerEmbeddingsMap[mappedId] = Array.from(centroid);
          }
        }
      }
    } catch (err) {
      debugLogger.debug("Speaker embedding extraction skipped", { error: err.message });
    }

    const reconciledSpeakers = this._reconcileLiveSpeakerState(
      liveSpeakerState,
      speakerEmbeddingsMap,
      enrichedSegments
    );

    if (speakerEmbeddingsMap) {
      try {
        const profiles = this.databaseManager.getSpeakerProfiles(true);

        if (profiles.length > 0) {
          for (const [mappedId, embArr] of Object.entries(speakerEmbeddingsMap)) {
            const alreadyMapped = enrichedSegments.some(
              (segment) => segment.speaker === mappedId && segment.speakerName
            );
            if (reconciledSpeakers.has(mappedId) || alreadyMapped) {
              continue;
            }

            const emb = new Float32Array(embArr);
            let bestProfile = null;
            let bestSim = 0;

            for (const profile of profiles) {
              const profileEmb = new Float32Array(
                profile.embedding.buffer,
                profile.embedding.byteOffset,
                profile.embedding.byteLength / 4
              );
              const sim = speakerEmb.cosineSimilarity(emb, profileEmb);
              if (sim > bestSim) {
                bestSim = sim;
                bestProfile = profile;
              }
            }

            if (bestProfile && bestSim > 0.6) {
              for (const seg of enrichedSegments) {
                if (seg.speaker === mappedId) {
                  applyConfirmedSpeaker(seg, {
                    speakerName: bestProfile.display_name,
                    speakerIsPlaceholder: false,
                    suggestedName: undefined,
                    suggestedProfileId: undefined,
                  });
                }
              }
            } else if (bestProfile && bestSim > 0.5) {
              for (const seg of enrichedSegments) {
                if (seg.speaker === mappedId) {
                  if (isSpeakerLocked(seg)) {
                    continue;
                  }
                  applySuggestedSpeaker(seg, {
                    suggestedName: bestProfile.display_name,
                    suggestedProfileId: bestProfile.id,
                  });
                }
              }
            }
          }
        }
      } catch (err) {
        debugLogger.debug("Auto speaker recognition skipped", { error: err.message });
      }
    }

    return {
      enrichedSegments,
      speakerEmbeddingsMap,
      speakerCount: speakerRenumber.size,
    };
  }

  // Runs speaker detection again on a meeting's kept audio with the number of
  // people the user gives (a total that includes them). Old cluster names and
  // voices are dropped; the caller persists the returned transcript.
  async _rediarizeMeetingNote(noteId, speakerCount) {
    const expectedCount = normalizeStoredSpeakerCount(speakerCount);
    if (expectedCount == null) return { success: false, code: "INVALID_COUNT" };
    if (!this._canDiarize()) return { success: false, code: "UNAVAILABLE" };
    const archives = await listMeetingAudioForNote(noteId);
    if (archives.length === 0) return { success: false, code: "NO_AUDIO" };
    // shortcut: a note recorded in several sessions keeps one file per session but
    // not which rows each covers; support it once session boundaries are stored.
    if (archives.length > 1) return { success: false, code: "MULTIPLE_SESSIONS" };

    let segments = [];
    try {
      segments = JSON.parse(this.databaseManager.getNote(noteId)?.transcript || "[]");
    } catch (_) {}
    if (!Array.isArray(segments) || segments.length === 0) {
      return { success: false, code: "NO_TRANSCRIPT" };
    }

    const [session] = archives;
    // Older archives kept one unsuffixed track: a call diarized the other side;
    // a recording without system audio, the room.
    const inferredSource = segments.some((s) => s.source === "system") ? "system" : "mic";
    // The track diarization chose first; the other capture if that finds nobody
    // (a speakerphone call's system channel holds only chimes).
    for (const track of [session, session.alternate].filter(Boolean)) {
      const result = await this._rediarizeMeetingTrack({
        noteId,
        filePath: track.filePath,
        diarizedSource: track.source ?? inferredSource,
        startedAt: session.startedAt,
        segments,
        expectedCount,
      });
      if (result) return { success: true, segments: result };
    }
    return { success: false, code: "FAILED" };
  }

  // One re-detect attempt on one kept track; null when it finds no speakers.
  async _rediarizeMeetingTrack({
    noteId,
    filePath,
    diarizedSource,
    startedAt,
    segments,
    expectedCount,
  }) {
    const rows = segments.map((segment) => {
      const row = { ...segment };
      // Rows saved without diarization keep epoch-ms timestamps (#2781).
      if (row.timestamp > 1e9 && Number.isFinite(startedAt)) {
        row.timestamp = (row.timestamp - startedAt) / 1000;
      }
      // Lines the user assigned by hand stay theirs.
      if (row.source === diarizedSource && !isSpeakerLocked(row)) {
        for (const key of [
          "speaker",
          "speakerName",
          "speakerIsPlaceholder",
          "speakerStatus",
          "suggestedName",
          "suggestedProfileId",
        ]) {
          delete row[key];
        }
      }
      return row;
    });
    const { numSpeakers, cap } = this._resolveSpeakerExpectation({
      sessionConfig: { explicit: true, expectedCount },
      noteId,
      diarizedSource,
    });

    const { convertToWav } = require("./ffmpegUtils");
    const wavPath = path.join(os.tmpdir(), `ow-rediarize-${noteId}-${Date.now()}.wav`);
    try {
      await convertToWav(filePath, wavPath, { sampleRate: 16000, channels: 1 });
      const {
        enrichedSegments,
        speakerEmbeddingsMap,
        speakerCount: found,
      } = await this._diarizeTranscript({
        wavPath,
        segments: rows,
        numSpeakers,
        cap,
        diarizedSource,
      });
      if (found === 0) {
        debugLogger.info("Re-detect found no speakers", { noteId, diarizedSource });
        return null;
      }

      const embeddings = {};
      for (const [speakerId, values] of Object.entries(speakerEmbeddingsMap || {})) {
        embeddings[speakerId] = Buffer.from(new Float32Array(values).buffer);
      }
      this.databaseManager.replaceNoteSpeakers(noteId, embeddings);
      debugLogger.info("Meeting speakers detected again", {
        noteId,
        expectedCount,
        found,
        diarizedSource,
      });
      return enrichedSegments;
    } catch (error) {
      debugLogger.warn("Detecting meeting speakers again failed", {
        noteId,
        diarizedSource,
        error: error.message,
      });
      return null;
    } finally {
      fs.promises.unlink(wavPath).catch(() => {});
    }
  }

  _startOrSkipDiarization(
    sessionId,
    rawPcmPath,
    audioStartedAt,
    transcriptSegments,
    win,
    liveSpeakerState = null,
    sessionConfig = null,
    noteId = null,
    diarizedSource = "system",
    speakerIndexBase = 0,
    retractedSegments = [],
    alternateCapture = null
  ) {
    const startMs =
      (Number.isFinite(audioStartedAt) && audioStartedAt) ||
      transcriptSegments.find((segment) => segment.source === diarizedSource)?.timestamp ||
      transcriptSegments[0]?.timestamp ||
      0;
    const isEpochMs = startMs > 1e9;
    // A batch's audio start places it on the diarization timeline; its
    // timestamp is when the text came back, a whole batch or more later.
    const normalized = transcriptSegments.map(({ audioStartedAt: batchStart, ...seg }) => {
      const at = batchStart ?? seg.timestamp;
      return {
        ...seg,
        timestamp: at != null ? (isEpochMs ? (at - startMs) / 1000 : at) : undefined,
      };
    });

    // Split before any send so diarized, skipped and failed runs drop the same
    // echo rows.
    const { kept, removed: echoDuplicates } = this.diarizationManager?.splitMicEchoDuplicates(
      normalized
    ) ?? { kept: normalized, removed: [] };
    const echoDuplicateSet = new Set(echoDuplicates);
    const isEchoDuplicate = (index) => echoDuplicateSet.has(normalized[index]);
    // Rows main dropped that the renderer may still hold in the transcript it
    // persisted at stop. Raw (epoch-ms) timestamps, matching that copy (#2781).
    const removedSegments = [
      ...retractedSegments,
      ...transcriptSegments.filter((_, index) => isEchoDuplicate(index)),
    ].map(({ text, source, timestamp }) => ({ text, source, timestamp }));
    const send = (payload) => {
      if (win && !win.isDestroyed()) {
        win.webContents.send("meeting-diarization-complete", {
          sessionId,
          noteId,
          ...payload,
          removedSegments,
        });
      }
    };
    // Raw rows, sent when there is no diarization to merge.
    const sendUndiarized = () =>
      send({
        segments: transcriptSegments
          .map((segment, index) => ({ ...segment, id: segment.id || `segment-${index}` }))
          .filter((_, index) => !isEchoDuplicate(index)),
      });

    // The channel diarization doesn't use is kept too, so re-detect can fall back to it.
    if (alternateCapture?.pcmPath) {
      void this._releaseMeetingCapture(alternateCapture.pcmPath, noteId, audioStartedAt, {
        track: `${alternateCapture.source}-alt`,
        offsetMs: alternateCapture.startedAt - audioStartedAt,
      });
    }

    const diarizationEnabled = (sessionConfig?.enabled ?? this.speakerDiarizationEnabled) !== false;

    if (!diarizationEnabled || !this._canDiarize() || !rawPcmPath) {
      // The capture is written for every session, so a skipped run still owns it.
      if (rawPcmPath) {
        void this._releaseMeetingCapture(rawPcmPath, noteId, audioStartedAt, {
          track: diarizedSource,
        });
      }
      sendUndiarized();
      return;
    }

    const { numSpeakers, cap } = this._resolveSpeakerExpectation({
      sessionConfig,
      noteId,
      diarizedSource,
    });
    // Reserved before the async work so a "record more" started while this runs
    // numbers its speakers past every cluster the result can name. An automatic
    // run's count is unknown until it lands, so it holds a wide block meanwhile.
    if (noteId != null) {
      this._diarizationSpeakerReservations.set(sessionId, {
        noteId,
        ceiling: speakerIndexBase + (cap ?? 100),
      });
    }

    (async () => {
      let tmpWav = null;
      try {
        tmpWav = await this.diarizationManager.convertRawPcmToWav(rawPcmPath, 24000);
        const { enrichedSegments, speakerEmbeddingsMap, speakerCount } =
          await this._diarizeTranscript({
            wavPath: tmpWav,
            segments: kept,
            numSpeakers,
            cap,
            diarizedSource,
            speakerIndexBase,
            liveSpeakerState,
          });
        // Narrowed to the ids the result actually names; kept until quit, since the
        // renderer persists them only after this send.
        if (noteId != null) {
          this._diarizationSpeakerReservations.set(sessionId, {
            noteId,
            ceiling: speakerIndexBase + speakerCount,
          });
        }

        send({ segments: enrichedSegments, speakerEmbeddings: speakerEmbeddingsMap });
      } catch (err) {
        debugLogger.warn("Background diarization failed", { error: err.message });
        this._diarizationSpeakerReservations.delete(sessionId);
        // The renderer only applies removedSegments alongside segments, so a
        // failed run falls back to the skip result rather than an empty one.
        sendUndiarized();
      } finally {
        if (tmpWav && this._keepsMeetingAudio()) {
          await this._archiveMeetingAudio(tmpWav, noteId, audioStartedAt, diarizedSource);
        }
        try {
          fs.unlinkSync(rawPcmPath);
        } catch (_) {}
        if (tmpWav) {
          try {
            fs.unlinkSync(tmpWav);
          } catch (_) {}
        }
      }
    })();
  }

  deleteTranscriptionInternal(id) {
    this.audioStorageManager.deleteAudio(id);
    const result = this.databaseManager.deleteTranscription(id);
    if (result?.success) {
      setImmediate(() => {
        broadcastToWindows("transcription-deleted", { id });
      });
    }
    return result;
  }

  deleteNoteInternal(id) {
    const result = this.databaseManager.deleteNote(id);
    if (result?.success) {
      setImmediate(() => broadcastToWindows("note-deleted", { id }));
      this.notifyVectorChanges();
    }
    return result;
  }
}

module.exports = IPCHandlers;
