import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Cpu, Network } from "../icons";
import { useSettingsStore } from "../../stores/settingsStore";
import { InferenceModeSelector } from "../ui/SettingsSection";
import type { InferenceModeOption } from "../ui/SettingsSection";
import TranscriptionModelPicker from "../TranscriptionModelPicker";
import SelfHostedPanel from "../SelfHostedPanel";
import type { TranscriptionMode } from "../../types/electron";

export function UploadTranscriptionPanel() {
  const { t } = useTranslation();

  const {
    uploadTranscriptionMode,
    setUploadTranscriptionMode,
    setUploadUseLocalWhisper,
    uploadWhisperModel,
    setUploadWhisperModel,
    uploadLocalTranscriptionProvider,
    setUploadLocalTranscriptionProvider,
    uploadParakeetModel,
    setUploadParakeetModel,
    uploadCohereModel,
    setUploadCohereModel,
    uploadRemoteTranscriptionUrl,
    setUploadRemoteTranscriptionUrl,
    uploadRemoteTranscriptionModel,
    setUploadRemoteTranscriptionModel,
  } = useSettingsStore();
  const transcriptionModes: InferenceModeOption<TranscriptionMode>[] = [
    {
      id: "local",
      label: t("settingsPage.transcription.modes.local"),
      description: t("settingsPage.transcription.modes.localDesc"),
      icon: <Cpu className="w-4 h-4" />,
    },
    {
      id: "self-hosted",
      label: t("settingsPage.transcription.modes.selfHosted"),
      description: t("settingsPage.transcription.modes.selfHostedDesc"),
      icon: <Network className="w-4 h-4" />,
    },
  ];
  const effectiveTranscriptionMode = uploadTranscriptionMode;
  const handleTranscriptionModeSelect = (mode: TranscriptionMode) => {
    if (mode === effectiveTranscriptionMode) return;
    setUploadTranscriptionMode(mode);
    setUploadUseLocalWhisper(mode === "local");
  };

  const handleLocalTranscriptionModelSelect = useCallback(
    (modelId: string, providerId?: string) => {
      const provider = providerId ?? uploadLocalTranscriptionProvider;
      if (provider === "nvidia") {
        setUploadParakeetModel(modelId);
      } else if (provider === "cohere") {
        setUploadCohereModel(modelId);
      } else {
        setUploadWhisperModel(modelId);
      }
    },
    [
      uploadLocalTranscriptionProvider,
      setUploadParakeetModel,
      setUploadCohereModel,
      setUploadWhisperModel,
    ]
  );

  const renderTranscriptionPicker = () => (
    <TranscriptionModelPicker
      selectedLocalModel={
        uploadLocalTranscriptionProvider === "nvidia"
          ? uploadParakeetModel
          : uploadLocalTranscriptionProvider === "cohere"
            ? uploadCohereModel
            : uploadWhisperModel
      }
      onLocalModelSelect={handleLocalTranscriptionModelSelect}
      selectedLocalProvider={uploadLocalTranscriptionProvider}
      onLocalProviderSelect={setUploadLocalTranscriptionProvider}
      variant="settings"
    />
  );

  return (
    <div className="space-y-3">
      <InferenceModeSelector
        modes={transcriptionModes}
        activeMode={effectiveTranscriptionMode}
        onSelect={handleTranscriptionModeSelect}
      />

      {effectiveTranscriptionMode === "local" && renderTranscriptionPicker()}
      {effectiveTranscriptionMode === "self-hosted" && (
        <SelfHostedPanel
          service="transcription"
          url={uploadRemoteTranscriptionUrl}
          onUrlChange={setUploadRemoteTranscriptionUrl}
          model={uploadRemoteTranscriptionModel}
          onModelChange={setUploadRemoteTranscriptionModel}
        />
      )}
    </div>
  );
}
