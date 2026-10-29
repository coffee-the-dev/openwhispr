# OpenWhispr Technical Reference for AI Assistants

This document provides comprehensive technical details about the OpenWhispr project architecture for AI assistants working on the codebase.

## Response Style

Keep responses focused, brief, and concise. Keep disclaimers and caveats short, and spend most of the response on the main answer. When asked to explain something, give a high-level summary unless an in-depth explanation is specifically requested.

## Project Overview

OpenWhispr is an Electron-based desktop dictation, meeting-notes and voice-assistant application. This is a **local-only fork**: speech-to-text and AI processing run either on-device (whisper.cpp, NVIDIA Parakeet via sherpa-onnx, llama.cpp) or against servers the user runs on their own LAN (any OpenAI-compatible endpoint, plus SearXNG for web search). There is no OpenWhispr account, cloud API, third-party provider (BYOK), telemetry upload, auto-updater, or Google/Microsoft calendar integration; nothing contacts a host the user did not configure except model/binary downloads they start (see `docs/network-allowlist.md`).

## Architecture Overview

### Core Technologies

- **Frontend**: React 19, TypeScript, Tailwind CSS v4, Vite
- **Desktop Framework**: Electron 41 with context isolation
- **Database**: better-sqlite3 for local transcription history
- **UI Components**: shadcn/ui with Radix primitives
- **Speech Processing**: whisper.cpp + NVIDIA Parakeet (via sherpa-onnx) on-device, or a self-hosted OpenAI-compatible `/audio/transcriptions` server
- **AI Processing**: llama.cpp (`llama-server`) on-device, or a self-hosted OpenAI-compatible `/chat/completions` server, via the Vercel AI SDK (`ai` + `@ai-sdk/openai`)
- **Audio Processing**: FFmpeg (bundled via ffmpeg-static)
- **Node.js**: 24 (pinned in `.nvmrc` — CI uses Node 24, do NOT regenerate `package-lock.json` with a different major version)

### Key Architectural Decisions

1. **Dual Window Architecture**:
   - Main Window: Minimal overlay for dictation (draggable, always on top)
   - Control Panel: Full settings interface (normal window)
   - Both use same React codebase with URL-based routing

