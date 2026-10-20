import { useState, useEffect, useCallback, useMemo, useRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./ui/button";
import { Download, Trash2, X, Zap, Check, CircleAlert } from "./icons";
import { ProviderIcon } from "./ui/ProviderIcon";
import { ProviderTabs } from "./ui/ProviderTabs";
import { DownloadProgressBar } from "./ui/DownloadProgressBar";
import { ConfirmDialog } from "./ui/dialog";
import { useDialogs } from "../hooks/useDialogs";
import { useModelDownload, type DownloadProgress } from "../hooks/useModelDownload";
import {
  WHISPER_MODEL_INFO,
  PARAKEET_MODEL_INFO,
  isSherpaLocalProvider,
} from "../models/ModelRegistry";
import {
  MODEL_PICKER_COLORS,
  type ColorScheme,
  type ModelPickerStyles,
} from "../utils/modelPickerStyles";
import {
  LOCAL_ASR_ORGANIZATIONS,
  getASRModelOrganization,
  getSelectedASROrganization,
  usesParakeetManager,
} from "../helpers/localASROrganization";
import { createExternalLinkHandler } from "../utils/externalLinks";
import { getCachedPlatform } from "../utils/platform";
import { pickWhisperGpuBackend } from "../utils/whisperGpuPack";
import logger from "../utils/logger";
import type { ParakeetCheckResult } from "../types/electron";

interface LocalModel {
  model: string;
  size_mb?: number;
  downloaded?: boolean;
}

interface LocalModelCardProps {
  modelId: string;
  name: string;
  description: string;
  size: string;
  actualSizeMb?: number;
  isSelected: boolean;
  isDownloaded: boolean;
  isDownloading: boolean;
  isCancelling: boolean;
  isInstalling: boolean;
  recommended?: boolean;
  provider: string;
  languageLabel?: string;
  modelCardUrl?: string;
  onSelect: () => void;
  onDelete: () => void;
  onDownload: () => void;
  onCancel: () => void;
  styles: ModelPickerStyles;
}

function LocalModelCard({
  modelId,
  name,
  description,
  size,
  actualSizeMb,
  isSelected,
  isDownloaded,
  isDownloading,
  isCancelling,
  isInstalling,
  recommended,
  provider,
  languageLabel,
  modelCardUrl,
  onSelect,
  onDelete,
  onDownload,
  onCancel,
  styles: cardStyles,
}: LocalModelCardProps) {
  const { t } = useTranslation();
  const handleClick = () => {
    if (isDownloaded && !isSelected) {
      onSelect();
    }
  };

  return (
    <div
      onClick={handleClick}
      className={`relative w-full text-start overflow-hidden rounded-md border transition-colors duration-200 group ${
        isSelected ? cardStyles.modelCard.selected : cardStyles.modelCard.default
      } ${isDownloaded && !isSelected ? "cursor-pointer" : ""}`}
    >
      <div className="flex items-center gap-1.5 p-2">
        <div className="shrink-0">
          {isDownloaded ? (
            <div
              className={`w-1.5 h-1.5 rounded-full ${
                isSelected
                  ? "bg-primary shadow-[0_0_6px_oklch(0.62_0.22_260/0.6)] animate-[pulse-glow_2s_ease-in-out_infinite]"
                  : "bg-success shadow-[0_0_4px_rgba(34,197,94,0.5)]"
              }`}
            />
          ) : isDownloading ? (
            <div className="w-1.5 h-1.5 rounded-full bg-amber-500 shadow-[0_0_4px_rgba(245,158,11,0.5)] animate-[spinner-rotate_1s_linear_infinite]" />
          ) : (
            <div className="w-1.5 h-1.5 rounded-full bg-muted-foreground/20" />
          )}
        </div>

        <div className="flex-1 min-w-0 flex items-center gap-1.5">
          <ProviderIcon provider={provider} className="w-3.5 h-3.5 shrink-0" />
          <span className="font-semibold text-sm text-foreground truncate tracking-tight">
            {name}
          </span>
          <span className="text-xs text-muted-foreground/70 tabular-nums shrink-0">
            {actualSizeMb ? `${actualSizeMb}MB` : size}
          </span>
          {recommended && (
            <span className={cardStyles.badges.recommended}>{t("common.recommended")}</span>
          )}
          {languageLabel && (
            <span className="text-xs text-muted-foreground/70 font-medium shrink-0">
              {languageLabel}
            </span>
          )}
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          {isDownloaded ? (
            <>
              {isSelected && (
                <span className="text-xs font-medium text-primary px-2 py-0.5 bg-primary/10 rounded-sm">
                  {t("common.active")}
                </span>
              )}
              <Button
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete();
                }}
                size="icon"
                variant="ghost"
                className="size-6 text-muted-foreground/70 hover:text-destructive opacity-0 group-hover:opacity-100 transition-[color,opacity,transform] active:scale-95"
              >
                <Trash2 size={12} />
              </Button>
            </>
          ) : isDownloading ? (
            <Button
              onClick={(e) => {
                e.stopPropagation();
                onCancel();
              }}
              disabled={isCancelling || isInstalling}
              size="sm"
              variant="outline"
              className="h-6 px-2.5 text-xs text-destructive border-destructive/25 hover:bg-destructive/8"
            >
              <X size={11} className="me-0.5" />
              {isCancelling ? "..." : t("common.cancel")}
            </Button>
          ) : (
            <Button
              onClick={(e) => {
                e.stopPropagation();
                onDownload();
              }}
              size="sm"
              variant="default"
              className="h-6 px-2.5 text-xs"
            >
              <Download size={11} className="me-1" />
              {t("common.download")}
            </Button>
          )}
        </div>
      </div>
      {modelCardUrl && (
        <a
          href={modelCardUrl}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(event) => {
            event.stopPropagation();
            createExternalLinkHandler(modelCardUrl)(event);
          }}
          className="inline-block ms-7 mb-2 text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
        >
          {t("transcription.modelCard")}
        </a>
      )}
    </div>
  );
}

