import React, { Suspense, useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { Button } from "./ui/button";
import { PAGE_CONTENT_WIDTH_CLASS } from "./ui/pageWidth";
import { cn } from "./lib/utils";
import { Zap } from "./icons";
import PostMigrationOnboarding from "./PostMigrationOnboarding";
import { ConfirmDialog, AlertDialog } from "./ui/dialog";
import { useDialogs } from "../hooks/useDialogs";
import { useHotkey } from "../hooks/useHotkey";
import { useToast } from "./ui/useToast";
import { useSettings } from "../hooks/useSettings";
import { useCollapsibleSidebar } from "../hooks/useCollapsibleSidebar";
import {
  useTranscriptions,
  useShowDiscarded,
  initializeTranscriptions,
  removeTranscription as removeFromStore,
  updateTranscription as updateInStore,
  clearTranscriptions as clearStore,
} from "../stores/transcriptionStore";
import { getSettings, useSettingsStore } from "../stores/settingsStore";
import {
  useIsMeetingMode,
  useIsNarrowWindow,
  useMeetingRecordingStore,
} from "../stores/meetingRecordingStore";
import ControlPanelSidebar from "./ControlPanelSidebar";
import ControlPanelTopBar from "./ControlPanelTopBar";
import { useControlPanelNavItems, type ControlPanelView } from "./controlPanelNav";
import MeetingRecordingMount from "./MeetingRecordingMount";
import MeetingRecordingPill from "./notes/MeetingRecordingPill";
import NewNoteMenu from "./notes/NewNoteMenu";

import { getCachedPlatform } from "../utils/platform";
import { isAccessibilitySkipped } from "../utils/permissions";
import { useGpuBannerAvailability } from "../hooks/useGpuBannerAvailability";
import { useCreateNote } from "../hooks/useCreateNote";
import {
  setActiveNoteId,
  setActiveFolderId,
  navigateToContainer,
  useActiveNoteId,
  initializeNotes,
} from "../stores/noteStore";
import {
  executeTranslationChain,
  hasTextContent,
  shouldRunTranslateStep,
} from "../helpers/translationChain";
import { applyChineseScript, resolveChineseScriptTarget } from "../utils/chineseScript";
import { getAgentName } from "../utils/agentName";
import HistoryView from "./HistoryView";
import BackgroundActionToastListener from "./notes/BackgroundActionToastListener";
import logger from "../utils/logger";

const platform = getCachedPlatform();

const SIDEBAR_WIDTH_PX = 192;

const SettingsModal = React.lazy(() => import("./SettingsModal"));
const PersonalNotesView = React.lazy(() => import("./notes/PersonalNotesView"));
const InsightsView = React.lazy(() => import("./InsightsView"));
const DictionaryView = React.lazy(() => import("./DictionaryView"));
const UploadAudioView = React.lazy(() => import("./notes/UploadAudioView"));
const IntegrationsView = React.lazy(() => import("./IntegrationsView"));
const ChatView = React.lazy(() => import("./chat/ChatView"));
const CommandSearch = React.lazy(() => import("./CommandSearch"));

interface ControlPanelProps {
  /** Open the settings modal at this section on mount (e.g. after onboarding). */
  initialSettingsSection?: string;
}

export default function ControlPanel({ initialSettingsSection }: ControlPanelProps = {}) {
  const { t } = useTranslation();
  const history = useTranscriptions();
  const [isLoading, setIsLoading] = useState(true);
  const [showSettings, setShowSettings] = useState(!!initialSettingsSection);
  const [showPostMigration, setShowPostMigration] = useState(false);
  const [settingsSection, setSettingsSection] = useState<string | undefined>(
    initialSettingsSection
  );
  const [aiCTADismissed, setAiCTADismissed] = useState(
    () => localStorage.getItem("aiCTADismissed") === "true"
  );
  const [showSearch, setShowSearch] = useState(false);
  const showDiscarded = useShowDiscarded();
  const [activeView, setActiveView] = useState<ControlPanelView>("home");
  const navItems = useControlPanelNavItems();
  const {
    collapsed: sidebarCollapsed,
    peek: sidebarPeek,
    toggle: toggleSidebar,
    showPeek: showSidebarPeek,
    hidePeek: hideSidebarPeek,
    leaveToggle: leaveSidebarToggle,
  } = useCollapsibleSidebar();
  const isMeetingMode = useIsMeetingMode();
  const isNarrowWindow = useIsNarrowWindow();
  const activeNoteId = useActiveNoteId();
  const isSidePanelLayout =
    isMeetingMode || (isNarrowWindow && activeView === "personal-notes" && activeNoteId != null);
  const recordingNoteId = useMeetingRecordingStore((s) => s.recordingNoteId);
  const recordingFolderId = useMeetingRecordingStore((s) => s.recordingFolderId);
  const [meetingRecordingRequest, setMeetingRecordingRequest] = useState<{
    noteId: number;
    folderId: number;
    event: any;
  } | null>(null);
  const [gpuBannerDismissed, setGpuBannerDismissed] = useState(
    () => localStorage.getItem("gpuBannerDismissedUnified") === "true"
  );
  const { hotkey } = useHotkey();
  const { toast } = useToast();
  const { useCleanupModel } = useSettings();

  const { createNote } = useCreateNote();
  // The note is created before the view switches so Notes mounts with it already open.
  const handleNewNote = useCallback(async () => {
    await createNote();
    setActiveView("personal-notes");
  }, [createNote]);
  const gpuBannerSettings = useSettingsStore(
    useShallow((settings) => ({
      useLocalWhisper: settings.useLocalWhisper,
      localTranscriptionProvider: settings.localTranscriptionProvider,
      useCleanupModel: settings.useCleanupModel,
      cleanupMode: settings.cleanupMode,
      useDictationAgent: settings.useDictationAgent,
      dictationAgentMode: settings.dictationAgentMode,
    }))
  );
  const gpuAccelAvailable = useGpuBannerAvailability({
    settings: gpuBannerSettings,
    dismissed: gpuBannerDismissed,
    settingsOpen: showSettings,
    platform,
  });

  const {
    confirmDialog,
    alertDialog,
    showConfirmDialog,
    showAlertDialog,
    hideConfirmDialog,
    hideAlertDialog,
  } = useDialogs();

  const loadTranscriptions = useCallback(
    async (includeDiscarded?: boolean) => {
      try {
        setIsLoading(true);
        await initializeTranscriptions(undefined, includeDiscarded);
      } catch {
        showAlertDialog({
          title: t("controlPanel.history.couldNotLoadTitle"),
          description: t("controlPanel.history.couldNotLoadDescription"),
        });
      } finally {
        setIsLoading(false);
      }
    },
    [showAlertDialog, t]
  );

  useEffect(() => {
    loadTranscriptions();
  }, [loadTranscriptions]);

  useEffect(() => {
    const { noteFilesEnabled, noteFilesPath } = useSettingsStore.getState();
    if (!noteFilesEnabled) return;
    window.electronAPI?.noteFilesSetEnabled?.(true, noteFilesPath || undefined, {
      skipRebuild: true,
    });
  }, []);

  useEffect(() => {
    if (platform !== "darwin") return;
    window.electronAPI?.getPostMigrationState?.().then((state) => {
      if (state?.justMigrated) setShowPostMigration(true);
    });
  }, []);

  const dismissPostMigrationPermanently = useCallback(async () => {
    await window.electronAPI?.markBundleMigrated?.();
    setShowPostMigration(false);
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const mod = platform === "darwin" ? e.metaKey : e.ctrlKey;
      if (mod && e.key === "k") {
        e.preventDefault();
        setShowSearch(true);
      } else if (mod && e.key === ",") {
        e.preventDefault();
        setShowSettings(true);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  useEffect(() => {
    const drain = async () => {
      const data = await window.electronAPI?.getPendingMeetingNoteNavigation?.();
      if (!data) return;
      setActiveFolderId(data.folderId);
      setActiveNoteId(data.noteId);
      setActiveView("personal-notes");
      setMeetingRecordingRequest({
        noteId: data.noteId,
        folderId: data.folderId,
        event: data.event,
      });
      initializeNotes(null, 50, data.folderId);
      if (
        data.trigger === "hotkey" &&
        useSettingsStore.getState().meetingHotkeyLayoutMode === "side-panel"
      ) {
        window.electronAPI?.snapToMeetingMode?.();
      }
    };
    drain();
    const cleanup = window.electronAPI?.onMeetingNoteNavigationPending?.(drain);
    return () => cleanup?.();
  }, []);

  useEffect(() => {
    const drain = async () => {
      const data = await window.electronAPI?.getPendingNoteNavigation?.();
      if (!data) return;
      if (data.folderId) {
        setActiveFolderId(data.folderId);
        initializeNotes(null, 50, data.folderId);
      }
      setActiveNoteId(data.noteId);
      setActiveView("personal-notes");
    };
    drain();
    const cleanup = window.electronAPI?.onNoteNavigationPending?.(drain);
    return () => cleanup?.();
  }, []);

  useEffect(() => {
    const cleanup = window.electronAPI?.onShowSettings?.(() => {
      setShowSettings(true);
    });
    return () => cleanup?.();
  }, []);

  // When accessibility is missing on macOS, open the permissions settings page
  useEffect(() => {
    const cleanup = window.electronAPI?.onAccessibilityMissing?.(async () => {
      if (isAccessibilitySkipped()) return;
      const migration = await window.electronAPI?.getPostMigrationState?.();
      if (migration?.justMigrated) return;
      setSettingsSection("privacyData");
      setShowSettings(true);
      toast({
        title: t("controlPanel.accessibilityMissing.title"),
        description: t("controlPanel.accessibilityMissing.description"),
        duration: 10000,
      });
    });
    return () => cleanup?.();
  }, [toast, t]);

  const handleMeetingRecordingRequestHandled = useCallback(
    () => setMeetingRecordingRequest(null),
    []
  );

  // The side-panel layout is shared by meeting mode and by a note opened in a
  // narrow window, so leaving it means different things in each case.
  const handleExitSidePanel = useCallback(() => {
    if (isMeetingMode) window.electronAPI?.restoreFromMeetingMode?.();
    else setActiveNoteId(null);
  }, [isMeetingMode]);

  const copyToClipboard = useCallback(
    async (text: string) => {
      try {
        await navigator.clipboard.writeText(text);
        toast({
          title: t("controlPanel.history.copiedTitle"),
          description: t("controlPanel.history.copiedDescription"),
          variant: "success",
          duration: 2000,
        });
      } catch (err) {
        toast({
          title: t("controlPanel.history.couldNotCopyTitle"),
          description: t("controlPanel.history.couldNotCopyDescription"),
          variant: "destructive",
        });
      }
    },
    [toast, t]
  );

  const deleteTranscription = useCallback(
    async (id: number) => {
      showConfirmDialog({
        title: t("controlPanel.history.deleteTitle"),
        description: t("controlPanel.history.deleteDescription"),
        onConfirm: async () => {
          try {
            const result = await window.electronAPI.deleteTranscription(id);
            if (result.success) {
              removeFromStore(id);
            } else {
              showAlertDialog({
                title: t("controlPanel.history.couldNotDeleteTitle"),
                description: t("controlPanel.history.couldNotDeleteDescription"),
              });
            }
          } catch {
            showAlertDialog({
              title: t("controlPanel.history.couldNotDeleteTitle"),
              description: t("controlPanel.history.couldNotDeleteDescriptionGeneric"),
            });
          }
        },
        variant: "destructive",
      });
    },
    [showConfirmDialog, showAlertDialog, t]
  );

  const clearAllTranscriptions = useCallback(() => {
    showConfirmDialog({
      title: t("controlPanel.history.clearAllTitle"),
      description: t("controlPanel.history.clearAllDescription"),
      onConfirm: async () => {
        try {
          const result = await window.electronAPI.clearTranscriptions();
          if (result.success) {
            clearStore();
            toast({
              title: t("controlPanel.history.clearAllSuccess"),
              variant: "success",
              duration: 2000,
            });
          } else {
            showAlertDialog({
              title: t("controlPanel.history.clearAllErrorTitle"),
              description: t("controlPanel.history.clearAllErrorDescription"),
            });
          }
        } catch {
          showAlertDialog({
            title: t("controlPanel.history.clearAllErrorTitle"),
            description: t("controlPanel.history.clearAllErrorDescription"),
          });
        }
      },
      variant: "destructive",
    });
  }, [showConfirmDialog, showAlertDialog, toast, t]);

  const showAudioInFolder = useCallback(
    async (id: number) => {
      try {
        const result = await window.electronAPI.showAudioInFolder(id);
        if (!result?.success) {
          toast({
            title: t("controlPanel.history.audioNotFound"),
            variant: "destructive",
          });
        }
      } catch {
        toast({
          title: t("controlPanel.history.audioNotFound"),
          variant: "destructive",
        });
      }
    },
    [toast, t]
  );

  const retryTranscription = useCallback(
    async (id: number, options?: { isRecover?: boolean }) => {
      try {
        const s = getSettings();
        const result = await window.electronAPI.retryTranscription(id, {
          useLocalWhisper: s.useLocalWhisper,
          localTranscriptionProvider: s.localTranscriptionProvider,
          parakeetModel: s.parakeetModel,
          cohereModel: s.cohereModel,
          whisperModel: s.whisperModel,
          preferredLanguage: s.preferredLanguage,
          transcriptionMode: s.transcriptionMode,
          remoteTranscriptionType: s.remoteTranscriptionType,
          remoteTranscriptionUrl: s.remoteTranscriptionUrl,
          remoteTranscriptionModel: s.remoteTranscriptionModel,
        });
        if (result.success && result.transcription) {
          const rawText = result.transcription.text;
          let finalTranscription = result.transcription;

          // A translation dictation must re-run cleanup-then-translate on retry, not plain cleanup.
          let handledTranslation = false;
          let translationApplied = false;
          if (result.transcription.route_kind === "translation") {
            handledTranslation = true;
            try {
              const [
                { default: ReasoningService },
                { resolveReasoningRoute },
                { getEffectiveCleanupModel, getSettings: getEffectiveSettings },
              ] = await Promise.all([
                import("../services/ReasoningService"),
                import("../helpers/audioManager"),
                import("../stores/settingsStore"),
              ]);
              const settings = getEffectiveSettings();
              const agentName = getAgentName();
              const route = resolveReasoningRoute(rawText, settings, agentName, false, true);
              if (route.kind === "translation") {
                const { text, translated } = await executeTranslationChain({
                  text: rawText,
                  cleanupReachable: route.cleanupReachable,
                  runCleanup: (currentText: string) =>
                    ReasoningService.processText(
                      currentText,
                      getEffectiveCleanupModel(),
                      agentName,
                      route.cleanupConfig
                    ),
                  runTranslate: (currentText: string) =>
                    ReasoningService.processText(currentText, route.model, agentName, route.config),
                  shouldTranslate: shouldRunTranslateStep(
                    settings.translationSourceLanguage,
                    settings.translationTargetLanguage
                  ),
                  onCleanupError: (cleanupError: Error & { messageKey?: string }) => {
                    logger.warn(
                      "Cleanup step failed in translation chain, translating raw transcript",
                      { error: cleanupError.message },
                      "transcription"
                    );
                    // The chain still translates the raw transcript, so say why cleanup
                    // was dropped rather than reporting a clean success (#2091).
                    toast({
                      title: t("app.toasts.cleanupFailed.title"),
                      description: cleanupError.messageKey
                        ? t(cleanupError.messageKey)
                        : cleanupError.message,
                      variant: "destructive",
                    });
                  },
                  onEmptyTranslate: () =>
                    logger.warn(
                      "Translation step returned empty text, keeping previous text",
                      {},
                      "transcription"
                    ),
                  onUnchangedTranslate: () =>
                    logger.warn(
                      "Translation step returned unchanged text, keeping source text",
                      {},
                      "transcription"
                    ),
                });
                translationApplied = translated;
                if (text !== rawText) {
                  const updated = await window.electronAPI.updateTranscriptionText(
                    id,
                    text,
                    rawText
                  );
                  if (updated.success && updated.transcription) {
                    finalTranscription = updated.transcription;
                  }
                }
              } else {
                // Translation disabled/unreachable since recording — fall through to cleanup.
                handledTranslation = false;
              }
            } catch {
              // Reasoning failed — keep the raw STT result
            }
          }

          // Apply AI reasoning if enabled
          if (!handledTranslation && useCleanupModel) {
            try {
              const [{ default: ReasoningService }, { selectResolvedLLMConfig, getSettings }] =
                await Promise.all([
                  import("../services/ReasoningService"),
                  import("../stores/settingsStore"),
                ]);
              const cleanup = selectResolvedLLMConfig(getSettings(), "dictationCleanup");
              const model = cleanup.model;
              // A self-hosted server picks its default model when none is named.
              if (cleanup.mode === "self-hosted" ? !!cleanup.remoteUrl?.trim() : !!model) {
                const agentName = getAgentName();
                const reasonedText = await ReasoningService.processText(rawText, model, agentName, {
                  disableThinking: getSettings().cleanupDisableThinking,
                  requireCompleteOutput: true,
                });
                if (hasTextContent(reasonedText) && reasonedText !== rawText) {
                  const updated = await window.electronAPI.updateTranscriptionText(
                    id,
                    reasonedText,
                    rawText
                  );
                  if (updated.success && updated.transcription) {
                    finalTranscription = updated.transcription;
                  }
                }
              }
            } catch (cleanupError) {
              // The row keeps its raw transcript, so the retry must not look like it
              // cleaned anything — report why, the way dictation does (#2091).
              const failure = cleanupError as Error & { messageKey?: string };
              toast({
                title: t("app.toasts.cleanupFailed.title"),
                description: failure.messageKey ? t(failure.messageKey) : failure.message,
                variant: "destructive",
              });
            }
          }

          // Deterministic Chinese script pass, mirroring dictation (#975). Runs last so
          // it covers the cleaned/translated text, or the raw transcript when neither ran.
          // Same rule as audioManager.getEffectiveOutputLanguage: only a completed
          // translate step moves the text into the target language, so anything else
          // still has to be scripted as the language that was dictated.
          try {
            const outputLanguage =
              result.transcription.route_kind === "translation"
                ? (translationApplied
                    ? s.translationTargetLanguage
                    : s.translationSourceLanguage) || "auto"
                : s.preferredLanguage;
            const scripted = await applyChineseScript(
              finalTranscription.text,
              resolveChineseScriptTarget(
                outputLanguage,
                s.chineseScriptPreference,
                finalTranscription.text
              )
            );
            if (scripted !== finalTranscription.text) {
              const updated = await window.electronAPI.updateTranscriptionText(
                id,
                scripted,
                rawText
              );
              if (updated.success && updated.transcription) {
                finalTranscription = updated.transcription;
              }
            }
          } catch {
            // Conversion failed — keep the text as transcribed
          }

          updateInStore(finalTranscription);
          toast({
            title: t(
              options?.isRecover
                ? "controlPanel.history.discarded.recovered"
                : "controlPanel.history.retrySuccess"
            ),
          });
        } else {
          toast({
            title: t("controlPanel.history.retryError"),
            description: result.messageKey ? t(result.messageKey) : result.error,
            variant: "destructive",
          });
        }
      } catch {
        toast({
          title: t("controlPanel.history.retryError"),
          variant: "destructive",
        });
      }
    },
    [toast, t, useCleanupModel]
  );

  const toggleShowDiscarded = useCallback(() => {
    loadTranscriptions(!showDiscarded);
  }, [loadTranscriptions, showDiscarded]);

  return (
    <div className="h-screen bg-surface-window flex flex-col">
      <MeetingRecordingMount />
      <MeetingRecordingPill
        activeView={activeView}
        activeNoteId={activeNoteId}
        onReturnToNote={() => {
          setActiveView("personal-notes");
          setActiveFolderId(recordingFolderId);
          setActiveNoteId(recordingNoteId);
        }}
      />
      <ConfirmDialog
        open={confirmDialog.open}
        onOpenChange={hideConfirmDialog}
        title={confirmDialog.title}
        description={confirmDialog.description}
        onConfirm={confirmDialog.onConfirm}
        variant={confirmDialog.variant}
      />

      <AlertDialog
        open={alertDialog.open}
        onOpenChange={hideAlertDialog}
        title={alertDialog.title}
        description={alertDialog.description}
        onOk={() => {}}
      />

      <PostMigrationOnboarding
        open={showPostMigration}
        onOpenChange={setShowPostMigration}
        onDone={dismissPostMigrationPermanently}
      />

      {showSettings && (
        <Suspense fallback={null}>
          <SettingsModal
            open={showSettings}
            onOpenChange={(open) => {
              setShowSettings(open);
              if (!open) setSettingsSection(undefined);
            }}
            initialSection={settingsSection}
          />
        </Suspense>
      )}

      {/* Always mounted so the palette chunk is warm and Radix can play its exit animation. */}
      <Suspense fallback={null}>
        <CommandSearch
          open={showSearch}
          onOpenChange={setShowSearch}
          transcriptions={history}
          onNoteSelect={(id, folderId, spaceId) => {
            if (folderId != null) setActiveFolderId(folderId);
            else if (spaceId != null) navigateToContainer(spaceId, null);
            setActiveNoteId(id);
            setActiveView("personal-notes");
          }}
          onContainerSelect={(spaceId, folderId) => {
            navigateToContainer(spaceId, folderId);
            setActiveView("personal-notes");
          }}
          onTranscriptSelect={() => {
            setActiveView("home");
          }}
        />
      </Suspense>

      <div className="flex flex-1 overflow-hidden relative">
        <div
          className="shrink-0 transition-[width] duration-300 ease-out"
          style={{ width: sidebarCollapsed || isSidePanelLayout ? 0 : SIDEBAR_WIDTH_PX }}
        />
        <div
          className={`absolute inset-y-0 start-0 z-30 transition-transform duration-300 ease-out ${
            !isSidePanelLayout && (!sidebarCollapsed || sidebarPeek)
              ? "translate-x-0"
              : "ltr:-translate-x-full rtl:translate-x-full"
          }${
            sidebarCollapsed && sidebarPeek && !isSidePanelLayout
              ? " shadow-[10px_0_40px_-18px_rgba(0,0,0,0.2)] rtl:shadow-[-10px_0_40px_-18px_rgba(0,0,0,0.2)]"
              : ""
          }`}
          onMouseEnter={sidebarCollapsed ? showSidebarPeek : undefined}
          onMouseLeave={sidebarCollapsed ? hideSidebarPeek : undefined}
        >
          <ControlPanelSidebar
            activeView={activeView}
            onViewChange={setActiveView}
            onOpenSettings={() => {
              setSettingsSection(undefined);
              setShowSettings(true);
            }}
          />
        </div>
        <main className="flex-1 flex flex-col overflow-hidden p-2">
          <div className="flex min-h-0 flex-1 flex-col overflow-clip rounded-(--radius-shell) border border-border bg-background dark:border-white/10">
            <ControlPanelTopBar
              title={navItems.find((item) => item.id === activeView)?.label ?? ""}
              sidebarCollapsed={sidebarCollapsed}
              onToggleSidebar={toggleSidebar}
              onToggleMouseEnter={sidebarCollapsed ? showSidebarPeek : undefined}
              onToggleMouseLeave={sidebarCollapsed ? leaveSidebarToggle : undefined}
              onOpenSearch={() => setShowSearch(true)}
              isSidePanelLayout={isSidePanelLayout}
              onExitSidePanel={handleExitSidePanel}
              actions={
                <NewNoteMenu onNewNote={handleNewNote} onNewChat={() => setActiveView("chat")} />
              }
            />
            <div className="scrollbar-hidden flex-1 overflow-y-auto">
              {(gpuAccelAvailable.transcription || gpuAccelAvailable.intelligence) &&
                activeView === "home" &&
                !gpuBannerDismissed && (
                  <div className={cn(PAGE_CONTENT_WIDTH_CLASS, "px-6 mb-3")}>
                    <div className="rounded-lg border border-primary/20 dark:border-primary/15 bg-primary/5 p-3">
                      <div className="flex items-start gap-3">
                        <div className="shrink-0 w-8 h-8 rounded-md bg-primary/10 dark:bg-primary/15 flex items-center justify-center">
                          <Zap size={16} className="text-primary" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-xs font-medium text-foreground mb-0.5">
                            {t("controlPanel.gpu.bannerTitle")}
                          </p>
                          <p className="text-xs text-muted-foreground mb-2">
                            {t("controlPanel.gpu.bannerDescription")}
                          </p>
                          <div className="flex items-center gap-3">
                            <Button
                              variant="default"
                              size="sm"
                              className="h-7 text-xs"
                              onClick={() => {
                                setSettingsSection(
                                  gpuAccelAvailable.transcription
                                    ? "transcription"
                                    : gpuAccelAvailable.intelligence === "dictationAgent"
                                      ? "dictationAgent"
                                      : "intelligence"
                                );
                                setShowSettings(true);
                              }}
                            >
                              {t("controlPanel.gpu.enableButton")}
                            </Button>
                            <button
                              onClick={() => {
                                setGpuBannerDismissed(true);
                                localStorage.setItem("gpuBannerDismissedUnified", "true");
                              }}
                              className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                            >
                              {t("controlPanel.gpu.dismissButton")}
                            </button>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              {activeView === "home" && (
                <HistoryView
                  history={history}
                  isLoading={isLoading}
                  hotkey={hotkey}
                  aiCTADismissed={aiCTADismissed}
                  setAiCTADismissed={setAiCTADismissed}
                  useCleanupModel={useCleanupModel}
                  copyToClipboard={copyToClipboard}
                  deleteTranscription={deleteTranscription}
                  clearAllTranscriptions={clearAllTranscriptions}
                  onShowAudioInFolder={showAudioInFolder}
                  onRetryTranscription={retryTranscription}
                  showDiscarded={showDiscarded}
                  onToggleDiscarded={toggleShowDiscarded}
                  onOpenSettings={(section) => {
                    setSettingsSection(section);
                    setShowSettings(true);
                  }}
                  onOpenIntegrations={() => setActiveView("integrations")}
                />
              )}
              {activeView === "insights" && (
                <Suspense fallback={null}>
                  <InsightsView />
                </Suspense>
              )}
              {activeView === "chat" && (
                <Suspense fallback={null}>
                  <ChatView />
                </Suspense>
              )}
              {activeView === "personal-notes" && (
                <Suspense fallback={null}>
                  <PersonalNotesView
                    onOpenSettings={(section) => {
                      setSettingsSection(section);
                      setShowSettings(true);
                    }}
                    meetingRecordingRequest={meetingRecordingRequest}
                    onMeetingRecordingRequestHandled={handleMeetingRecordingRequestHandled}
                  />
                </Suspense>
              )}
              {activeView === "dictionary" && (
                <Suspense fallback={null}>
                  <DictionaryView />
                </Suspense>
              )}
              {activeView === "upload" && (
                <Suspense fallback={null}>
                  <UploadAudioView
                    onNoteCreated={(noteId, folderId) => {
                      setActiveNoteId(noteId);
                      if (folderId) setActiveFolderId(folderId);
                      setActiveView("personal-notes");
                    }}
                    onOpenSettings={(section) => {
                      setSettingsSection(section);
                      setShowSettings(true);
                    }}
                  />
                </Suspense>
              )}
              {activeView === "integrations" && (
                <Suspense fallback={null}>
                  <IntegrationsView />
                </Suspense>
              )}
            </div>
          </div>
        </main>
      </div>
      <BackgroundActionToastListener />
    </div>
  );
}