2. **Process Separation**:
   - Main Process: Electron main, IPC handlers, database operations
   - Renderer Process: React app with context isolation
   - Preload Script: Secure bridge between processes
   - ONNX Utility Process: hosts all `onnxruntime-node` inference (text embeddings, speaker embeddings, fbank). Lazy-spawned on first use via `src/helpers/onnxWorkerClient.js` → `src/workers/onnxWorker.js`. Native crashes (e.g., ORT `bad_alloc`) confine to the worker; main process rejects in-flight requests, waits out a backoff, and respawns the worker on the next request (never eagerly, so a crash can't leave an empty worker running). A request that times out kills the worker so it respawns the same way; the embedding clients reload their sessions on the new worker. Exits once idle with no session loaded (`releaseIfIdle`, called after semantic search releases its model and after `speakerEmbeddings.js` unloads the speaker model 5 minutes after its last extract). Each session's calls are serialized in the worker, so an unload never releases a session mid-inference. Stopped in `will-quit`.

3. **Audio Pipeline**:
   - MediaRecorder API → Blob → ArrayBuffer → IPC → File → whisper.cpp
   - Automatic cleanup of temporary files after processing

## File Structure and Responsibilities

### Main Process Files

- **main.js**: Application entry point, initializes all managers
- **preload.js**: Exposes safe IPC methods to renderer via window.api

### Native Resources (resources/)

- **windows-key-listener.c**: C source for Windows low-level keyboard hook (Push-to-Talk)
- **windows-mic-listener.c**: C source for WASAPI mic session monitor (event-driven mic detection)
- **windows-system-audio-helper.c**: C source for WASAPI process-loopback system audio capture (meeting transcription). Excludes OpenWhispr's own process tree, so it hears every app on every output device. Requires Windows 10 2004+; falls back to Chromium display-media loopback when unavailable. Mid-session, the helper emits a `capture_silent` warning when its own stream is silent while a render endpoint is metering output, checked every second for the whole session because Windows keeps some apps' streams out of process loopback (Teams call audio, #1265). Main then starts renderer loopback beside the helper, and `meetingSystemAudioHandover.js` gives loopback the system channel only after it hears audio the helper misses, so a false alarm never drops a working capture. Outputs 24 kHz mono s16le PCM on stdout, line-delimited JSON events on stderr (same protocol as linux-system-audio-helper)
- **macos-mic-listener.swift**: Swift source for the CoreAudio process-object microphone listener (event-driven mic detection); falls back to aggregate device activity and retries PID monitoring from its heartbeat
- **globe-listener.swift**: Swift source for macOS Globe/Fn key detection
- **macos-window-bounds.swift**: Swift source for the System Settings window reporter used by the onboarding permission guide. Prints the dialog's bounds, whether a sheet or authorization prompt is in front, which app owns the front window (`settings` / `self` / `other`, attributed by process because window owner names are localized) and whether System Settings is running. CoreGraphics window list only, so it needs neither Accessibility nor Screen Recording
- **bin/**: Directory for compiled native binaries (whisper-cpp, nircmd, key/mic listeners)

### Helper Modules (src/helpers/)

- **audioManager.js**: Handles audio device management
- **clipboard.js**: Cross-platform clipboard operations
  - macOS: AppleScript-based paste with accessibility permission check
  - Windows: PowerShell SendKeys with nircmd.exe fallback
  - Linux: compositor-aware Wayland paste (Hyprland sendshortcut, wlroots wtype, GNOME/KDE portal keysyms) with native uinput/XTest and system-tool fallbacks. KDE's portal paste sends Shift+Insert to every window but Warp, which binds paste to Ctrl+Shift+V only: KWin resolves keysyms in the active layout only, so a Ctrl+V on a non-Latin layout arrives as Ctrl alone (#2055). The app runs on XWayland, which the compositor won't let read a native Wayland app's clipboard while a Wayland window is focused, so `_saveClipboard` falls back to `wl-paste --type text` when Electron reads nothing; otherwise the restore would wipe the user's clipboard. On KDE it also takes wl-paste's UTF-8 plain text whenever it differs from Electron's, since KWin can leave a stale X11 owner in place after a Wayland app copies, so a rich or image restore first writes the original's text (empty for an image) to Wayland, or the app's own transcript or selection sentinel left there would read as newer. A Wayland-only copy with no plain text (a screenshot copied in Spectacle) isn't saved, so a dictation replaces it with X11's older text
  - Linux: wlroots, Hyprland and niri (xwayland-satellite) hand XWayland's clipboard to a native Wayland app only while an X11 window has focus; Mutter, COSMIC and KWin 6.0.3+ do it themselves (KDE also writes the transcript and primary selection with `wl-copy`, and Settings asks for wl-clipboard there too, since `_saveClipboard` reads the Wayland clipboard there with `wl-paste`). There (`requiresWlCopy` in `linuxSession.js`; a leftover `SWAYSOCK` or Hyprland signature under another desktop doesn't count) the transcript reaches Wayland apps only through `wl-copy`, so `_pasteText` pastes only when wl-copy wrote both the Wayland clipboard (`_writeClipboardWayland`) and the primary selection that terminals paste on Shift+Insert (`_writePrimarySelection`). `wl-copy --primary` goes through data-control, which still takes a primary selection under niri `disable-primary` (checked on niri 26.04) and Hyprland `middle_click_paste = false` (its data-control code never reads that option). Otherwise it injects nothing and returns `reason: "wl-copy-missing"` (not installed) or `"wl-copy-failed"` (e.g. killed by its 200 ms timeout): the renderer shows the dictation-error pill (Retry writes and pastes the kept text again, never records), a selection edit reports `code: "wl_copy_missing"`/`"wl_copy_failed"`, and the paste-tools card and Settings → Wayland Paste Setup ask for wl-clipboard (#2621). There, a missing `wl-copy` is probed again rather than read from the 30 s command cache, so one installed after a held-back paste counts at once
  - Linux COSMIC: paste reads the focused app from cosmic-comp's `zcosmic_toplevel_info_v1` (`cosmicToplevel.js`, a minimal Wayland wire client, bound at version 1, which still sends app_id and state), never from xdotool, whose XWayland answer goes stale while a native Wayland window has focus. A known terminal is pasted through wtype (Ctrl+Shift+V; Shift+Insert for Konsole); everything else keeps uinput Shift+Insert, since COSMIC gives no PID to spot Electron apps hosting TUIs. Short terminal names (`st`) match whole words only, or every `com.system76.*` app id would read as a terminal
  - Linux: before any paste or selection-copy chord, `linux-fast-paste --capabilities --await-modifier-release <ms>` waits for physically held modifiers to be released (XKB state on X11, `EVIOCGKEY` on Wayland; `unknown` without `/dev/input` access pastes as before). A chord injected into held keys arrives as a different shortcut, and a virtual device cannot release another device's key (#2113). Still held after 1.5 s → not pasted, `reason: "modifiers-held"`, and the renderer shows the dictation-error pill with the transcript on the clipboard; a selection edit blocked the same way reports `code: "modifiers_held"` and gets the same pill (the assistant caret paste reports the same code, for logs only). `ydotoold`'s virtual keyboard is ignored, since an interrupted chord can leave its modifier down, and an unreadable key state is logged once per session. The wait runs before `pasteLinux` detects the target window, and a selection copy that had to wait looks the target up again, since focus can move while a key is held: a fresh capture then runs the command on its own (`focus_moved`), and a revalidated session declines as `target_changed`. Retry on a modifiers-held pill pastes the kept transcript again rather than recording again (the macOS/Windows push force-stop pill keeps its record-again Retry, since neither platform waits for held keys), ignores clicks while its paste is pending, and never dismisses a newer pill. `useAudioRecording` keeps the pill in processing until the paste attempt settles (the audio manager settles before the paste starts), but never reports that to main, which drops dictation hotkeys while processing; a paste held back after the next dictation started leaves the transcript on the clipboard without a pill. The helper measures its wait on `CLOCK_MONOTONIC`, since the JS watchdog kills it at timeout + 1 s
- **database.js**: SQLite operations for transcription history
- **noteUndo.js**: Undo for assistant `update_note` edits. The tool passes `{ undoable, expected, turn }` to `db-update-note`; inside one transaction main refuses the edit if a guarded field changed since the tool read the note, writes it, and journals the previous values in `assistant_note_undo` (one row per note, bound to the account and kept 10 minutes). An `AFTER UPDATE` trigger retires the row when any guarded field changes again (manual save, sync pull, delete, identity or folder change), treating `''` and NULL as equal because a pull stores an empty field as NULL; sync acknowledgements don't retire it. Edits of one note in the same chat turn (`turn` = the assistant message id) share one Undo; `update_note` runs one note's edits in turn, since the AI SDK runs a step's tool calls concurrently. `AssistantNoteUndoListener` (control panel and dictation window) offers each edit once, in the first focused window (`db-claim-note-undo`); typing in the open note retires it (`discardNoteUndo`). The trigger is recreated and a journal of another shape is dropped at launch; if setup fails, edits save without Undo
- **debugLogger.js**: Debug logging system with file output
- **providerHttpErrors.js**: Pure ESM classifier for self-hosted endpoint failures (transcription and AI models), shared by main (require(esm)) and renderer. `providerHttpError({ provider, status, body, headers, model, surface, selfHosted })` builds an Error carrying `code` (`PROVIDER_AUTH_FAILED`, `PROVIDER_QUOTA_EXHAUSTED`, …), `messageKey` (`providerErrors.*`), `messageParams`, `settingsTarget` (`speechToText`/`llms`, fixable errors only) and redacted `technicalDetails`; `asProviderError` classifies AI SDK, timeout and network errors and leaves already-keyed errors alone. Raw provider bodies never reach UI text. Rendered by `src/utils/describeProviderError.ts`
- **devServerManager.js**: Vite dev server integration
- **dockManager.js**: Single owner of the macOS Dock icon
  - The icon follows the control panel: it appears when the panel opens and goes away when the panel closes to the tray, so no other caller (in particular the dictation panel's hide path) can resurrect it
  - Every path that surfaces or hides the control panel reports that state explicitly: openers (tray, app menu, deep links, `activate`, second instance, first show) go through `windowManager.showControlPanel()`, hiding through `hideControlPanelToTray()`
  - `showControlPanel()` reports the Dock before restoring, showing and focusing the window: on an active app `dock.show()` activates the Dock and then re-activates the app, which macOS does not honour, so a window surfaced first is left behind the previously frontmost app
  - `showControlPanel()` calls `show()` even on an open panel, since on macOS that activates the app and `focus()` does not; openers that send the user to another app (meeting-prompt Join, the meeting hotkey, Upcoming Meetings' Join & transcribe) pass `{ activate: false }`, so an open panel updates behind the meeting instead of covering it. A hidden panel is still shown
  - `app.dock.show()`/`hide()` run only when the requested state differs from `app.dock.isVisible()`, so reopening an already open panel never triggers that Dock hand-off
  - Never derive that state from the window's `show`/`hide` events: on macOS those are occlusion events, so they also fire when the panel is merely covered by another window, minimized, or on another Space, and the icon flickers as the user switches windows
  - Decision logic lives in `dockPolicy.js` (pure, unit-tested in `test/helpers/dockPolicy.test.js`)
- **dragManager.js**: Window dragging functionality
- **environment.js**: Environment variables, `.env` persistence, and the encrypted self-hosted API-key store (see Settings Storage)
- **hotkeyManager.js**: Global hotkey registration and management
  - Named hotkey slots: `dictation`, `voiceAgent` (voice assistant — dictation routed to the assistant panel), `translation`, `meeting`
  - Handles platform-specific defaults (GLOBE on macOS, Control+Super on Windows/Linux)
  - Auto-fallback to F8/F9 if default hotkey is unavailable
  - Notifies renderer via IPC when hotkey registration fails
  - Integrates with GnomeShortcutManager for GNOME Wayland support
  - Integrates with HyprlandShortcutManager for Hyprland Wayland support
  - Integrates with KDEShortcutManager for KDE Wayland support
- **gnomeShortcut.js**: GNOME Wayland global shortcut integration
  - Uses D-Bus service to receive hotkey toggle commands
  - Registers shortcuts via gsettings (visible in GNOME Settings → Keyboard → Shortcuts)
  - Converts Electron hotkey format to GNOME keysym format
  - Only active on Linux + Wayland + GNOME desktop
  - D-Bus transport: `@homebridge/dbus-native` (pure JavaScript, no native addons)
- **hyprlandShortcut.js**: Hyprland Wayland global shortcut integration
  - Uses D-Bus service to receive hotkey toggle commands (same `com.openwhispr.App` service)
  - Registers shortcuts via `hyprctl keyword bind` (runtime keybinding)
  - Converts Electron hotkey format to Hyprland bind format (`MODS, key`)
  - Only active on Linux + Wayland + Hyprland (detected via `HYPRLAND_INSTANCE_SIGNATURE`)
  - D-Bus transport: `@homebridge/dbus-native` (pure JavaScript, no native addons)
- **kdeShortcut.js**: KDE Wayland global shortcut integration
  - Uses D-Bus to communicate with KGlobalAccel for global hotkey registration
  - Registers hotkeys via `setShortcut`/`doRegister` D-Bus calls on the KGlobalAccel interface
  - Listens for `globalShortcutPressed` signals to trigger callbacks
  - Converts Electron hotkey format to Qt key codes
  - Only active on Linux + KDE desktop (detected via `XDG_CURRENT_DESKTOP`)
  - D-Bus transport: `@homebridge/dbus-native` (pure JavaScript, no native addons)
- **autoStart.js**: Single entry point for launch at login, used by `ipcHandlers.js` and `main.js`
  - Dispatches to `setLoginItemSettings()` on macOS/Windows and to `linuxAutostart.js` on Linux
  - `getAutoStartState()` returns `{ enabled, requiresApproval }`; `requiresApproval` is macOS-only and means SMAppService registered the item but the user has not allowed it under System Settings → General → Login Items yet
  - `wasLaunchedAtLoginHidden()` decides whether this launch should go straight to the tray
  - `syncAutoStartEntry()` runs from `initializeCoreManagers()` and repairs entries written by older builds
  - Decision logic lives in `autoStartPolicy.js` (pure, unit-tested in `test/helpers/autoStartPolicy.test.js`)
- **autoStartPolicy.js**: Electron-free launch-at-login and relaunch decisions
  - `HIDDEN_LAUNCH_FLAG` (`--hidden`) is how a login launch tells the app to start in the tray. Windows has no native equivalent (`openAsHidden` is macOS-only and a no-op on macOS 13+), so the flag rides on the login item's `args`; Linux puts it on the autostart entry's `Exec`; macOS uses `wasOpenedAtLogin` instead
  - On Windows, read the state from `executableWillLaunchAtLogin`, never from `openAtLogin`: `openAtLogin` only compares the `Run` value against the current executable and args and ignores the `StartupApproved` key that Task Manager and Settings write when a user disables a startup app
  - Reads and writes must pass identical `args`, or `openAtLogin` always reports false
  - `getRelaunchOptions()` and `getRelaunchWaiter()` shape the `relaunch-app` IPC that follows `cleanup-app` (Reset app data): the relaunch drops `--hidden` and any cold-start deep link, and an AppImage is started again from its on-disk file (`$APPIMAGE`) by a detached waiter, since it runs from a FUSE mount that disappears when the app exits. The handler in `ipcHandlers.js` only quits under `npm run dev`
- **linuxAutostart.js**: Launch-at-login on Linux via an XDG autostart entry
  - `app.setLoginItemSettings()` is a no-op on Linux, so the entry is written directly to `$XDG_CONFIG_HOME/autostart/open-whispr.desktop`, matching the executable name electron-builder packages under
  - `Exec` resolves from `$APPIMAGE` first: `process.execPath` is the ephemeral AppImage FUSE mount
  - `isAutostartEnabled()` honors `X-GNOME-Autostart-enabled=false` and `Hidden=true`, which GNOME Tweaks and KDE's autostart editor write in place instead of deleting the file
  - `Exec` carries `--hidden` (see `autoStartPolicy.js`), and `syncAutostartEntry()` compares against the full value including that flag — comparing against the bare path would make every launch look stale
  - `syncAutostartEntry()` runs from `autoStart.syncAutoStartEntry()` in `initializeCoreManagers()` and re-points a stale `Exec` after the executable moves (renamed or auto-updated AppImage); it never re-enables an entry the user disabled, and no-ops in development
  - Unit-tested in `test/helpers/linuxAutostart.test.js`
- **ipcHandlers.js**: Centralized IPC handler registration
- **windowsKeyManager.js**: Windows Push-to-Talk support with native key listener
  - Spawns native `windows-key-listener.exe` binary for low-level keyboard hooks
  - Supports compound hotkeys (e.g., `Ctrl+Shift+F11`, `CommandOrControl+Space`)
  - Emits `key-down` and `key-up` events for push-to-talk functionality
  - Graceful fallback if binary unavailable
- **meetingDetectionEngine.js**: Orchestrates meeting detection from all sources
  - Gates notifications during recording (tap-to-talk and push-to-talk)
  - Post-recording cooldown (2.5s) before showing queued notifications
  - Priority-based coalescing (process > audio) — one notification, not three
  - Both detectors start off and only run once the renderer has synced its saved notification preferences (`sync-notification-preferences`); they stop when meeting prompts are disabled and restart when re-enabled. The derivation lives in `meetingDetectionPreferencePolicy.js` (pure, unit-tested in `test/helpers/meetingDetectionPreferencePolicy.test.js`); `ipcHandlers.js` is a thin adapter over it
- **meetingProcessDetector.js**: Detects running meeting apps
  - macOS: Event-driven via `systemPreferences.subscribeWorkspaceNotification` (zero CPU)
  - Windows/Linux: Shared `processListCache` polling (30s interval)
  - Scans are start-generation guarded: a process-list read that completes after `stop()` or a newer `start()` is discarded, since the detector is now stopped and started at runtime (notification toggles, auto-end sessions)
- **audioActivityDetector.js**: Detects microphone usage for unscheduled meetings
  - macOS: Event-driven via `macos-mic-listener` binary (CoreAudio process objects; aggregate device activity prompts only while a known meeting app is running)
  - Windows: Event-driven via `windows-mic-listener.exe` (WASAPI sessions, self-PID exclusion)
  - Linux: Event-driven via `pactl subscribe` (PulseAudio source-output events)
  - Windows/Linux: Graceful fallback to polling if the native approach fails; macOS has no safe polling signal and respawns the listener with backoff instead
- **processListCache.js**: Shared singleton process list cache (5s TTL, `ps-list` npm)
- **meetingEchoLeakDetector.js**: Audio-layer echo analysis for meeting recordings — correlates each mic chunk against the recent system-audio tap (lag search 0–500 ms in 5 ms steps) and classifies it `clean_local` / `suspected_render_bleed` / `double_talk`; drives chunk muting and per-segment suppression flags. PCM-driven tests in `test/helpers/meetingEchoLeakDetector.test.js`
- **meetingMicGate.js**: Pure RMS/peak chunk stats + the meeting mic gate verdict (`send` / `zero` / `skip`) with the exported silence and bleed thresholds; `ipcHandlers.js` (`dispatchMeetingAudioBuffer`, `transcribeLocalMeetingChunk`) only applies the verdict. Unit-tested in `test/helpers/meetingMicGate.test.js`
- **meetingMicHoldback.js**: Pure holdback/retract policy for risky mic finals — pending-final partition, retract window, risky-profile classifier, text-layer duplicate check, racing-retract candidate selection, pending-overlap partition. `ipcHandlers.js` keeps thin adapters over its closure state (`meetingDiarizationSegments`, `meetingPendingMicFinals`, `hasNearbyTranscriptMatch`). Unit-tested in `test/helpers/meetingMicHoldback.test.js`
- **appleCalendarManager.js**: Apple Calendar (EventKit) via the `macos-calendar-listener` Swift helper — macOS only, snapshot-push over stdout, no tokens ("connected" = `apple_calendars` has rows). The only calendar source: Calendar.app already aggregates iCloud, Google, Exchange and Outlook accounts, so no calendar OAuth or network sync exists
- **calendarReminderScheduler.js**: Meeting reminder scheduling over the `calendar_events` table
- **menuManager.js**: Application menu management
- **toneAppCategories.js**: Tone & Style's app classifier (pure, `test/helpers/toneAppCategories.test.js`): an app identity, window title and page host map to `personal`, `work`, `email` or `other` (see Tone & Style)
- **tray.js**: System tray icon and menu
- **whisper.js**: Local whisper.cpp integration and model management
- **parakeet.js**: NVIDIA Parakeet model management via sherpa-onnx
- **parakeetServer.js**: sherpa-onnx CLI wrapper for transcription
- **qdrantManager.js**: Qdrant vector DB sidecar process lifecycle (spawn, health check, shutdown)
- **semanticSearchLifecycle.js**: Single owner of the semantic search resources — starts Qdrant and the embedding model on demand, drains the SQLite change journal, and releases both after 5 minutes idle
- **localEmbeddings.js**: Local text embedding via ONNX Runtime + all-MiniLM-L6-v2 (384-dim vectors)
- **vectorIndex.js**: Qdrant collection management — upsert, delete, search
- **windowConfig.js**: Centralized window configuration
- **plasmaWorkAreas.js**: Per-monitor work areas on KDE Plasma. On X11 and XWayland, Chromium clips only the primary display with the single root `_NET_WORKAREA`, which KWin builds from every monitor's panels at once (#1110). This asks plasmashell over D-Bus (`evaluateScript`) for each screen's always-visible panels and rebuilds each display's `workArea` for the dictation pill, its companion windows and dragging. On X11, Qt reports a screen's origin in device pixels and only its size scaled, so those origins are divided by the display scale before matching. It refreshes on display events and each time a dictation shows the pill, retrying after 1, 5 and 15 s when plasmashell isn't ready; a display event starts those retries over. An auto-placed pill re-anchors when the result changes; a dragged one stays put. With a single display, or outside Linux + KDE, Chromium's work area is used as is
- **windowManager.js**: Window creation and lifecycle management
- **selfHostedTranscription.js**: Resolves whether dictation runs on the user's OpenAI-compatible speech-to-text server (`transcriptionMode` + `remoteTranscriptionUrl`) and which model to name; `transcriptionRoute.ts` is the routing source of truth for dictation, retry and upload
- **selfHostedFileTranscription.js**: Upload transcription against the same kind of server. Asks for `verbose_json` segments first (so diarization can place speakers), falls back to plain `json` for servers that reject it and remembers that per session; files over the upload cap are split with FFmpeg and stitched by offset
- **selfHostedMeetingTranscriber.js**: Meeting transcription over a self-hosted server — the chunk queue described in section 18
- **diarizationRoute.ts / selfHostedDiarization.js**: Where meetings and uploads diarize — the on-device sherpa-onnx diarizer or the user's server (`POST {base}/audio/diarizations`, NeMo-Speech.cpp contract: WAV + `mode` in, `{segments: [{start, end, speaker}]}` out). Picks `offline` (full attention) up to 6 minutes and `streaming` beyond, and relabels server speakers to `speaker_N` so cluster capping, transcript merging and speaker-profile naming are unchanged. Self-hosted fails closed (no local fallback); a failed request yields no speakers, never a failed transcript. `ipcHandlers.js` holds the route (`set-diarization-endpoint`, synced from the store) and dispatches through `_diarizeWav`
- **providerConnectionTest.js**: Settings/onboarding "Test connection" for self-hosted endpoints (`/models` probe with candidate base URLs); returns an `errorCode` translated via `onboarding.rehaul.provider.errors.*`. Mirrors the renderer's URL rules, including "plain HTTP only on private hosts"
- **toolCallingPolicy.js**: Whether chat / voice-assistant requests carry tool schemas (`auto` | `on` | `off` per scope; `on` by default for self-hosted, `auto` on-device, sized by the model id)
- **searxngSearch.js**: The assistant's `web_search` tool, backed by the user's SearXNG instance (section 20)
- **markdownMirror.js / noteFilesSync.js / noteExportFormat.js / noteImportFormat.js**: Obsidian-friendly Markdown export of notes, transcripts and dictations, plus import of notes another computer exported into the same folder (section 19)
- **cliBridge.js**: Loopback HTTP server on ports 8200–8219, bearer-token auth (token at `~/.openwhispr/cli-bridge.json`), 127.0.0.1-only. Used by the CLI to talk to a running desktop app. `POST /v1/transcribe` takes a file **path** (never audio) and runs the user's downloaded local model through `IPCHandlers.transcribeLocalFile`, approving the path with `approveAudioPath` first; `GET /v1/transcribe/models` lists local models with download state and the app's default (`localTranscriptionModels.js`, read from the `.env` pre-warm values).
- **postMigrationDetector.js**: Detects users returning from the pre-Gizmo bundle ID via a `.bundle-migrated` sentinel in userData; consumed by `ipcHandlers.js` to drive the `PostMigrationOnboarding` modal
- **permissionGuideManager.js**: macOS onboarding permission overlay — a frameless always-on-top window anchored to the bottom of the System Settings window (placement in `permissionGuidePlacement.js`, pure), polled one read at a time via `settingsWindowState.js` (exec of `macos-window-bounds`). Steps aside for authorization prompts, other apps and a dialog on another Space; closes when the dialog closes; never subscribes to the control panel's `hide` (occlusion fires it), so `hideControlPanelToTray()` closes it explicitly. Renderer side: `permissionGuideController.ts` (pure state machine, unit-tested) + `usePermissionGuide.ts`
- **templatePrompts.js**: Pure compiler from a note template or action to the system prompt the model receives (see Note Templates and Actions). Shared by `actionProcessingStore.ts`, the note chat, and the live canary's note probe

### React Components (src/components/)

- **App.jsx**: Main dictation interface with recording states
- **ControlPanel.tsx**: Settings, history, model management UI
- **OnboardingFlow.tsx**: First-time setup wizard over a versioned, route-based step machine (`src/components/onboarding/flow.ts`; session persisted in `onboardingSessionV2`, `ONBOARDING_FLOW_VERSION` bumped whenever the route changes shape). No sign-in: permissions → languages → use cases → dictation hotkey → setup choice, then either the **local** pair (download on-device dictation and assistant models) or the **self-hosted** pair (endpoint URL, optional key, connection test, model pick), then the practice steps (dictation demo, notes, assistant hotkey, assistant demo). Step components live in `src/components/onboarding/`
- **PostMigrationOnboarding.tsx**: One-time modal for users returning from the pre-Gizmo bundle ID; reuses `PermissionsSection` to walk through re-granting Microphone, Accessibility, and System Audio. Triggered by `postMigrationDetector.js` (see Helper Modules)
- **SettingsPage.tsx**: Comprehensive settings interface
- **WhisperModelPicker.tsx**: Model selection and download UI
- **ui/**: Reusable UI components (buttons, cards, inputs, etc.)
- **ui/RichTextEditor.tsx**: Tiptap note editor. Note bodies (`content`, `enhanced_content`) are stored as Markdown via tiptap-markdown (`html: false`). NoteBottomBar publishes its height in `--bottom-overlay-height`; the editor reads it for its bottom scroll margin and threshold, its bottom padding and the line menu's flip padding, so the caret and the menu stay clear of the bar
  - `RichTextEditorExtensions.ts` holds the extension list (`RichTextEditor` adds the mention extension in front of it); order matters: at equal priority, later extensions' keymaps and clipboard props run first
  - `RichTextEditorTable.ts` keeps every table to what a GFM pipe table can store: header first row, one single-line paragraph per cell, no merged cells, no alignment or column widths. Pasted cells are flattened while parsing, a normalizer fixes what commands and pastes leave behind, and the table serializer escapes `|` in cells. Tests: `test/components/richTextEditor.test.js` (happy-dom)
  - Floating menus: `RichTextEditorFormatMenu.tsx` shows one formatting toolbar (marks, text style, lists, quote, insert table) above selected text (Tiptap `BubbleMenu`) and below the caret on an empty top-level line, flipping above when there's no room (`FloatingMenu`); `RichTextEditorTableMenu.tsx` is the table's `⋯` menu. They share `RichTextEditorMenus.ts`: a menu hides when focus leaves it, so dropdowns portal into the menu element itself, never into the editor's scroller (EditorContent moves the scroller's children when a note closes); `useHideOnFocusLeave` hides a menu when focus leaves from inside it or after a click on it, which Tiptap misses. The menus detach their element without unmounting it, so buttons use a native `title` rather than `<Tooltip>`, and a dropdown inside a menu is controlled and closed from the menu's `onHide` — otherwise it stays open over a scroll-locked page when the menu hides. Keep menu props stable, or each render dispatches an `updateOptions` transaction. The line menu is placed again in the frame after a transaction that scrolled the caret into view, since ProseMirror scrolls after the menu measured

### React Hooks (src/hooks/)

- **useAudioRecording.js**: MediaRecorder API wrapper with error handling
- **useAssistantPanel.js**: Assistant panel lifecycle (open/close choreography, thinking flourish, footer phases, pending voice commands, conversation session boundaries)
- **useLiveTranscriptPanel.js**: Live transcript panel lifecycle (entrance choreography, buffered text scheduler, measure-then-reveal resize pipeline, preview IPC wiring)
- **useMainWindowSizeOwner.js**: Single owner of the main window size ladder (panel > menu > toast > pill > base) and the dictation-error pill handoff
- **useWindowResizeCompensation.js**: Masks split native setBounds frames via CSS-variable counter-translation
- **useMainProcessNotifications.tsx**: Main-process notifications (hotkey fallback, GPU fallback, learned corrections) as toasts
- **useClipboard.ts**: Clipboard operations hook
- **useDialogs.ts**: Electron dialog integration
- **useHotkey.js**: Hotkey state management
- **useLocalStorage.ts**: Type-safe localStorage wrapper
- **usePermissions.ts**: System permission checks and settings access
  - `openMicPrivacySettings()`: Opens OS microphone privacy settings
  - `openSoundInputSettings()`: Opens OS sound input device settings
  - `openAccessibilitySettings()`: Opens OS accessibility settings (macOS only)
- **useSettings.ts**: Application settings management
- **useWhisper.ts**: Whisper binary availability check

### Services

- **ReasoningService.ts**: AI processing for agent-addressed commands
  - Detects when user addresses their named agent and removes the agent name from final output
  - Provider implementations live in a registry at `src/services/ai/inferenceProviders/index.ts` with exactly two providers, each implementing the `InferenceProvider` interface from `types.ts`: `local` (llama.cpp via `localReasoningBridge.js`) and `lan` (the user's OpenAI-compatible server, `/chat/completions` with SSE streaming)
  - Per-scope LLM config: 5 scopes (`dictationCleanup`, `dictationAgent`, `noteFormatting`, `chatIntelligence`, `dictationTranslation`) defined in `src/config/inferenceScopes.ts`. Each scope has a mode (`local` | `self-hosted`), model, `*RemoteUrl`, optional key, thinking toggle, and — for the chat/assistant scopes — tool-calling and "accepts images" settings
  - `selectResolvedLLMConfig(state, scope)` in `settingsStore.ts` resolves provider/model per scope with fallback chains (`noteFormatting` falls back to `dictationCleanup`)

### whisper.cpp Integration

- **whisper.js**: Native binary wrapper for local transcription
  - Bundled binaries in `resources/bin/whisper-cpp-{platform}-{arch}`
  - Falls back to system installation (`brew install whisper-cpp`)
  - GGML model downloads from HuggingFace
  - Models stored in `~/.cache/openwhispr/whisper-models/`

### NVIDIA Parakeet Integration (via sherpa-onnx)

- **parakeet.js**: Model management for NVIDIA Parakeet ASR models
  - Uses sherpa-onnx runtime for cross-platform ONNX inference
  - Bundled binaries in `resources/bin/sherpa-onnx-{platform}-{arch}`
  - Windows: the bundled ONNX Runtime ships as `ow-onnxrt.dll`, not `onnxruntime.dll`. `scripts/download-sherpa-onnx.js` renames it and rewrites the import tables of every sherpa image (`scripts/lib/pe-imports.js`) because Windows 11 ships an older `onnxruntime.dll` in System32 and some loader configurations resolve the bare name to that copy (#2054). `afterPack.js` fails the Windows build if `onnxruntime.dll` is present or `ow-onnxrt.dll` is missing
  - Uses the upstream `-no-tts` archives and bundles only the three executables plus ONNX Runtime. The TTS builds statically link espeak-ng (GPL-3.0) into `sherpa-onnx-c-api`, and nothing in the app loads the sherpa C/C++ API libraries, so they are not shipped
  - INT8 quantized models for efficient CPU inference
  - Models stored in `~/.cache/openwhispr/parakeet-models/`
  - Server pre-warming on startup when `LOCAL_TRANSCRIPTION_PROVIDER=nvidia` is set
  - Provider preference persisted to `.env` via `saveAllKeysToEnvFile()` on server start/stop

- **Available Models**:
  - `parakeet-tdt-0.6b-v3`: Multilingual (25 languages), ~680MB
  - `parakeet-unified-en-0.6b`: English-only, ~631MB, state-of-the-art EN accuracy (5.91% avg WER on Open ASR Leaderboard)
  - `nemotron-speech-streaming-en-0.6b`: English-only, ~632MB, cache-aware streaming FastConformer (`"runtime": "online"` in the registry)
  - `nemotron-3.5-asr-streaming-0.6b`: Multilingual (15 transcription-ready languages, auto detection), ~650MB, cache-aware streaming FastConformer (`"runtime": "online"`)
  - `cohere-transcribe-03-2026`: Multilingual (14 languages, NO auto detection — one language per server start), ~1.7GB download / ~2.7GB on disk, Conformer encoder-decoder (`"modelType": "cohere-transcribe"`), most accurate local model (5.42% avg WER). Exposed as the `"cohere"` local provider in settings/UI but served by the same ParakeetManager/sherpa-onnx offline WS server; the dictation language is part of the server identity, so changing it restarts the server. Segments long audio at 30s (model max ~35s)

- **Runtimes**: Models are `offline` (default) or `online` per their registry `runtime` field. Offline models use the bundled `sherpa-onnx-ws-{platform}-{arch}` (offline websocket server); online models use `sherpa-onnx-online-ws-{platform}-{arch}` (online websocket server). Both are downloaded by `scripts/download-sherpa-onnx.js`. Partial/final JSON results are merged by `parakeetWsResult.js`.

- **Streaming Commit (online models)**: For online-runtime models, dictation streams worklet PCM to a persistent websocket stream during capture (regardless of the preview toggle) and commits the flushed text at stop as the final transcript — no second decode of the recording. The stop flush is truncation-aware (`finish()` extends its deadline while results keep arriving and flags `truncated`); anything but a clean flush falls back to the record-then-transcribe path (`transcribe-local-parakeet`), which for online models decodes the whole recording over a single stream (no 15s segmentation; segments only bound memory for very long files).

- **Live Transcription Preview**: When the preview toggle is on and an online-runtime model is selected, the preview shares the streaming-commit websocket: partial results update the preview window live (replacing text via `showTranscriptionPreview`). Offline models keep the 1.5s buffered-chunk path (appending via `appendTranscriptionPreview`). If the stream can't start or dies mid-dictation, the preview falls back to the chunked path and the final transcript falls back to the full decode. Tests: `test/helpers/parakeetOnlineStream.test.js` (mock websocket server).

- **Download URLs**: Models from sherpa-onnx ASR models release on GitHub

### Local Semantic Search (Qdrant + MiniLM)

Offline semantic search that finds notes by meaning, not just keywords. Used by the AI agent's `search_notes` tool. Its resources are lazy (#2143): Qdrant and the embedding model start on the first semantic search (or the first vector write while the index is active), the embedding model downloads on that first activation if missing, and everything is released after 5 minutes idle. While asleep, keyword FTS5 serves searches and note changes are journaled in SQLite.

**Architecture**:

- **Qdrant sidecar**: Rust binary spawned as child process (`qdrantManager.js`), port 6333–6350
- **Embedding model**: `all-MiniLM-L6-v2` via ONNX Runtime (`localEmbeddings.js`), 384-dim vectors
- **Vector index**: Qdrant collection management (`vectorIndex.js`), cosine distance
- **Lifecycle owner**: `semanticSearchLifecycle.js` — the only caller that starts or stops Qdrant, the embedding model and the collection
- **Hybrid search**: FTS5 + Qdrant in parallel → Reciprocal Rank Fusion (K=60) with 0.3 cosine score threshold

**Pipeline**:

1. App launches → nothing starts. The first `db-semantic-search-notes` call activates the lifecycle: embedding model downloaded if missing (~22MB) → Qdrant binary starts → collection ensured → the journal is drained. A cold search does not wait: it answers with FTS5 results while activation runs in the background. An existing collection serves searches while the journal drains; a newly created one waits until that activation's drain finishes. A journal row whose upsert keeps failing is parked after three failed attempts, so one bad note never blocks the rest of the index
2. Note create/update/delete → SQLite write → triggers journal the note id in `pending_vector_changes` → `IPCHandlers.notifyVectorChanges()` wakes an already-active index to drain the journal; an idle index drains it on its next activation
3. Agent searches → `db-semantic-search-notes` IPC → parallel FTS5 + vector search → RRF merge → ranked results
4. 5 minutes without a search or write → Qdrant is stopped and the embedding session released; FTS5 keeps serving

**Search fallback chain** (in `searchNotesTool.ts`): local semantic → FTS5 keyword

**Storage**:

- Qdrant data: `~/.cache/openwhispr/qdrant-data/` (`qdrant-data-dev/` in development)
- Qdrant binary: `resources/bin/qdrant-{platform}-{arch}` (bundled — downloaded during `prebuild` / `predev:main`)
- Embedding model: `~/.cache/openwhispr/embedding-models/all-MiniLM-L6-v2/` (downloaded on the first semantic search)
- Change journal: `pending_vector_changes` table in the notes SQLite database, maintained by triggers

**Dependencies**: `@qdrant/js-client-rest`, `onnxruntime-node`

**Dev setup**: The Qdrant binary downloads automatically via `predev`/`prestart`. The embedding model downloads on the first semantic search. To manually download: `npm run download:qdrant` and `npm run download:embedding-model`.

### Build Scripts (scripts/)

- **download-whisper-cpp.js**: Downloads whisper.cpp binaries from GitHub releases
- **download-llama-server.js**: Downloads llama.cpp server for local LLM inference
- **download-nircmd.js**: Downloads nircmd.exe for Windows clipboard operations
- **download-windows-key-listener.js**: Downloads prebuilt Windows key listener binary
- **download-windows-mic-listener.js**: Downloads prebuilt Windows mic listener binary
- **download-sherpa-onnx.js**: Downloads sherpa-onnx binaries for Parakeet support
- **download-qdrant.js**: Downloads Qdrant vector DB binary for local semantic search
- **download-minilm.js**: Downloads all-MiniLM-L6-v2 ONNX model + tokenizer for local embeddings
- **download-brand-fonts.js**: Fetches the licensed Yowza font files from the private `OpenWhispr/brand-assets` release into the git-ignored `src/assets/fonts/yowza/`. Runs in `predev:main` and every `prebuild*` chain; skips (Noto Sans fallback) without repo access, fails only when `BRAND_FONTS_REQUIRED=1` (release CI)
- **sync-nucleo-icons.js**: Regenerates `src/components/icons/` from `nucleo-map.json` using the local Nucleo install (`~/.nucleo/skills`); only the icons the app uses are vendored
- **build-globe-listener.js**: Compiles macOS Globe key listener from Swift source
- **build-macos-mic-listener.js**: Compiles macOS mic listener from Swift source
- **build-macos-window-bounds.js**: Compiles the System Settings window reporter from Swift source
- **build-windows-key-listener.js**: Compiles the Windows key listener (MSVC, MinGW or clang) whenever `compile:native` runs on a Windows host, downloading the prebuilt binary when no compiler works; skips a binary newer than its source
- **run-electron.js**: Development script to launch Electron with proper environment
- **lib/download-utils.js**: Shared utilities for downloading and extracting files
  - `fetchLatestRelease(repo, options)`: Fetches latest release from GitHub API
  - `downloadFile(url, dest)`: Downloads file with progress and retry logic
  - `extractZip(zipPath, destDir)`: Cross-platform zip extraction
  - `parseArgs()`: Parses CLI arguments for platform/arch targeting
  - Supports `GITHUB_TOKEN` for authenticated requests (higher rate limits)

## Key Implementation Details

### 1. FFmpeg Integration

FFmpeg is bundled with the app and doesn't require system installation:

```javascript
// FFmpeg is unpacked from ASAR to app.asar.unpacked/node_modules/ffmpeg-static/
```

### 2. Audio Recording Flow

1. User presses hotkey → MediaRecorder starts
2. Audio chunks collected in array
3. User presses hotkey again → Recording stops
4. Blob created from chunks → Converted to ArrayBuffer
5. Sent via IPC
6. Main process writes to temporary file
7. whisper.cpp processes file → Result sent back
8. Temporary file deleted

For offline local engines (whisper.cpp, Parakeet/Orukeet, Cohere) the renderer also keeps a 16 kHz mono PCM copy of the same stream from the moment the mic opens (`pcmTap.js`, pre-roll included, capped at 4 minutes) and sends that WAV instead of the WebM, so no FFmpeg decode runs after stop; the WebM still goes to history and remains the upload for self-hosted servers and long recordings.

### 3. Local Whisper Models (GGML format)

Models stored in `~/.cache/openwhispr/whisper-models/`:

- tiny: ~75MB (fastest, lowest quality)
- base: ~142MB (recommended balance)
- small: ~466MB (better quality)
- medium: ~1.5GB (high quality)
- large: ~3GB (best quality)
- turbo: ~1.6GB (fast with good quality)

### 4. Database Schema

```sql
CREATE TABLE transcriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
  original_text TEXT NOT NULL,
  processed_text TEXT,
  is_processed BOOLEAN DEFAULT 0,
  processing_method TEXT DEFAULT 'none',
  agent_name TEXT,
  error TEXT
);
```

### 5. Settings Storage

Settings live in a zustand store (`src/stores/settingsStore.ts`) persisted to localStorage. Notable keys:

- `transcriptionMode` / `meetingTranscriptionMode` / `uploadTranscriptionMode`: `local` | `self-hosted` for dictation, meetings and uploads
- `remoteTranscriptionUrl`, `meetingRemoteTranscriptionUrl`, `uploadRemoteTranscriptionUrl` (+ matching `*Model`): self-hosted speech-to-text endpoints
- `whisperModel`, `useLocalWhisper`: on-device Whisper selection
- `cleanupMode` / `cleanupRemoteUrl` / `cleanupModel`, and the same trio for `dictationAgent*`, `noteFormatting*`, `chatAgent*`, `translation*`: per-scope inference (see `inferenceScopes.ts`)
- `dictationAgentToolCalling` / `chatAgentToolCalling`, `dictationAgentAcceptsImages` / `chatAgentAcceptsImages`: self-hosted capabilities the server cannot advertise
- `webSearchEnabled`, `webSearchUrl`: SearXNG web search
- `diarizationMode` (`local` | `self-hosted`), `diarizationRemoteUrl`: speaker detection engine for meetings and uploads (one setting, shown under both tabs)
- `audioRetentionDays` / `dataRetentionEnabled` (Settings → Privacy) also govern meeting audio. Every meeting records raw system audio and raw mic for its whole length. At stop, speaker detection runs on the system capture only when it is audible for at least min(10 s, 25% of the session) (`isCallAudio` / `measurePcmAudio` in `meetingDiarizationInput.js`); otherwise it runs on the mic, since a speakerphone call puts both sides on the mic and its system channel holds only notification chimes. While history is on and audio retention isn't Disabled, both tracks are kept as `userData/meeting-audio/note-<id>-<start>-<source>.mp3` (the track detection ran on) and `…-<source>-alt.mp3` (the other one, padded or trimmed to the same start; `meetingAudioArchive.js`, `_keepsMeetingAudio` in `ipcHandlers.js`). Older builds kept one unsuffixed file. The retention sweep, storage usage and Clear all audio cover both, and they are deleted with their note via the database's note-change listeners. Otherwise the raw captures are temp files deleted once diarization finishes or is skipped. A finished meeting with kept audio shows Re-detect in its transcript (`RedetectSpeakersBar`): `rediarize-meeting-note` diarizes the main track again with the given head count, falling back to the `-alt` track when the main one finds no speakers. It keeps hand-assigned (locked) lines, replaces the note's speaker mappings and embeddings (`replaceNoteSpeakers`) and returns the rows for the renderer to save. Notes recorded in several sessions are refused (`MULTIPLE_SESSIONS`)
- `noteFilesEnabled`, `noteFilesPath`, `noteFilesBaseTag`, `noteFilesExportDictations`: Obsidian export
- `customDictionary`: JSON array of words/phrases for improved transcription accuracy
- `userName`: the note owner's name (Settings → General → Profile). Note generation labels the mic track with it instead of "You" and states it in the Meeting Context block, so the model never takes the owner's identity from a name heard in the conversation
- `voiceAgentScreenContext`, `voiceAgentKey`: voice assistant options
- `keepLocalModelLoaded`: Keeps the shared llama-server loaded instead of unloading it after 5 idle minutes (#1207; default off). Synced to main with `sync-startup-preferences`; `LlamaServerManager.setKeepResident` acts only on a change, since every window resyncs on load
- `toneStyleEnabled`, `toneStyles`: whether Tone & Style is on (the setup dialog's Finish, or Settings' Tones & voices switch) and the tone picked per kind of app (JSON, normalized by `normalizeToneStyles`)

Secrets are only the optional bearer keys for self-hosted servers — 6 in total: `CUSTOM_TRANSCRIPTION_API_KEY`, `CUSTOM_CLEANUP_API_KEY`, and the per-scope keys in `src/config/secretKeys.js` (`SCOPE_API_KEYS`; `preload.js` mirrors them in `SCOPE_KEY_BRIDGES`). They are AES-256-GCM encrypted per key under `userData/secure-keys/` with a master key held in the OS keychain via `@napi-rs/keyring` (`secretCrypto.js`; Electron `safeStorage` is the fallback), loaded into `process.env` at startup by `EnvironmentManager.init()`. Renderer reads them via IPC (`get-*-key`) and writes via debounced IPC (`save-*-key`). Keys for providers this fork removed (`RETIRED_SECRET_KEYS`) are deleted at startup.

Non-secret env vars persisted to `.env` (via `saveAllKeysToEnvFile()`):

- `LOCAL_TRANSCRIPTION_PROVIDER`: Transcription engine (`nvidia` for Parakeet)
- `PARAKEET_MODEL`: Selected Parakeet model name (e.g., `parakeet-tdt-0.6b-v3`)

### 6. Language Support

60 languages supported, defined in `src/config/languageRegistry.json` and read through
`src/utils/languageSupport.ts`:

- Each entry has a two-letter code, label, flag, and per-engine support flags
  (`whisper`, `parakeet`) — 59 Whisper, 26 Parakeet. The registry still carries an
  unused `assemblyai` flag from upstream
- "auto" is a 61st entry for automatic detection
- Passed to whisper.cpp via -l parameter

### 7. Agent Naming System

- User names their agent during onboarding (step 6/8)
- Name stored in localStorage and database
- ReasoningService detects "Hey [AgentName]" patterns
- Standalone wake-word commands stream into the assistant panel (the address is stripped first, `stripAgentAddress`); a highlighted selection is edited in place by the dictation agent
- Runs on either inference provider:
  - **Local**: GGUF models via llama.cpp (Qwen, Gemma, Llama, Mistral, GPT-OSS, LiquidAI), defined in `src/models/modelRegistryData.json`
  - **Self-hosted (`lan`)**: any model the user's OpenAI-compatible server lists at `/models` (vLLM, llama.cpp server, Ollama, LocalAI, …)

### 8. Model Registry Architecture

All on-device model definitions are centralized in `src/models/modelRegistryData.json` as the single source of truth. Self-hosted models are not in the registry; they are listed live from the server's `/models`.

```json
{
  "whisperModels": {...},     // whisper.cpp GGML models
  "parakeetModels": {...},    // sherpa-onnx models (Parakeet, Nemotron, Cohere, Orukeet)
  "diarizationModels": {...}, // speaker segmentation + embedding models
  "localProviders": [...]     // GGUF models with download URLs
}
```

**Key files:**

- `src/models/modelRegistryData.json` - Single source of truth for all on-device models
- `src/models/ModelRegistry.ts` - TypeScript wrapper with helper methods
- `src/helpers/modelManagerBridge.js` - Handles local model downloads
- `src/services/ai/selfHostedDefaultModel.ts` - Picks a default from a self-hosted server's `/models` list when the scope has no model yet

**Local model features:**

- Each model has `hfRepo` for direct HuggingFace download URLs
- Chat formatting comes from the GGUF's embedded template (llama-server runs with `--jinja`); the registry carries no prompt templates
- Download URLs constructed as: `{baseUrl}/{hfRepo}/resolve/main/{fileName}`

### 9. Self-Hosted (LAN) Endpoints

Every self-hosted setting takes an OpenAI-compatible base URL, e.g. `https://whisper.lan/v1` for speech-to-text or `https://llm.lan/v1` for chat, and an optional bearer key. Typical servers: vLLM (chat or ASR models such as Qwen3-ASR, often exposed under the `whisper-1` alias), faster-whisper-server / whisper.cpp server, llama.cpp server, Ollama, LocalAI.

- **Transcription**: `POST {base}/audio/transcriptions` (multipart, `model`, optional `language`/`prompt`). Dictation, meetings and uploads each have their own URL + model so they can point at different servers. Uploaded files over 25 MiB are split before sending
- **Inference**: `POST {base}/chat/completions` with SSE streaming; `GET {base}/models` populates the model picker. Thinking-suppression flags are sent only when the scope's toggle is on; tool schemas follow `toolCallingPolicy.js`; screenshots are attached only when the scope's "accepts images" toggle is on
- **Diarization**: `POST {base}/audio/diarizations` (multipart WAV, `mode`), one URL for meetings and uploads, sharing the speech-to-text key. Live speaker identification during a meeting, VAD and naming speakers from saved voice profiles stay on-device
- **URL rules**: a scheme-less URL is read as `https://`; plain `http://` is accepted only for private hosts (loopback, RFC 1918 / CGNAT / link-local IP literals, `*.local`, `*.ts.net`) — `isSecureHttpEndpoint` in `src/utils/urlUtils.ts`, mirrored in `providerConnectionTest.js`. Any other hostname (including a LAN name like `llm.lan`) needs HTTPS with a certificate the OS trusts
- **Test connection**: every endpoint field has a test button backed by `providerConnectionTest.js`
- A local mic → self-hosted server path never needs streaming support: dictation records then uploads; meetings use the chunk queue in section 18

### 10. System Settings Integration

The app can open OS-level settings for microphone permissions, sound input selection, and accessibility:

**IPC Handlers** (in `ipcHandlers.js`):

- `open-microphone-settings`: Opens microphone privacy settings
- `open-sound-input-settings`: Opens sound/audio input device settings
- `open-accessibility-settings`: Opens accessibility privacy settings (macOS only)
- `open-login-items-settings`: Opens the login/startup items pane (macOS Login Items, Windows Startup Apps)

**Platform-specific URLs**:

| Platform | Microphone Privacy                                                           | Sound Input                                                  | Accessibility                                                                   | Login Items                                                         |
| -------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| macOS    | `x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone` | `x-apple.systempreferences:com.apple.preference.sound?input` | `x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility` | `x-apple.systempreferences:com.apple.LoginItems-Settings.extension` |
| Windows  | `ms-settings:privacy-microphone`                                             | `ms-settings:sound`                                          | N/A                                                                             | `ms-settings:startupapps`                                           |
| Linux    | Manual (no URL scheme)                                                       | Manual (e.g., pavucontrol)                                   | N/A                                                                             | N/A (XDG autostart entry, see `linuxAutostart.js`)                  |

**UI Component** (`MicPermissionWarning.tsx`):

- Shows platform-appropriate buttons and messages
- Linux only shows "Open Sound Settings" (no separate privacy settings)
- macOS/Windows show both sound and privacy buttons

### 11. Debug Mode

Enable with `--log-level=debug` or `OPENWHISPR_LOG_LEVEL=debug` (can be set in `.env`):

- Logs saved to platform-specific app data directory
- Comprehensive logging of audio pipeline
- FFmpeg path resolution details
- Audio level analysis
- Complete reasoning pipeline debugging with stage-by-stage logging

Packaged Windows builds keep logger output off stdout/stderr by default. Launch with
`--console-logs` to opt into terminal output independently of the configured log level.
Default INFO entries are not persisted in this mode; enabling debug logging retains them
in the existing log file without enabling terminal output.

### 12. Windows Push-to-Talk

Native Windows support for true push-to-talk functionality using low-level keyboard hooks:

**Architecture**:

- `resources/windows-key-listener.c`: Native C program using Windows `SetWindowsHookEx` for keyboard hooks
- `src/helpers/windowsKeyManager.js`: Node.js wrapper that spawns and manages the native binary
- Binary outputs `KEY_DOWN` and `KEY_UP` to stdout when target key is pressed/released

**Compound Hotkey Support**:

- Parses hotkey strings like `CommandOrControl+Shift+F11`
- Maps modifiers: `CommandOrControl`/`Ctrl` → VK_CONTROL, `Alt`/`Option` → VK_MENU, `Shift` → VK_SHIFT
- Verifies all required modifiers are held before emitting key events

**Binary Distribution**:

- Compiled from source by `scripts/build-windows-key-listener.js`, part of `compile:native`, so every `prebuild*`, `predev:main` and `prestart` chain on a Windows host builds it; neither script runs on other hosts
- Fallback: prebuilt binary from GitHub releases (`windows-key-listener-v*` tags) via `scripts/download-windows-key-listener.js`
- Release CI (`release.yml`, `build-and-notarize.yml`) compiles it with MSVC during `build:win`
- CI workflow: `.github/workflows/build-windows-key-listener.yml` rebuilds the prebuilt binary when `resources/windows-key-listener.c` changes on main
- `afterPack.js` fails a Windows package without the binary. A dev run without it starts with Hold unavailable (a saved Hold is reset to Tap at startup), modifier-only hotkeys refused, and `F8` as the default hotkey (`hotkeyManager.js`)

**IPC Events**:

- `windows-key-listener:key-down`: Fired when hotkey pressed (start recording)
- `windows-key-listener:key-up`: Fired when hotkey released (stop recording)

### 13. Custom Dictionary

Improve transcription accuracy for specific words, names, or technical terms:

**How it works**:

- User adds words/phrases through Settings → Custom Dictionary
- Words stored as JSON array in localStorage (`customDictionary` key)
- On transcription, words are joined and passed as `prompt` parameter to Whisper
- Works with local whisper.cpp and with self-hosted OpenAI-compatible servers (sent as the `prompt` form field)

**Implementation**:

- `src/hooks/useSettings.ts`: Manages `customDictionary` state
- `src/components/SettingsPage.tsx`: UI for adding/removing dictionary words
- `src/helpers/audioManager.js`: Reads dictionary and adds to transcription options
- `src/helpers/whisperServer.js`: Includes dictionary as `prompt` in API request

**Whisper Prompt Parameter**:

- Whisper uses the prompt as context/hints for transcription
- Words in the prompt are more likely to be recognized correctly
- Useful for: uncommon names, technical jargon, brand names, domain-specific terms

### 14. GNOME Wayland Global Hotkeys

On GNOME Wayland, Electron's `globalShortcut` API doesn't work due to Wayland's security model. OpenWhispr uses native GNOME shortcuts:

**Architecture**:

1. `main.js` enables `GlobalShortcutsPortal` feature flag for Wayland
2. `hotkeyManager.js` detects GNOME + Wayland and initializes `GnomeShortcutManager`
3. `gnomeShortcut.js` creates D-Bus service at `com.openwhispr.App`
4. Shortcuts registered via `gsettings` as custom GNOME keybindings
5. GNOME triggers `dbus-send` command which calls the D-Bus `Toggle()` method

**Key Constants**:

- D-Bus service: `com.openwhispr.App`
- D-Bus path: `/com/openwhispr/App`
- gsettings path: `/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/openwhispr/`

**IPC Integration**:

- `get-hotkey-mode-info`: Returns `{ isUsingGnome, isUsingHyprland, isUsingNativeShortcut }` to renderer
- UI hides activation mode selector when `isUsingNativeShortcut` is true
- Forces tap-to-talk mode (push-to-talk not supported)

**Hotkey Format Conversion**:

- Electron format: `F8`, `CommandOrControl+Shift+Space`
- GNOME format: `F8`, `<Control><Shift>space`
- Backtick (`) → `grave` in GNOME keysym format
- F13-F24 bind the keysym the active keymap gives that key (`xkbcomp -xkb $DISPLAY -`, xkb keys `<FK13>`-`<FK24>`), for gsettings and the Hold portal alike: stock xkeyboard-config sends `XF86Launch7` for F16 and has no `F16` keysym, so GNOME can't grab `F16` (#1716). A key with no keysym (`keysym_missing`, e.g. stock F19/F24) or one gsd-media-keys already binds (`keysym_reserved`, e.g. F13 → `XF86Tools` opens Settings) is refused with a message. An unreadable keymap keeps the F-key name

### 15. Hyprland Wayland Global Hotkeys

On Hyprland (wlroots Wayland compositor), Electron's `globalShortcut` API and the `GlobalShortcutsPortal` feature don't work reliably. OpenWhispr uses native Hyprland keybindings:

**Architecture**:

1. `main.js` enables `GlobalShortcutsPortal` feature flag for Wayland (fallback)
2. `hotkeyManager.js` detects Hyprland + Wayland and initializes `HyprlandShortcutManager`
3. `hyprlandShortcut.js` creates D-Bus service at `com.openwhispr.App` (same as GNOME)
4. Shortcuts registered via `hyprctl keyword bind` (runtime keybinding)
5. Hyprland triggers `dbus-send` command which calls the D-Bus `Toggle()` method

**Detection**:

- Primary: `HYPRLAND_INSTANCE_SIGNATURE` environment variable (set by Hyprland)
- Fallback: `XDG_CURRENT_DESKTOP` contains "hyprland"

**Hotkey Format Conversion**:

- Electron format: `Control+Super`, `CommandOrControl+Shift+Space`
- Hyprland format: `CTRL, Super_L`, `CTRL SHIFT, space`
- Modifier-only combos (e.g., `Control+Super`) → `CTRL, Super_L`

**Bind/Unbind Commands**:

- Register: `hyprctl keyword bind "ALT, R, exec, dbus-send --session ..."`
- Unregister: `hyprctl keyword unbind "ALT, R"`
- Bindings are ephemeral (don't survive Hyprland restart) but re-registered on app startup

**Limitations**:

- Push-to-talk not supported (Hyprland `bind` fires a single exec, not key-down/key-up)
- Requires `hyprctl` on PATH (ships with Hyprland)

### 16. Meeting Detection (Event-Driven)

Detects meetings via three independent sources, orchestrated by `MeetingDetectionEngine`:

**Architecture**:

- `MeetingDetectionEngine` listens to events from `MeetingProcessDetector` and `AudioActivityDetector`
- `CalendarReminderScheduler` provides calendar context (imminent events, active meetings) from the `calendar_events` table, fed by the Apple Calendar manager (macOS)
- All three sources feed into a unified notification pipeline

**Process Detection** (known meeting apps — Zoom, Teams, Webex, FaceTime):

- macOS: `systemPreferences.subscribeWorkspaceNotification` — zero CPU, instant detection
- Windows/Linux: `processListCache` shared polling (30s interval, `ps-list` npm)
- Context-only: a running meeting app never prompts by itself (FaceTime idles in the background). It corroborates unattributed macOS device activity (below) and drives the auto-end process-exit fast path

**Microphone Detection** (unscheduled/browser meetings like Google Meet):

- macOS: `macos-mic-listener` binary — CoreAudio process-object input monitoring, excluding the background `com.apple.CoreSpeech` service (it runs input during ordinary playback). `CAPABILITY PID` transitions prompt on their own. `CAPABILITY AGGREGATE` device activity (no process objects — roughly macOS < 14.2 — or a transient snapshot failure) includes playback on combined input/output devices, so it prompts only while a known meeting app is running; the helper retries PID monitoring every 30s from its heartbeat and the detector accepts the later `CAPABILITY PID`. Capability is logged at info level; `sustained-audio-detected` carries `attributed`
- Windows: `windows-mic-listener.exe` — WASAPI `IAudioSessionManager2` session monitoring; self-mic exclusion happens in JavaScript using current OpenWhispr and capture-helper PIDs
- Linux: `pactl subscribe` — PulseAudio source-output events. Production captures (`media.role=production`, e.g. OBS) and sink-monitor captures (`stream.capture.sink=true`) still hold the mic for auto-end but don't prompt; the unfiltered fallbacks (a failed or JSON-less `pactl` listing, a failed excluded-pid lookup while polling, `pw-cli`) can't tell them apart
- Windows/Linux: Fall back to polling if the native binary/command is unavailable. macOS has no safe polling signal: a missing binary pauses audio prompts, a crashed listener is respawned with exponential backoff (5s → 60s), and meanwhile only calendar reminders prompt while auto-end uses its existing silence fallback

**Calendar Reminders** (scheduled meetings):

- `CalendarReminderScheduler` fires `meetingDetectionEngine.handleCalendarReminder(event)` 1 minute before the scheduled start (`MEETING_REMINDER_LEAD_MS`) — no native OS notifications; all meeting prompts use the in-app overlay so they survive Focus/DND and screen-share notification muting
- Calendar-sourced prompts show a Join primary action when the event has a meeting link (`getMeetingJoinUrl` in `src/helpers/meetingJoinUrl.js`, shared with the renderer's Upcoming Meetings join button) — Join opens the link and starts the note

**UX Rules**:

- All prompts render in one always-on-top overlay window (`MeetingNotificationCard`), content-protected so it never appears in screen shares
- Prompt copy is derived in the renderer from `{ variant, event, joinUrl }` (`meetingNotification.*` i18n keys); variants: `detected` (mic evidence), `starting` (calendar event not yet started), `underway` (event in progress)
- Per-source notification prefs: `notifyCalendarReminders` gates calendar prompts, `notifyMeetingDetection` gates mic/process prompts and, with `notificationsEnabled`, whether the mic and process detectors run at all (`meetingProcessDetection` additionally gates the process detector); nothing runs until the renderer has synced the saved snapshot
- During recording (tap-to-talk or push-to-talk): ALL notifications suppressed
- After recording: 2.5s cooldown before showing queued notifications
- Multiple signals coalesced: one overlay at a time; a newer prompt replaces the current one
- Calendar-aware: if an ongoing or imminent calendar event exists, the prompt shows the event name and links the note to the event
- Active meeting recording (meeting mode): all detections suppressed

**Binary Distribution**:

- macOS: Compiled from Swift source via `scripts/build-macos-mic-listener.js` during `compile:native`
- Windows: Prebuilt binary downloaded via `scripts/download-windows-mic-listener.js` during `prebuild:win`
- CI workflow: `.github/workflows/build-windows-mic-listener.yml` auto-builds on push to main

### 17. Voice Assistant Hotkey

A dedicated global hotkey that starts a dictation whose transcript is sent straight to the voice assistant as a command — no wake word ("Hey [AgentName]") needed — and that always bypasses the cleanup model. With auto-paste enabled, a caret verified as writable at capture time (an opaque `caret` session in `selectionManager.js`, revalidated before pasting) receives the completed answer and the pill returns to idle. A dormant macOS accessibility tree reports "unknown": synthetic copy can still recover selected text, but cannot establish a safe caret destination. Unknown targets therefore stay on the panel route, since they can also be integrated terminals, pages without inputs, or fields with selections hidden by clipboard capture. A verified caret whose accessibility becomes unknown before delivery falls back the same way. Terminal and secure-field checks still apply to verified targets. On Linux the caret is verified by `linux-text-monitor --probe-editable <pid>`, which answers only for the focused field in that process's active window; the pid comes from the target (its AT-SPI pid, `xdotool`/`kdotool getwindowpid`, or `hyprctl activewindow`), and a target whose pid can't be read stays on the panel route. Otherwise the answer streams into a floating assistant panel attached to the dictation pill (there is no separate assistant window) and, with auto-paste enabled, is also copied to the clipboard for manual paste (the Copy button confirms for six seconds). The pill window is content-protected while the panel is open (the panel never appears in screen shares).

**Flow**:

1. Hotkey pressed → `voiceAgent` slot callback in `main.js` → `windowManager.sendToggleVoiceAgent()` → `toggle-voice-agent` IPC to the main window → recording capsule appears
2. `useAudioRecording.js` starts a recording with `audioManager.setVoiceAgentRequested(true)` (any other start resets it to `false`)
3. On transcription, `resolveReasoningRoute` consults `resolveDictationRouteKind()` (`src/helpers/dictationRouting.js`): a voice assistant recording always takes the agent route and never falls back to cleanup. The dictation agent's reachability only gates selection edits — a selection with the dictation agent unconfigured routes to the panel with the selected text quoted instead of editing in place
4. Standalone commands (no text selected) run through the chat pipeline (`src/components/dictation/AssistantPanel.tsx`): chat tools (notes search/create/update, calendar, web search via SearXNG when configured, clipboard, `get_snippet` — triggers listed in the tool description, body fetched on demand — and `update_dictionary` / `update_snippets`, which write through the settings store so the change syncs like a UI edit), RAG memory, and the custom dictionary plus snippet triggers injected into the system prompt. Conversations persist in the `agent_conversations` table and are browsable from the ControlPanel chat
5. Response delivery: a capture with `status: "editable"` (a focused writable non-terminal field with no selection) plus auto-paste banks a `deliverySessionId`; the completed answer is pasted via `paste-at-captured-target`, which revalidates the target and fails closed to the panel + clipboard on any change (`assistantResponseDelivery.ts`, `pasteAtCapturedTarget` in `selectionManager.js`). A follow-up spoken while the panel is already open stays panel-first. Cancelled or empty responses never paste and never touch the clipboard
6. Selection edits: highlighted text goes through the `dictationAgent` scope and is safely replaced in place. When the editor judges the command a question about the selection ("explain this") rather than a change, it answers `SELECTION_QUESTION_MARKER` (`selectionEditing.js`) and the command goes to the panel with the selection quoted, leaving the selection untouched

**Storage & IPC**:

- Env var: `VOICE_AGENT_KEY` (persisted via `environment.js`), store key: `voiceAgentKey` (no default — user opt-in)
- IPC handlers: `update-voice-agent-hotkey`, `get-voice-agent-key`
- Hotkey slot: `voiceAgent` (tap-to-toggle; GNOME-native slot via `ToggleVoiceAgent` D-Bus method, KDE via KGlobalAccel, otherwise `globalShortcut`)

**Panel**:

- Esc collapses the panel; a Copy button copies the answer; a follow-up input takes typed questions. Esc while the command is still thinking cancels it; a command whose stream ends without content settles as `agentMode.chat.emptyResponse`
- Pressing the hotkey again while the panel is open records a follow-up into the same conversation

**UI**:

- Settings → Hotkeys → "Voice Assistant Hotkey" (with cross-slot conflict validation)
- Onboarding: optional pair of steps (hotkey, then demo) after the Notes step, so the demo can suggest meeting times from Apple Calendar if it was connected there. The demo card is a mail thread; the reply is answered headlessly in the dictation window by `useOnboardingAssistantDemo` (the panel's streaming pipeline, tools and screenshot included) and streamed back over `onboarding-demo-event` as `processing` (transcript) → `replying` (partial reply, `tool` while one runs) → `success`
- Panel conversations and in-place selection edits both run on the Voice Assistant scope (Settings → AI Models → Voice Assistant; `dictationAgent`), resolved by `resolveChatStreamingInference`; the panel falls back to the `chatIntelligence` scope while the Voice Assistant scope is unreachable. Typed chat (Control Panel, note and container chat) stays on `chatIntelligence`

**Screen Context (opt-in)**:

When "Share screen context" is enabled (Settings → AI Models → Voice Assistant → Screen Context, store key `voiceAgentScreenContext`, default off), each voice-assistant recording start captures the display the cursor is on and attaches it to the request as a base64 JPEG (long edge ≤ 1568 px).

- Capture: `src/helpers/screenContextCapture.js` (main process; `screen.getCursorScreenPoint` + `desktopCapturer`). macOS requires the Screen Recording TCC permission (`useScreenRecordingPermission` hook + `PermissionCard` in `DictationAgentSettings`); Windows/Linux X11 need no permission; Linux Wayland is unsupported (capture silently skipped)
- Encoding: `encodeWithinBudget()` walks a JPEG quality ladder (82 → 70 → 55), then falls back to a 1024 px resize, keeping the payload under `MAX_ENCODED_BYTES` (1.5 MB ≈ 2.05M base64 chars). Each rung re-encodes the original bitmap, so quality drops never compound. A screen that still won't fit is dropped
- Trigger: `useAudioRecording.js` calls `audioManager.beginScreenContextCapture()` at recording start (fire-and-forget); `consumeScreenContext()` (3s guard) is awaited when the request is built. The dictation overlay gets `setContentProtection` while the setting is on so the pill never appears in captures
- Routing: the press-time screenshot is re-decided against the model that will actually answer. It attaches only when that scope is self-hosted with "Accepts images" on (`dictationAgentAcceptsImages` / `chatAgentAcceptsImages`, see `scopeAcceptsImages` in `dictationAgentInference.js`) and the provider client is image-wired (`supportsImages` on the `InferenceProvider`). Dropping the image never fails the command
- Privacy: screenshots live only in renderer memory for one request — never written to disk, stored in history, or logged (loggers emit `hasScreenContext` booleans only)
- IPC: `capture-screen-context`, `check-screen-recording-access`, `request-screen-recording-access`, `open-screen-recording-settings`, `screen-context-set-enabled`

**Tests**: `test/helpers/dictationRouting.test.js`, `test/helpers/screenContextCapture.test.js` (run with `node --test`)

### 18. Meeting Transcription: Echo, Duplicate, and Segment Pipeline

Live meeting transcription runs two sources (mic + system-audio tap) and must keep the remote party's voice, as heard through the local speakers, out of the mic transcript. There is no streaming speech-to-text for meetings: `dispatchMeetingAudioBuffer` accumulates 24 kHz PCM per source and the closure in `ipcHandlers.js` cuts ~5 s batches that go either to the on-device engine (`transcribeLocalMeetingChunk`) or to the self-hosted server (`meetingTranscriptionMode` = `self-hosted`, `meetingRemoteTranscriptionUrl`). The policy lives in pure, unit-tested seams so it can be tuned without touching the IPC plumbing:

- **Self-hosted chunk queue** (`selfHostedMeetingTranscriber.js`): one request at a time — system, then mic — so a server that decodes one sequence at a time (e.g. vLLM with `max-num-seqs 1`) never sees concurrent requests. While a request is in flight new audio keeps accumulating and goes out merged into the next request, capped at `MEETING_REMOTE_MAX_BACKLOG_MS` (30 s; older audio is dropped and reported once). A transient failure (network, timeout, 408/425/429/5xx) is retried once; anything else drops that batch and the recording carries on. Tests: `test/helpers/selfHostedMeetingTranscriber.test.js`
- **Audio layer**: `meetingEchoLeakDetector.js` correlates mic chunks against recent system audio; `meetingMicGate.js` turns chunk RMS/peak (+ a "system speaking" lookback) into a `send` / `zero` / `skip` verdict that `ipcHandlers.js` applies before a batch is transcribed
- **Echo cancellation**: the WebRTC AEC3 helper (`meetingAecManager.js`, `native/meeting-aec-helper/`) replaces the mic channel only when Settings → Speech-to-Text → Note Recording → Echo cancellation for meetings is on (`meetingAecEnabled`, default off, sent as the `aecEnabled` start option). With headphones there is no echo, and AEC3 still cuts the user's own speech, worst in the first seconds (#1025)
- **Text layer**: `meetingMicHoldback.js` decides whether a mic final is risky (held back), a duplicate of recent system text (dropped), or racing an arriving system final (retracted); the `ipcHandlers.js` adapters (`shouldSkipDuplicateMicSegment`, `hasRiskyMicDuplicateProfile`, `removeRacingMicEntriesFor`, `removePendingMicFinalsFor`) apply the results to closure state and emit `meeting-transcription-segment` events (`partial` / `final` / `retract`)
- **Speakers**: diarization runs on the configured engine (on-device sherpa-onnx, or the self-hosted `/audio/diarizations` server — `diarizationRoute.ts`); live speaker identification and naming speakers from saved profiles always run on-device (ONNX worker), whichever engine transcribed the text
- **Renderer**: `src/stores/meetingSegmentReducer.ts` is the pure `(state, event, deps) → reduction` transition for those events (timestamp-sorted insert, retract by exact match, per-source partial slots); `meetingRecordingStore.ts` supplies `mintSegmentId` / `decorateFinal` (speaker identifications, provisional speaker, locks — must not write to the store) and applies the reduction. Tests: `test/stores/meetingSegmentReducer.test.js`, `test/stores/meetingRecordingStoreImports.test.js`
- **Regression pins**: tests named `characterization: …` pin known oddities on purpose — flip them deliberately when changing policy
- **Fixtures**: `test/helpers/harness/pcmFixtures.js` — deterministic 24 kHz PCM generators (`makeSine`, `makeSeededNoise`, `mix`, `delayBy`, `toInt16Buffer`, `chunkBuffer`, …) used by the gate and echo-detector tests

### 19. Obsidian Export and Multi-Computer Import (Note Files)

Settings → "Export to Markdown / Obsidian vault" mirrors notes into a folder as Markdown so an Obsidian vault can index them. Point `noteFilesPath` at a folder inside the vault (e.g. `~/Obsidian/Vault/OpenWhispr`); the mirror writes `<path>/<folder>/…`, with notes outside any folder under `Personal/`. When the vault is synced between computers, each computer also imports the notes the others exported.

- **Layout**: one `<title>.md` per note plus `<title> (transcript).md` for meetings and uploads, linked to each other with wikilinks; optional daily files under `Dictations/` when `noteFilesExportDictations` is on. With an AI summary, the raw notes follow the `<!-- openwhispr:notes -->` marker (`NOTES_MARKER`) so the importer can split them apart again
- **Frontmatter**: `openwhispr_id` (this database's id), `openwhispr_uid` (the note's `client_note_id`, the same on every computer), `openwhispr_updated` (exact UTC last change; `updated` is Obsidian's local time without a zone), type, dates, duration, participants, linked calendar event, `ai_summary: true` when the body starts with a summary, tags rooted at `noteFilesBaseTag` (default `openwhispr`)
- **Ownership**: `markdownMirror.js` only renames, overwrites or deletes files it provably owns: the frontmatter uid (the id only for a note without a uid, since an imported note's id differs per computer), or the exact legacy file shape for a one-time rename of older exports; everything else in the folder is left alone. Bump `FORMAT_VERSION` in `noteFilesSync.js` when the layout changes — the next launch rebuilds the mirror
- **Export**: `noteFilesSync.js` listens to database change events, coalesces bursts (live meeting transcripts update every few seconds) and renders each note with its folder, speaker names and calendar event; `noteExportFormat.js` holds the pure naming/frontmatter/body formatting
- **Import**: on enable, path change or rebuild (before anything is rewritten, so a newer file is never replaced by an older copy) and on `fs.watch` events (polling every minute if the folder can't be watched), `importFromFiles()` scans the folder. An unknown uid becomes a note (its folder is created by name); a file whose `openwhispr_updated` is newer than the note's `updated_at` replaces only the fields that render differently (`noteImportFormat.changedColumns`, comparing against the note's own export parsed back, so a richer local transcript survives a remote summary edit). Imports keep the file's timestamps (`applyImportedNote` in `database.js`) and never rewrite the file they came from. Last writer wins; hand edits in the vault don't move `openwhispr_updated`, so they are still overwritten. Named speakers come back as locked user names, like the Granola import. Deleting a note records a tombstone (`deleted` in `note-files-state.json`), so a copy left in the folder is imported again only if it changed after the delete; deletes don't propagate to other computers. New and changed notes reach the renderer as `note-added` / `note-updated`
- **Open in Obsidian**: `note-files-open-in-obsidian` opens `obsidian://open?path=…` only for a file the mirror wrote
- Tests: `test/helpers/markdownMirror.test.js`, `noteExportFormat.test.js`, `noteImportFormat.test.js`, `noteFilesSync.test.js` (the database tests need Electron's Node: `ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron --test …`)

### 20. Web Search (SearXNG)

The assistant's `web_search` tool is backed by the user's own SearXNG instance (Settings → AI Models → Chat / Voice Assistant → Web search; `webSearchEnabled`, `webSearchUrl`, e.g. `https://search.lan`). The tool is only registered when web search is enabled with a URL set, and the model needs tool calling on.

- `searxngSearch.js` (main process) issues `GET {base}/search?q=…&format=json` with a 10 s timeout and maps results to `{ title, url, text, publishedDate }` plus direct answers and the first infobox. Only the query and the model's time range are sent — no cookies, keys or conversation text
- JSON output must be enabled in the instance's `settings.yml` (`search.formats: [html, json]`); a 403 or a non-JSON reply is reported with that hint
- URL rules match the self-hosted endpoints (HTTPS, or HTTP on a private host)
- Tests: `test/helpers/searxngSearch.test.js`

### 21. Note Templates and Actions

Rows in the `actions` table (built-ins seeded from `src/helpers/builtinActions.js`) are one of two kinds:

- **Templates** (`kind: 'template'`) write a note's AI summary (`enhanced_content`) from its notes, meeting context, and transcript, never from the summary they replace. A template is a context (`prompt`) plus ordered `sections` (`{heading, instruction}`); `compileTemplatePrompt` wraps sections in the shared notes rules. A template without sections keeps the request it always had after the `SOURCE_FIDELITY_RULE` prefix (the generic system prompt, or the material preamble for a standalone key). The note records the template in `enhancement_template_id` (its `client_id`), which syncs with the note, and `enhancement_prompt` the compiled system prompt
- **Actions** (`kind: 'action'`) work from the AI summary when the note has one, and from its notes and transcript otherwise (`buildNoteRunInput`). Only the built-in Make notes shorter (`shorten`) and Make notes longer (`lengthen`) actions edit that summary, selected by fixed built-in identity (`toActionItem`), never an editable name or stored `output`. A summary edit requires complete output, never splits into parts, and writes only `enhanced_content`; with no summary yet it writes one from the transcript and applies the action to it, run like a template (split into parts on a local model, the material hash recorded); every other built-in and custom action, including Write TL;DR (`addTldr`), runs in the note chat via `SendToAIOptions.requestText` (the chat shows a built-in's call to action where it has one, otherwise the action's name, and the preamble points the model at the summary or the transcript and has it answer in the chat as text in the note's language, using a tool to draft, send or post only when the action's instructions explicitly ask to send, post or file something, and leaving the note unchanged, with an asked-for edit written in the chat instead; its turn is never offered `update_note` (`keepNotesUnchanged`), so it can't change a note whatever the model decides; the note chat's other tools and attendee block otherwise apply as usual, and its transcript context names speakers only on notes known to be the user's own (`ownsNote`), never listing the unfiltered invitees)
- The default template is the built-in AI Summary (the generic prompt, stored under the old Generate Notes key `generateNotes`), listed first, then Detailed Notes (launch re-applies the built-in order). Invariant: Detailed Notes, compiled from its sections, equals the flat 1.10.2 prompt it replaced after the `SOURCE_FIDELITY_RULE` prefix used by templates and summary actions (`sourceFidelity.js`), but for the closing rule on material with nothing to summarize (`test/helpers/templatePrompts.test.js`); a built-in's `previousPrompts` only upgrades rows that are still flat. Chat actions get the rule once, from the chat system prompt (`getAgentSystemPrompt`), and the Cloud request leaves out the leading system message that repeats `systemPrompt`, which the API prepends itself
- For material with nothing substantive (only greetings, filler or recording checks), sectioned templates, AI Summary and a summary action writing a first summary ask the model to answer `NOTHING_TO_SUMMARIZE`; custom context-only templates and flat built-ins edited before this rule keep their own rules. A reply that is the marker (bare, fenced, emphasised or after a short sentence) outside a thinking block writes nothing; a summary that merely contains it is saved, and the runner shows `notes.actions.errors.nothingToSummarize` as a neutral notice (`notice` on the error event) instead of saving a placeholder summary
- UI: `TemplatePicker` opens from the chevron in the AI Summary tab, which names the note's template; the "Generate AI Summary" callout (runs the note's template, else the default), `ActionPicker` in the collapsed ask bar (runs the last action picked from it, in place of the send button), `ActionChips` once the in-view chat opens and in the docked chat (the first five actions in docked chat; the centered row omits Make notes longer without backfilling another chip; each has its action's icon, and All actions keeps every action; hovering a chip shows its icon, title and description without a destination badge; the in-view chat pins All actions at the end, and the docked chat shows them as filled pills in one tray with its composer: All actions, then the actions, scrolling together), a `/` menu in the note composers (`slashCommands` on `ChatInput`, each row with its action's icon, or a "/" for an icon this build doesn't know; it fills the chat above the composer until a command runs, the "/" is deleted, nothing matches or the composer loses focus), and `ActionManagerDialog` (Templates | Actions). The notes list and the docked chat widen or narrow from their edge facing the note (`useResizableWidth`, `PanelResizeHandle`), and keep their width across launches (localStorage `notesSidebarWidth`, `noteChatWidth`). Anything the ask bar sends (a message, or a chat action from the picker, a chip or the `/` menu) starts a new conversation in the docked chat, which holds the conversation and its history; the in-view chat is only the chips and the composer. Destinations are fixed and described in the editor; saving never asks a model to choose one. Legacy custom summary destinations read as chat (`toActionItem`), keeping the existing IPC fields, IDs and prompts. Summary generation stays in the AI Summary tab and callout. A run that writes the summary is undoable for 6 s instead of asking first: the runner queues the fields it overwrote (`appliedEvents`) and `BackgroundActionToastListener` shows the Undo toast

### 22. Tone & Style

Dictation cleanup writes in the tone the user picked for the kind of app they are dictating into: personal messages (formal, casual, very casual), work messages, email and everything else (formal, casual, excited). Off by default (cleanup keeps the speaker's own tone, the standard tone); turned on by finishing the setup dialog or the Tones & voices switch in Settings > Tone & Style. The assistant and chats also write drafts (messages, emails, replies, posts) in the tone of the kind of text the request is for. Translation keeps its source's tone.

- **Detection** (main, at dictation start): `capture-dictation-app-category` reads the captured target through `selectionManager.getTargetAppContext()` and classifies it with `toneAppCategories.js`. macOS: `macos-text-monitor --app-context <pid>` prints the app name, bundle id, focused window title (accessibility, no Screen Recording needed) and, for a browser page, the URL host. Windows: `windows-fast-paste --detect-only` also prints `WINDOW_TITLE` (an older helper without it classifies by exe only). Linux: the window title is read on demand (`xdotool`/`kdotool getwindowname`) or taken from Hyprland's active window; an AT-SPI target's comes from `linux-fast-paste --atspi-target` (`WINDOW_TITLE_B64`, the active window's accessible name; an older helper prints none). Titles are kept beside the captured target (`_targetTitles`), never on it, since capture results reach the renderer. A browser (and a Windows UWP frame) is judged by its page or app title (its host, else the site name the title ends with; on a host not listed, only a site name the host carries, so a Notion page titled "Hey" stays `other`); native apps by whole-token app identity. Titles and hosts never leave the main process or reach the logs; only the category does
- **Cleanup**: `useAudioRecording` starts `audioManager.beginToneStyleCapture()` for every non-translation recording while Tone & Style is on; the cleanup route's `consumeToneStyle()` (1.5 s guard, unknown app reads as `other`) puts `toneStyle` on the reasoning config, and the local and self-hosted providers append `appendToneStyleSuffix` (`src/config/prompts/toneStyle.ts`) after the dictionary suffix. Its sentences are English in every locale; the mobile app's `composerPrompt.ts` copies the tone and priority sentences too, so change both together
- **Assistant and chat**: `getAgentSystemPrompt`'s `writingStyle` option adds a WRITING STYLE block (`buildWritingStyleBlock`) to every chat surface's prompt while Tone & Style is on: the model works out from the request and the recipient which kind of text it writes, and uses the user's tone for it; its own answers keep its voice, a tone the user asks for wins, and code is never restyled. A voice-assistant answer pasted at a verified caret writes its reply for that app: `processAgentCommand` consumes the capture and banks `deliveryAppCategory`, which reaches the send as `destinationAppCategory` through the paste delivery. Before pasting, `deliverAssistantResponse` replaces the answer's em dashes, except in ranges (which take an en dash), code, links and non-Latin scripts. Selection edits get one sentence (`selectionEditToneSentence`) that applies the selection's app style only to a prose rewrite asked for without a tone
- **UI**: Home banner (`ToneStyleBanner`, cleanup-off copy turns cleanup on) and the setup dialog (`ToneStyleSetupDialog`: intro plus one step per category), offered once the user has dictated `TONE_STYLE_PROMPT_MIN_WORDS` (70, `src/config/toneStyle.ts`) words of local history; the dialog opens by itself once, the banner stays until set up or "Not now" (`useToneStylePrompt`). Settings > Tone & Style (`settings/ToneStyleSection.tsx`) has a Tones & voices switch (`toneStyleEnabled`); while it's off, the picks and Save Changes are grayed out. App badges live in `src/assets/icons/apps/`

## Development Guidelines

### Internationalization (i18n) — REQUIRED

All user-facing strings **must** use the i18n system. Never hardcode UI text in components.

**Setup**: react-i18next (v15) with i18next (v25). Translation files in `src/locales/{lang}/translation.json`.

**Supported languages**: ar, de, en, es, fr, it, ja, pt, ru, zh-CN, zh-TW

**How to use**:

```tsx
import { useTranslation } from "react-i18next";

const { t } = useTranslation();
// Simple: t("notes.list.title")
// With interpolation: t("notes.upload.using", { model: "Whisper" })
```

**Rules**:

1. Every new UI string must have a translation key in `en/translation.json` and all other language files
2. Use `useTranslation()` hook in components and hooks
3. Keep `{{variable}}` interpolation syntax for dynamic values
4. Do NOT translate: brand names (OpenWhispr, Pro), technical terms (Markdown, Signal ID), format names (MP3, WAV), or the shared assistant `fullPrompt` in `prompts.json`. The other prompt keys (`cleanupPrompt`, `translatePrompt`, `dictionarySuffix`, `screenContextSuffix`) are translated per locale, and any change to a default prompt must update `CURRENT_DEFAULT_PROMPT_HASHES` in `src/config/retiredPrompts.js`
5. Group keys by feature area (e.g., `notes.editor.*`, `referral.toasts.*`)

### Image and Icon Assets — REQUIRED

Raster UI assets live in `src/assets/` (onboarding ones are named `onboarding-*`). Vector provider/brand marks live in `src/assets/icons/`.

UI icons come from `src/components/icons/` (vendored Nucleo core outline components behind lucide-style names, e.g. `import { Check, Loader2 } from "../icons"`). To add one, map a name to a Nucleo label in `src/components/icons/nucleo-map.json` and run `node scripts/sync-nucleo-icons.js`; never import from `lucide-react` or a machine-local Nucleo path. Icons outside that set — the status marks, the note toolbar's formatting glyphs, the note chat's rounded copy and "/" glyphs, and the design's action icons (`ListEnd`, `FolderRounded`) — are drawn by hand in `src/components/icons/primitives.tsx`, which the generated `index.ts` re-exports.

**Typography**: `--font-family-sans` is Yowza (brand, Latin only) falling back to the bundled Noto Sans; `--font-family-display` is Yowza Soft for headings. The font files are licensed and never committed — `src/brandFonts.ts` registers whatever `scripts/download-brand-fonts.js` fetched at build time, and a build without them silently uses Noto Sans.

**Rules**:

1. **Always `import` the asset**; never write a literal path like `/assets/foo.webp`. Packaged builds load the renderer from a `file://` origin, so root-relative paths resolve to nothing. Importing lets Vite fingerprint the file and rewrite the URL:

   ```tsx
   import microphoneIcon from "@/assets/onboarding-permission-microphone.webp";
   <img src={microphoneIcon} ... />;
   ```

2. **WebP, lossless** for UI art with hard edges or alpha — `cwebp -lossless -z 9 -alpha_q 100 in.png -o out.webp` (roughly 40–55% smaller than PNG). Reserve lossy for photographic art.
3. **Author at 2x the CSS slot** and no larger (a 44px slot gets an 88px asset). Retina-sharp without paying for pixels that get downscaled away.
4. **Bake rounded corners into the artwork as transparency** rather than adding a CSS `rounded-*` on the `<img>` — CSS rounding on top of already-rounded art clips the corners twice.
5. **Decorative images take `alt=""` plus `aria-hidden="true"`.** Most icons sit beside a visible label that already names them (e.g. the permission rows), so a descriptive `alt` makes screen readers announce the same thing twice. Only write real `alt` text when the image is the _only_ source of that information.
6. **Always set explicit `width`/`height`** matching the CSS size, to reserve layout space before decode. Add `decoding="async"` and `draggable={false}` (in Electron a draggable image can be dragged out of the window).
7. **Assets under 4 KB are inlined** by Vite as base64 data URIs, so they will not appear in `dist/assets/`. Grep the JS chunks for `data:image/webp;base64,` before concluding an asset went missing.

### Adding New Features

1. **New IPC Channel**: Add to both ipcHandlers.js and preload.js
2. **New Setting**: Update useSettings.ts and SettingsPage.tsx
3. **New UI Component**: Follow shadcn/ui patterns in src/components/ui
4. **New Manager**: Create in src/helpers/, initialize in main.js
5. **New UI Strings**: Add translation keys to all 11 language files (see i18n section above)
6. **New Sidecar Binary**: Add download script in `scripts/`, add to `prebuild*` scripts in package.json, add manager in `src/helpers/`, initialize in `main.js`. Spawn the child with `detached: process.platform !== "win32"` so it has its own process group on Unix. Right after spawn call `sidecarPidFile.write(name, child.pid)` and on `close` call `sidecarPidFile.clear(name)`. Add the binary fragment to `EXPECTED_BINARY_FRAGMENTS` in `sidecarReaper.js`. Register a stop function via `sidecarRegistry.register(name, () => manager.stop())` in `registerSidecars()` — that single registration replaces the old `will-quit` line.

### Testing Checklist

- [ ] Test both local and self-hosted (LAN) processing modes, for dictation, meetings and uploads
- [ ] Verify hotkey works globally
- [ ] Check clipboard pasting on all platforms
- [ ] Test with different audio input devices
- [ ] Verify whisper.cpp binary detection
- [ ] Test all Whisper models
- [ ] Check agent naming functionality
- [ ] Test custom dictionary with uncommon words
- [ ] Verify Windows Push-to-Talk with compound hotkeys
- [ ] Test GNOME Wayland hotkeys (if on GNOME + Wayland)
- [ ] Test Hyprland Wayland hotkeys (if on Hyprland + Wayland)
- [ ] Verify activation mode selector is hidden on GNOME Wayland and Hyprland Wayland
- [ ] Verify meeting detection works with event-driven mode (check debug logs for "event-driven")
- [ ] Test meeting notification suppression during recording
- [ ] Test post-recording cooldown (notifications shouldn't flash immediately)
- [ ] Create a note about "quarterly revenue projections", search via agent for "financial forecast" — should match semantically
- [ ] Verify Qdrant stays down at launch and starts on the first agent search (check debug logs for "qdrant started successfully"), then stops after 5 idle minutes
- [ ] Kill Qdrant process manually — verify FTS5 keyword search still works as fallback
- [ ] Point Note files at a scratch Obsidian vault folder, record a meeting — verify the note and `(transcript)` files appear and update, and that unrelated files in the folder are untouched
- [ ] Copy another computer's export into that folder — verify its notes appear in the app, and that a newer copy updates them without duplicating files
- [ ] Configure a SearXNG URL and ask the assistant a current-events question — verify the `web_search` tool runs and nothing else leaves the machine
- [ ] Block outbound traffic except your LAN — verify dictation, meetings, notes and chat still work

### Common Issues and Solutions

1. **No Audio Detected**:
   - Check FFmpeg path resolution
   - Verify microphone permissions
   - Check audio levels in debug logs

2. **Transcription Fails**:
   - Ensure whisper.cpp binary is available
   - Check model is downloaded
   - Check temporary file creation
   - Verify FFmpeg is executable

3. **Clipboard Not Working**:
   - macOS: Check accessibility permissions (required for AppleScript paste)
   - Linux: Native `linux-fast-paste` binary (XTest) is tried first, works for X11 and XWayland apps
     - X11: xdotool fallback if native binary unavailable
     - Hyprland Wayland: wtype → sendshortcut → uinput/ydotool
     - Sway/wlroots Wayland: wtype → uinput/ydotool
     - COSMIC Wayland: wtype for a detected terminal → uinput/ydotool
     - GNOME/KDE Wayland: portal keysyms (Shift+Insert on KDE, except Warp) → uinput/ydotool
     - Physical Wayland fallbacks use Shift+Insert to avoid layout-sensitive KEY_V
   - Windows: PowerShell SendKeys (built-in) or nircmd.exe (bundled)

4. **Build Issues**:
   - Use `npm run pack` for unsigned builds (CSC_IDENTITY_AUTO_DISCOVERY=false)
   - Signing requires Apple Developer account
   - ASAR unpacking needed for FFmpeg
   - Run `npm run download:whisper-cpp` before packaging (current platform)
   - Use `npm run download:whisper-cpp:all` for multi-platform packaging
   - afterSign.js automatically skips signing when CSC_IDENTITY_AUTO_DISCOVERY=false
   - **Lockfile**: Always use Node 24 when running `npm install` (matches CI). If your local Node version differs, use `nvm exec 24 npm install`. Running `npm install` with a different major version will produce an incompatible `package-lock.json` that breaks `npm ci` in CI.

5. **Windows Push-to-Talk Binary**:
   - Compiled from `resources/windows-key-listener.c` whenever `compile:native` runs on a Windows host (`prebuild:win`, `predev:main`, …); the prebuilt binary download from GitHub releases is the fallback
   - If neither compiling nor the download produces it, `afterPack.js` fails the Windows build; an unpackaged dev run starts without it, with Hold and modifier-only hotkeys unavailable and `F8` as the default hotkey
   - To compile locally: install Visual Studio Build Tools or MinGW-w64
   - CI workflow (`.github/workflows/build-windows-key-listener.yml`) rebuilds the prebuilt binary when `resources/windows-key-listener.c` changes on main

6. **Meeting Detection Not Working**:
   - Check debug logs for "event-driven" vs "polling" mode; macOS also logs `macOS microphone detection capability` as `PID` or `AGGREGATE`
   - macOS: Verify `macos-mic-listener` binary exists in `resources/bin/` (compiled during `npm run compile:native`)
   - Windows: Verify `windows-mic-listener.exe` exists in `resources/bin/` (downloaded during `prebuild:win`)
   - Linux: Verify `pactl` is installed (`pulseaudio-utils` or `pipewire-pulse` package)
   - If the event-driven binary is missing, Windows/Linux fall back to polling; macOS pauses audio prompts (and respawns a crashed listener with backoff)

7. **Local Semantic Search Not Working**:
   - Qdrant binary should be in `resources/bin/qdrant-{platform}-{arch}` (auto-downloaded during `predev`/`prebuild`)
   - Embedding model should be in `~/.cache/openwhispr/embedding-models/all-MiniLM-L6-v2/model.onnx` (downloaded on the first semantic search)
   - Run `npm run download:qdrant` and `npm run download:embedding-model` manually if missing
   - Check debug logs for "qdrant" entries (port, health check, errors)
   - If Qdrant fails to start, search still works via FTS5 keyword fallback
   - Semantic search is only available through the AI agent's `search_notes` tool, not the manual search UI

### Platform-Specific Notes

**macOS**:

- Requires accessibility permissions for clipboard (auto-paste)
- Requires microphone permission (prompted by system)
- Uses AppleScript for reliable pasting
- Notarization needed for distribution
- Shows in dock with indicator dot when running (LSUIElement: false)
- whisper.cpp bundled for both arm64 and x64
- System settings accessible via `x-apple.systempreferences:` URL scheme
- **Launch at login**: `setLoginItemSettings()`, which routes through `SMAppService` on macOS 13+. `openAsHidden` is deprecated and does nothing, so `wasOpenedAtLogin` is what sends a login launch to the tray. An item can register and still report `status: "requires-approval"` until the user allows it under System Settings → General → Login Items

**Windows**:

- No special accessibility permissions needed
- Microphone privacy settings at `ms-settings:privacy-microphone`
- Sound settings at `ms-settings:sound`
- NSIS installer for distribution
- whisper.cpp bundled for x64
- **Launch at login**: `HKCU\...\Run` entry written by Electron, named after the AppUserModelId, carrying `--hidden` so a login launch goes to the tray
  - Read the state from `executableWillLaunchAtLogin`; `openAtLogin` misses a startup app disabled from Task Manager or Settings
  - `resources/nsis/installer.nsh` removes the `Run` and `StartupApproved\Run` values on uninstall (but not on update), which Electron itself never cleans up
- **Tray identity**: signed production builds pass a permanent GUID to `new Tray()` (`tray.js`) so Windows keeps the user's tray placement across updates. Never change the GUID
  - Windows binds an unsigned executable's GUID to its path, so the GUID is gated on the `windowsTrayIdentity` marker that `electron-builder.json` injects through `extraMetadata`
  - `electron-builder.json` forces Windows code signing; unsigned Windows builds (PR CI, local) must use `electron-builder.unsigned-win.json`, which clears the marker. Never run the `win-unpacked` a failed signed build leaves behind: it carries the marker and may be unsigned
- **Push-to-Talk**: Native key listener binary (`windows-key-listener.exe`) enables true push-to-talk
  - Uses Windows Low-Level Keyboard Hook (`WH_KEYBOARD_LL`)
  - Supports compound hotkeys (e.g., `Ctrl+Shift+F11`)
  - Compiled from source during the build, with the prebuilt GitHub release binary as fallback (see section 12, Binary Distribution)
  - `afterPack.js` fails a Windows package without it

**Linux**:

- Multiple package manager support
- Standard XDG directories
- AppImage for distribution
- whisper.cpp bundled for x64
- No standardized URL scheme for system settings (user must open manually)
- Privacy settings button hidden in UI (not applicable on Linux)
- Recommend `pavucontrol` for audio device management
- **GPU compositing**: on, as on Windows, except whenever an NVIDIA kernel module (proprietary or open, any version) is loaded (`linuxGpuCompositing.js`, `/proc/driver/nvidia/version`): it flickered transparent windows in #203, Chromium's blocklist doesn't catch it, and explicit sync (driver 555+, Xwayland 24.1+, compositor support) can't be checked before app ready. Anyone else can turn it off with `--disable-gpu-compositing` in `open-whispr-flags.conf`, read by the packaged launcher (`scripts/lib/linux-launcher.js`). The mode is logged at startup, which only reaches the log file at `--log-level=debug`
- **Backdrop blurs**: Linux can still composite on the CPU, where a large blur is redrawn on every repaint above it (#2298):
  - On Linux (`ui/overlayBlur.ts`), the full-window dialog overlays (shared `Dialog`, Settings, Ctrl+K) skip their default backdrop blur; a blur passed through `overlayClassName` still applies
  - On Linux, the note action overlay (`ActionProcessingOverlay`), whose scanner animation never stops, uses a denser scrim and an opaque card, so the scanner line passes behind the label
  - Settings cards (`SettingsPanel`), the Settings selects and the `LanguageSelector` trigger sit on an opaque pane, so they carry no blur on any platform
- **Launch at login**: XDG autostart entry at `~/.config/autostart/open-whispr.desktop` (see `linuxAutostart.js`), since Electron's `setLoginItemSettings()` does nothing on Linux
  - Disabling it from GNOME Tweaks or KDE's autostart editor is reflected in the Settings toggle
  - "Start minimized" is handled app-side by the `startMinimized` setting, not by the desktop entry
- **Clipboard paste tools** (at least one required for auto-paste):
  - **X11**: `xdotool` (recommended)
  - **Hyprland Wayland**: `wtype`, then `hyprctl` sendshortcut (avoids the sendshortcut stuck-modifier bug when wtype is installed)
  - **Sway/wlroots Wayland**: `wtype` (requires the virtual keyboard protocol)
  - **COSMIC Wayland**: `wtype` for terminals (Warp has no Shift+Insert paste); other windows paste with uinput Shift+Insert. Settings and onboarding ask for `wtype` there once something else pastes (`needsWtype` in `src/utils/linuxPasteTools.ts`), but `checkPasteTools` never reports it as the method
  - **GNOME/KDE Wayland**: RemoteDesktop portal keysyms (Shift+Insert on KDE, except Warp), then uinput/ydotool
  - **Wayland physical fallback**: Shift+Insert avoids layout-sensitive KEY_V; `ydotool` requires the `ydotoold` daemon
  - Terminal detection: Auto-detects terminal emulators and uses Ctrl+Shift+V
  - Fallback: Text copied to clipboard with manual paste instructions
- **GNOME Wayland global hotkeys**:
  - Uses native GNOME shortcuts via D-Bus and gsettings (no special permissions needed)
  - Hotkeys visible in GNOME Settings → Keyboard → Shortcuts → Custom
  - Default fallback: `F8` when `Control+Super` cannot be registered
  - Push-to-talk unavailable (GNOME shortcuts only fire single toggle event)
  - Falls back to X11/globalShortcut if GNOME integration fails
  - D-Bus transport: `@homebridge/dbus-native` (pure JavaScript, no native addons)

## Code Style and Conventions

- Use TypeScript for new React components
- Follow existing patterns in helpers/
- Descriptive error messages for users
- Comprehensive debug logging
- Clean up resources (files, listeners)
- Handle edge cases gracefully

## Performance Considerations

- Whisper model size vs speed tradeoff
- Audio blob size limits for IPC (10MB)
- Temporary file cleanup
- Memory usage with large models
- Process timeout protection (5 minutes)
- Meeting detection uses event-driven OS APIs (near-zero CPU) with polling fallback on Windows/Linux
- Process list cache shared between detectors to avoid duplicate `tasklist`/`pgrep` calls

## Security Considerations

- No account, cloud API, telemetry upload or auto-updater; the app only contacts hosts the user configured or downloads they started (`docs/network-allowlist.md`)
- Self-hosted API keys (6 secrets) encrypted at rest with a master key held in the OS keychain (Keychain / Credential Manager / Secret Service via `@napi-rs/keyring`, Electron `safeStorage` as fallback), stored as per-key files in `userData/secure-keys/`
- Plain HTTP endpoints are refused for public hosts (`isSecureHttpEndpoint`)
- Context isolation enabled
- No remote code execution
- Sanitized file paths
- Limited IPC surface area

## Future Enhancements to Consider

- LAN streaming speech-to-text and embeddings endpoints (these still run on-device)
- Custom wake word detection
- ~~Multi-language UI~~ (implemented — 11 languages via react-i18next)
- Batch transcription
- Export formats beyond clipboard