interface TranscriptionModelPickerProps {
  selectedLocalModel: string;
  onLocalModelSelect: (modelId: string, providerId?: string) => void;
  selectedLocalProvider?: string;
  onLocalProviderSelect?: (providerId: string) => void;
  className?: string;
  variant?: "onboarding" | "settings";
}

const LOCAL_PROVIDER_TABS: Array<{ id: string; name: string; disabled?: boolean }> =
  LOCAL_ASR_ORGANIZATIONS;

interface GpuWarningRowProps {
  title: string;
  description: string;
  actionLabel: string;
  onAction: () => void;
  onRemove: () => void;
  children?: ReactNode;
}

function GpuWarningRow({
  title,
  description,
  actionLabel,
  onAction,
  onRemove,
  children,
}: GpuWarningRowProps) {
  const { t } = useTranslation();
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="flex min-w-0 items-start gap-2">
        <CircleAlert size={15} className="mt-0.5 shrink-0 text-warning" />
        <div className="min-w-0">
          <p className="text-xs font-medium text-foreground">{title}</p>
          <p className="mt-0.5 text-xs leading-snug text-muted-foreground">{description}</p>
          {children}
          <Button onClick={onAction} size="sm" className="mt-2 h-7 px-3 text-xs">
            {actionLabel}
          </Button>
        </div>
      </div>
      <Button
        onClick={onRemove}
        size="sm"
        variant="ghost"
        className="h-6 shrink-0 px-2 text-xs text-muted-foreground hover:text-destructive"
      >
        {t("gpu.remove")}
      </Button>
    </div>
  );
}

export default function TranscriptionModelPicker({
  selectedLocalModel,
  onLocalModelSelect,
  selectedLocalProvider = "whisper",
  onLocalProviderSelect,
  className = "",
  variant = "settings",
}: TranscriptionModelPickerProps) {
  const { t } = useTranslation();
  const [localModels, setLocalModels] = useState<LocalModel[]>([]);
  const [parakeetModels, setParakeetModels] = useState<LocalModel[]>([]);
  const [parakeetCapability, setParakeetCapability] = useState<ParakeetCheckResult | null>(null);
  const [internalLocalProvider, setInternalLocalProvider] = useState(
    getSelectedASROrganization(selectedLocalProvider, selectedLocalModel)
  );
  const hasLoadedRef = useRef(false);
  const hasLoadedParakeetRef = useRef(false);
  const [gpuBackend, setGpuBackend] = useState<"cuda" | "vulkan" | null>(null);
  const [gpuDownloaded, setGpuDownloaded] = useState(false);
  const [gpuDownloading, setGpuDownloading] = useState(false);
  const [gpuProgress, setGpuProgress] = useState<DownloadProgress>({
    downloadedBytes: 0,
    totalBytes: 0,
    percentage: 0,
  });
  const [gpuDismissed, setGpuDismissed] = useState(false);
  // The pack fell back to CPU on this machine (persisted by main until retried)
  const [gpuFailed, setGpuFailed] = useState(false);
  // The whisper-server error line main saved with that failure (#1736)
  const [gpuFailReason, setGpuFailReason] = useState<string | null>(null);
  // An older release installed the pack and this version can't use it (#2424)
  const [gpuNeedsUpdate, setGpuNeedsUpdate] = useState(false);
  // Why the last pack download failed (cleared by the next attempt)
  const [gpuDownloadError, setGpuDownloadError] = useState<string | null>(null);
  // The running download was started before Settings was last opened, so no
  // pending call here will report its end: its status is polled instead
  const [gpuResumedDownload, setGpuResumedDownload] = useState(false);
  const gpuDownloadCancelledRef = useRef(false);
  // A server reload with the new backend is in flight (Vulkan cold starts are slow)
  const [gpuActivating, setGpuActivating] = useState(false);
  // Live truth from the running server; "active" is never inferred from a download
  const [gpuActive, setGpuActive] = useState(false);

  useEffect(() => {
    const organization = getSelectedASROrganization(selectedLocalProvider, selectedLocalModel);
    if (organization !== internalLocalProvider) {
      setInternalLocalProvider(organization);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sync prop→state: only re-run when the prop changes
  }, [selectedLocalProvider, selectedLocalModel]);

  useEffect(() => {
    let cancelled = false;

    window.electronAPI
      ?.checkParakeetInstallation?.()
      .then((capability) => {
        if (!cancelled) setParakeetCapability(capability);
      })
      .catch((error) => {
        logger.error("Failed to check Parakeet compatibility", { error }, "models");
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (parakeetCapability?.supported !== false) return;

    // Tabs are pure browse state, so the browsed tab and the committed
    // provider must each leave the sherpa tabs on their own: moving the tab off
    // the disabled entry keeps the UI usable, while committing "whisper"
    // is what actually reroutes transcription on unsupported Macs.
    if (usesParakeetManager(internalLocalProvider)) setInternalLocalProvider("whisper");
    if (isSherpaLocalProvider(selectedLocalProvider)) onLocalProviderSelect?.("whisper");
  }, [internalLocalProvider, onLocalProviderSelect, parakeetCapability, selectedLocalProvider]);

  const localModelsLoadQueueRef = useRef<Promise<void>>(Promise.resolve());
  const parakeetModelsLoadQueueRef = useRef<Promise<void>>(Promise.resolve());
  const loadLocalModelsRef = useRef<(() => Promise<void>) | null>(null);
  const loadParakeetModelsRef = useRef<(() => Promise<void>) | null>(null);
  const selectedLocalModelRef = useRef(selectedLocalModel);
  const onLocalModelSelectRef = useRef(onLocalModelSelect);

  const { confirmDialog, showConfirmDialog, hideConfirmDialog } = useDialogs();
  const colorScheme: ColorScheme = variant === "settings" ? "purple" : "blue";
  const styles = useMemo(() => MODEL_PICKER_COLORS[colorScheme], [colorScheme]);
  const localProviderTabs = useMemo(
    () =>
      LOCAL_PROVIDER_TABS.map((provider) =>
        usesParakeetManager(provider.id) && parakeetCapability?.supported === false
          ? {
              ...provider,
              disabled: true,
              disabledLabel: parakeetCapability.minimumMacOSVersion
                ? t("transcription.parakeet.requiresMacOS", {
                    version: parakeetCapability.minimumMacOSVersion,
                  })
                : t("transcription.parakeet.unavailable"),
            }
          : provider
      ),
    [parakeetCapability, t]
  );

  useEffect(() => {
    selectedLocalModelRef.current = selectedLocalModel;
  }, [selectedLocalModel]);
  useEffect(() => {
    onLocalModelSelectRef.current = onLocalModelSelect;
  }, [onLocalModelSelect]);

  const validateAndSelectModel = useCallback((loadedModels: LocalModel[]) => {
    const current = selectedLocalModelRef.current;
    if (!current) return;

    // The whisper list loads on a mere browse of the Whisper tab, so the
    // committed selection can be a foreign id (a Parakeet model while nvidia
    // is committed) — only replace ids this list owns.
    const currentEntry = loadedModels.find((m) => m.model === current);
    if (!currentEntry || currentEntry.downloaded) return;

    const downloaded = loadedModels.filter((m) => m.downloaded);
    onLocalModelSelectRef.current(downloaded[0]?.model ?? "", "whisper");
  }, []);

  const loadLocalModels = useCallback(() => {
    const load = async () => {
      try {
        const result = await window.electronAPI?.listWhisperModels();
        if (result?.success) {
          setLocalModels(result.models);
          validateAndSelectModel(result.models);
        }
      } catch (error) {
        logger.error("Failed to load models", { error }, "models");
        setLocalModels([]);
      }
    };

    const queuedLoad = localModelsLoadQueueRef.current.then(load);
    localModelsLoadQueueRef.current = queuedLoad;
    return queuedLoad;
  }, [validateAndSelectModel]);

  const loadParakeetModels = useCallback(() => {
    const load = async () => {
      try {
        const result = await window.electronAPI?.listParakeetModels();
        if (result?.success) {
          setParakeetModels(result.models);
        }
      } catch (error) {
        logger.error("Failed to load Parakeet models", { error }, "models");
        setParakeetModels([]);
      }
    };

    const queuedLoad = parakeetModelsLoadQueueRef.current.then(load);
    parakeetModelsLoadQueueRef.current = queuedLoad;
    return queuedLoad;
  }, []);

  useEffect(() => {
    loadLocalModelsRef.current = loadLocalModels;
  }, [loadLocalModels]);
  useEffect(() => {
    loadParakeetModelsRef.current = loadParakeetModels;
  }, [loadParakeetModels]);
  useEffect(() => {
    if (internalLocalProvider === "whisper" && !hasLoadedRef.current) {
      hasLoadedRef.current = true;
      loadLocalModelsRef.current?.();
    } else if (usesParakeetManager(internalLocalProvider) && !hasLoadedParakeetRef.current) {
      hasLoadedParakeetRef.current = true;
      loadParakeetModelsRef.current?.();
    }
  }, [internalLocalProvider]);

  useEffect(() => {
    const handleModelsCleared = () => {
      loadLocalModels();
      loadParakeetModels();
    };
    window.addEventListener("openwhispr-models-cleared", handleModelsCleared);
    return () => window.removeEventListener("openwhispr-models-cleared", handleModelsCleared);
  }, [loadLocalModels, loadParakeetModels]);

  const readGpuStatus = useCallback(async () => {
    try {
      const [cuda, vulkan] = await Promise.all([
        window.electronAPI?.getCudaWhisperStatus?.(),
        window.electronAPI?.getVulkanWhisperStatus?.(),
      ]);
      // No pack to show or offer hides the card. A re-read can land here after
      // another card removed the pack this one shows, so reset, never keep it.
      const backend = pickWhisperGpuBackend(cuda, vulkan);
      const status = backend === "cuda" ? cuda : backend === "vulkan" ? vulkan : null;
      setGpuBackend(backend);
      setGpuDownloaded(!!status?.downloaded);
      setGpuFailed(!!status?.gpuFailed);
      setGpuFailReason(status?.gpuFailReason ?? null);
      setGpuNeedsUpdate(!!status?.needsUpdate);
      // A failed attempt's error must not outlive the state it was about
      setGpuDownloadError(null);
      // A download is still running that no pending call here may report the
      // end of: one started before Settings was opened, or on another card
      if (status?.downloading) {
        setGpuDownloading(true);
        setGpuResumedDownload(true);
      }
    } catch {}
  }, []);

  useEffect(() => {
    if (internalLocalProvider !== "whisper") return;
    if (getCachedPlatform() === "darwin") return;
    readGpuStatus();
    // Retry on the fallback pop-up, or Remove on another card, changes the
    // packs or the saved failure while this card stays mounted (#1736)
    return window.electronAPI?.onWhisperGpuStatusChanged?.(readGpuStatus);
  }, [internalLocalProvider, readGpuStatus]);

  useEffect(() => {
    if (!gpuDownloading || !gpuBackend) return;
    const subscribe =
      gpuBackend === "cuda"
        ? window.electronAPI?.onCudaDownloadProgress
        : window.electronAPI?.onVulkanWhisperDownloadProgress;
    return subscribe?.((data) => setGpuProgress(data));
  }, [gpuDownloading, gpuBackend]);

  useEffect(() => {
    if (!gpuResumedDownload || !gpuBackend) return;
    const id = setInterval(async () => {
      try {
        const status =
          gpuBackend === "cuda"
            ? await window.electronAPI?.getCudaWhisperStatus?.()
            : await window.electronAPI?.getVulkanWhisperStatus?.();
        if (!status || status.downloading) return;
        setGpuResumedDownload(false);
        setGpuDownloading(false);
        setGpuDownloaded(status.downloaded);
        setGpuFailed(!!status.gpuFailed);
        setGpuNeedsUpdate(!!status.needsUpdate);
      } catch {}
    }, 1000);
    return () => clearInterval(id);
  }, [gpuResumedDownload, gpuBackend]);

  // Live server state: "GPU acceleration active" reflects what the server is
  // actually running on, not just that a pack is on disk (a crashed GPU server
  // silently falls back to CPU). Faster poll while an activation is in flight.
  // Polls again at once when a re-read switches the card to another pack.
  useEffect(() => {
    if (internalLocalProvider !== "whisper" || !gpuDownloaded) return;
    const poll = () => {
      window.electronAPI
        ?.whisperServerStatus?.()
        .then((status) => {
          setGpuActive(!!status?.gpuAccelerated);
          if (status?.gpuAccelerated) setGpuActivating(false);
        })
        .catch(() => {});
    };
    poll();
    const id = setInterval(poll, gpuActivating ? 1000 : 5000);
    return () => clearInterval(id);
  }, [internalLocalProvider, gpuDownloaded, gpuActivating, gpuBackend]);

  // Safety valve: a Vulkan cold start can take up to ~2 minutes (see #698);
  // past that the live status or a fallback notification settles the state.
  useEffect(() => {
    if (!gpuActivating) return;
    const timeout = setTimeout(() => setGpuActivating(false), 150_000);
    return () => clearTimeout(timeout);
  }, [gpuActivating]);

  // Main falls back to CPU (and remembers it) when a GPU server crashes. It
  // saves the failure before it notifies, so the re-read shows the pack main
  // now reports in use, exactly as reopening Settings would (#1736).
  useEffect(() => {
    const onFallback = () => {
      setGpuFailed(true);
      // Never show the previous failure's reason while the new one loads
      setGpuFailReason(null);
      setGpuActivating(false);
      setGpuActive(false);
      readGpuStatus();
    };
    const disposeCuda = window.electronAPI?.onCudaFallbackNotification?.(onFallback);
    const disposeVulkan = window.electronAPI?.onGpuFallbackNotification?.(onFallback);
    return () => {
      disposeCuda?.();
      disposeVulkan?.();
    };
  }, [readGpuStatus]);

  const handleGpuDownload = async () => {
    setGpuDownloading(true);
    setGpuDownloadError(null);
    gpuDownloadCancelledRef.current = false;
    try {
      const result =
        gpuBackend === "cuda"
          ? await window.electronAPI?.downloadCudaWhisperBinary?.()
          : await window.electronAPI?.downloadVulkanWhisperBinary?.();
      if (result?.success) {
        setGpuDownloaded(true);
        setGpuFailed(false);
        setGpuNeedsUpdate(false);
        // Main reloads the server with the new backend only when one is loaded;
        // otherwise the pack simply engages on the next dictation.
        setGpuActivating(!!result.willRestart);
      } else if (result && !gpuDownloadCancelledRef.current) {
        setGpuDownloadError(result.error ?? "");
      }
    } finally {
      setGpuDownloading(false);
    }
  };

  const handleGpuRetry = async () => {
    setGpuFailed(false);
    const result = await window.electronAPI?.whisperGpuRetry?.();
    setGpuActivating(!!result?.willRestart);
  };

  const handleGpuDelete = async () => {
    const result =
      gpuBackend === "cuda"
        ? await window.electronAPI?.deleteCudaWhisperBinary?.()
        : await window.electronAPI?.deleteVulkanWhisperBinary?.();
    if (result?.success) {
      setGpuDownloaded(false);
      setGpuFailed(false);
      setGpuNeedsUpdate(false);
      setGpuDownloadError(null);
      setGpuActivating(false);
      setGpuActive(false);
    }
  };

  const handleGpuCancel = async () => {
    gpuDownloadCancelledRef.current = true;
    if (gpuBackend === "cuda") await window.electronAPI?.cancelCudaWhisperDownload?.();
    else await window.electronAPI?.cancelVulkanWhisperDownload?.();
    setGpuDownloading(false);
  };

  const {
    downloads: whisperDownloads,
    downloadModel,
    deleteModel,
    isDownloadingModel,
    cancelDownload,
    isCancellingModel,
  } = useModelDownload({
    modelType: "whisper",
    onDownloadComplete: loadLocalModels,
  });

  const {
    downloads: parakeetDownloads,
    downloadModel: downloadParakeetModel,
    deleteModel: deleteParakeetModel,
    isDownloadingModel: isDownloadingParakeetModel,
    cancelDownload: cancelParakeetDownload,
    isCancellingModel: isCancellingParakeetModel,
  } = useModelDownload({
    modelType: "parakeet",
    onDownloadComplete: loadParakeetModels,
  });

  const handleLocalProviderChange = useCallback(
    (providerId: string) => {
      const tab = localProviderTabs.find((candidate) => candidate.id === providerId);
      if (tab?.disabled) return;
      setInternalLocalProvider(providerId);
    },
    [localProviderTabs]
  );

  const handleWhisperModelSelect = useCallback(
    (modelId: string) => {
      setInternalLocalProvider("whisper");
      onLocalProviderSelect?.("whisper");
      onLocalModelSelect(modelId, "whisper");
    },
    [onLocalModelSelect, onLocalProviderSelect]
  );

  const handleParakeetModelSelect = useCallback(
    (modelId: string) => {
      const organization = getASRModelOrganization(modelId);
      const provider = organization === "cohere" ? "cohere" : "nvidia";
      setInternalLocalProvider(organization);
      onLocalProviderSelect?.(provider);
      onLocalModelSelect(modelId, provider);
    },
    [onLocalModelSelect, onLocalProviderSelect]
  );

  const handleDelete = useCallback(
    (modelId: string) => {
      showConfirmDialog({
        title: t("transcription.deleteModel.title"),
        description: t("transcription.deleteModel.description"),
        onConfirm: async () => {
          await deleteModel(modelId, async () => {
            const result = await window.electronAPI?.listWhisperModels();
            if (result?.success) {
              setLocalModels(result.models);
              validateAndSelectModel(result.models);
            }
          });
        },
        variant: "destructive",
      });
    },
    [showConfirmDialog, deleteModel, validateAndSelectModel, t]
  );

  const progressDisplay = useMemo(() => {
    const activeDownloads = [
      ...Object.values(whisperDownloads),
      ...Object.values(parakeetDownloads),
    ];
    if (activeDownloads.length === 0) return null;

    return (
      <div className="space-y-2">
        {activeDownloads.map((status) => {
          const modelInfo =
            status.modelType === "whisper"
              ? WHISPER_MODEL_INFO[status.modelId]
              : PARAKEET_MODEL_INFO[status.modelId];
          return (
            <DownloadProgressBar
              key={`${status.modelType}:${status.modelId}`}
              modelName={modelInfo?.name || status.modelId}
              progress={{
                percentage: status.progress,
                downloadedBytes: status.downloadedBytes,
                totalBytes: status.totalBytes,
              }}
              isInstalling={status.phase === "installing"}
            />
          );
        })}
      </div>
    );
  }, [whisperDownloads, parakeetDownloads]);

  const renderLocalModels = () => {
    const modelsToRender =
      localModels.length === 0
        ? Object.entries(WHISPER_MODEL_INFO).map(([modelId, info]) => ({
            model: modelId,
            downloaded: false,
            size_mb: info.sizeMb,
          }))
        : localModels;

    return (
      <div className="space-y-0.5">
        {modelsToRender.map((model) => {
          const modelId = model.model;
          const info = WHISPER_MODEL_INFO[modelId] ?? {
            name: modelId,
            description: t("transcription.fallback.whisperModelDescription"),
            size: t("common.unknown"),
            recommended: false,
          };

          return (
            <LocalModelCard
              key={modelId}
              modelId={modelId}
              name={info.name}
              description={info.description}
              size={info.size}
              actualSizeMb={model.size_mb}
              isSelected={modelId === selectedLocalModel}
              isDownloaded={model.downloaded ?? false}
              isDownloading={isDownloadingModel(modelId)}
              isCancelling={isCancellingModel(modelId)}
              isInstalling={whisperDownloads[modelId]?.phase === "installing"}
              recommended={info.recommended}
              provider="whisper"
              onSelect={() => handleWhisperModelSelect(modelId)}
              onDelete={() => handleDelete(modelId)}
              onDownload={() =>
                downloadModel(modelId, (downloadedId) => {
                  setLocalModels((prev) =>
                    prev.map((m) => (m.model === downloadedId ? { ...m, downloaded: true } : m))
                  );
                  handleWhisperModelSelect(downloadedId);
                })
              }
              onCancel={() => cancelDownload(modelId)}
              styles={styles}
            />
          );
        })}
      </div>
    );
  };

  const handleParakeetDelete = useCallback(
    (modelId: string) => {
      showConfirmDialog({
        title: t("transcription.deleteModel.title"),
        description: t("transcription.deleteModel.description"),
        onConfirm: async () => {
          await deleteParakeetModel(modelId, async () => {
            const result = await window.electronAPI?.listParakeetModels();
            if (result?.success) {
              setParakeetModels(result.models);
            }
          });
        },
        variant: "destructive",
      });
    },
    [showConfirmDialog, deleteParakeetModel, t]
  );

  // Organization tabs share the sherpa-onnx inventory and installation backend.
  const renderParakeetModels = () => {
    const modelsToRender = (
      parakeetModels.length === 0
        ? Object.entries(PARAKEET_MODEL_INFO).map(([modelId, info]) => ({
            model: modelId,
            downloaded: false,
            size_mb: info.sizeMb,
          }))
        : parakeetModels
    ).filter((model) => getASRModelOrganization(model.model) === internalLocalProvider);

    return (
      <div className="space-y-0.5">
        {modelsToRender.map((model) => {
          const modelId = model.model;
          const info = PARAKEET_MODEL_INFO[modelId] ?? {
            name: modelId,
            description: t("transcription.fallback.parakeetModelDescription"),
            modelCardUrl: undefined,
            size: t("common.unknown"),
            language: "en",
            recommended: false,
          };

          return (
            <LocalModelCard
              key={modelId}
              modelId={modelId}
              name={info.name}
              description={info.description}
              size={info.size}
              actualSizeMb={model.size_mb}
              isSelected={modelId === selectedLocalModel}
              isDownloaded={model.downloaded ?? false}
              isDownloading={isDownloadingParakeetModel(modelId)}
              isCancelling={isCancellingParakeetModel(modelId)}
              isInstalling={parakeetDownloads[modelId]?.phase === "installing"}
              recommended={info.recommended}
              provider={getASRModelOrganization(modelId)}
              modelCardUrl={info.modelCardUrl}
              onSelect={() => handleParakeetModelSelect(modelId)}
              onDelete={() => handleParakeetDelete(modelId)}
              onDownload={() =>
                downloadParakeetModel(modelId, (downloadedId) => {
                  setParakeetModels((prev) =>
                    prev.map((m) => (m.model === downloadedId ? { ...m, downloaded: true } : m))
                  );
                  handleParakeetModelSelect(downloadedId);
                })
              }
              onCancel={() => cancelParakeetDownload(modelId)}
              styles={styles}
            />
          );
        })}
      </div>
    );
  };

  return (
    <div className={`space-y-2 ${className}`}>
      <ProviderTabs
        providers={localProviderTabs}
        selectedId={internalLocalProvider}
        onSelect={handleLocalProviderChange}
        colorScheme="purple"
      />

      {progressDisplay}

      {gpuDownloading && internalLocalProvider === "whisper" && (
        <div>
          <DownloadProgressBar modelName="GPU acceleration" progress={gpuProgress} />
          <div className="px-2.5 pb-1 flex justify-end">
            <button
              onClick={handleGpuCancel}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              {t("gpu.cancel")}
            </button>
          </div>
        </div>
      )}

      {internalLocalProvider === "whisper" && !gpuDismissed && !gpuDownloading && gpuBackend && (
        <div
          className={`rounded-md border p-2.5 ${
            (gpuDownloaded ? gpuFailed : gpuNeedsUpdate)
              ? "border-warning/40 bg-warning/5"
              : "border-border bg-surface-1"
          }`}
        >
          {gpuDownloaded ? (
            gpuFailed ? (
              <GpuWarningRow
                title={t("gpu.activationFailed")}
                description={t("gpu.activationFailedDescription")}
                actionLabel={t("gpu.retryActivation")}
                onAction={handleGpuRetry}
                onRemove={handleGpuDelete}
              >
                {gpuFailReason && (
                  <p
                    dir="ltr"
                    className="mt-1 wrap-break-word font-mono text-[11px] leading-snug text-muted-foreground"
                  >
                    {gpuFailReason}
                  </p>
                )}
              </GpuWarningRow>
            ) : (
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                  {gpuActivating ? (
                    <>
                      <span className="inline-block w-1.5 h-1.5 rounded-full shrink-0 bg-primary animate-pulse" />
                      <span className="text-xs font-medium text-foreground">
                        {t("gpu.activating")}
                      </span>
                    </>
                  ) : gpuActive ? (
                    <>
                      <Check size={13} className="text-success" />
                      <span className="text-xs font-medium text-foreground">{t("gpu.active")}</span>
                    </>
                  ) : (
                    <>
                      <span className="inline-block w-1.5 h-1.5 rounded-full shrink-0 bg-primary" />
                      <span className="text-xs font-medium text-foreground">{t("gpu.ready")}</span>
                    </>
                  )}
                </div>
                <Button
                  onClick={handleGpuDelete}
                  size="sm"
                  variant="ghost"
                  className="h-6 px-2 text-xs text-muted-foreground hover:text-destructive"
                >
                  {t("gpu.remove")}
                </Button>
              </div>
            )
          ) : gpuNeedsUpdate ? (
            <GpuWarningRow
              title={t("gpu.redownloadNeeded")}
              description={t("gpu.redownloadNeededDescription")}
              actionLabel={t("gpu.redownloadButton")}
              onAction={handleGpuDownload}
              onRemove={handleGpuDelete}
            />
          ) : (
            <div className="flex items-start gap-2.5">
              <Zap size={13} className="text-primary shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <p className="text-xs font-medium text-foreground">
                  {t("gpu.transcriptionBanner")}
                </p>
                <div className="flex items-center gap-2 mt-1.5">
                  <Button
                    onClick={handleGpuDownload}
                    size="sm"
                    variant="default"
                    className="h-6 px-2.5 text-xs"
                  >
                    {t("gpu.enableButton")}
                  </Button>
                  <button
                    onClick={() => setGpuDismissed(true)}
                    className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                  >
                    {t("gpu.dismiss")}
                  </button>
                </div>
              </div>
            </div>
          )}
          {!gpuDownloaded && gpuDownloadError !== null && (
            <p className="mt-2 text-xs leading-snug text-destructive">
              {t("gpu.downloadFailed")}
              {gpuDownloadError && ` ${gpuDownloadError}`}
            </p>
          )}
        </div>
      )}

      <div>
        {internalLocalProvider === "whisper" && renderLocalModels()}
        {usesParakeetManager(internalLocalProvider) && renderParakeetModels()}
      </div>

      <ConfirmDialog
        open={confirmDialog.open}
        onOpenChange={(open) => !open && hideConfirmDialog()}
        title={confirmDialog.title}
        description={confirmDialog.description}
        confirmText={confirmDialog.confirmText}
        cancelText={confirmDialog.cancelText}
        onConfirm={confirmDialog.onConfirm}
        variant={confirmDialog.variant}
      />
    </div>
  );
}
