import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Cpu, Network } from "../icons";
import { useSettingsStore } from "../../stores/settingsStore";
import { InferenceModeSelector, SectionHeader, SettingsRow } from "../ui/SettingsSection";
import type { InferenceModeOption } from "../ui/SettingsSection";
import { Toggle } from "../ui/toggle";
import TranscriptionModelPicker from "../TranscriptionModelPicker";
import SelfHostedPanel from "../SelfHostedPanel";
import type { TranscriptionMode } from "../../types/electron";

export function MeetingSpeakerDetectionRow() {
  const { t } = useTranslation();
  const speakerDiarizationEnabled = useSettingsStore((s) => s.speakerDiarizationEnabled);
  const setSpeakerDiarizationEnabled = useSettingsStore((s) => s.setSpeakerDiarizationEnabled);

  return (
    <SettingsRow
      label={t("settings.meeting.speakerDetection.title")}
      description={t("settings.meeting.speakerDetection.description")}
    >
      <Toggle checked={speakerDiarizationEnabled} onChange={setSpeakerDiarizationEnabled} />
    </SettingsRow>
  );
}

export function MeetingKeepAudioRow() {
  const { t } = useTranslation();
  const keepMeetingAudio = useSettingsStore((s) => s.keepMeetingAudio);
  const setKeepMeetingAudio = useSettingsStore((s) => s.setKeepMeetingAudio);

  return (
    <SettingsRow
      label={t("settings.meeting.keepAudio.title")}
      description={t("settings.meeting.keepAudio.description")}
    >
      <Toggle checked={keepMeetingAudio} onChange={setKeepMeetingAudio} />
    </SettingsRow>
  );
}

function MeetingEchoCancellationRow() {
  const { t } = useTranslation();
  const meetingAecEnabled = useSettingsStore((s) => s.meetingAecEnabled);
  const setMeetingAecEnabled = useSettingsStore((s) => s.setMeetingAecEnabled);

  return (
    <SettingsRow
      label={t("settingsPage.transcription.aec.toggle.title")}
      description={t("settingsPage.transcription.aec.toggle.description")}
    >
      <Toggle checked={meetingAecEnabled} onChange={setMeetingAecEnabled} />
    </SettingsRow>
  );
}

// One diarizer for meetings and uploads. Naming speakers from saved voice
// profiles stays on-device either way.
export function SpeakerDetectionServerPanel() {
  const { t } = useTranslation();
  const {
    diarizationMode,
    setDiarizationMode,
    diarizationRemoteUrl,
    setDiarizationRemoteUrl,
    customTranscriptionApiKey,
    setCustomTranscriptionApiKey,
  } = useSettingsStore();

  const modes: InferenceModeOption<TranscriptionMode>[] = [
    {
      id: "local",
      label: t("settingsPage.transcription.modes.local"),
      description: t("settingsPage.transcription.modes.localDesc"),
      icon: <Cpu className="w-4 h-4" />,
    },
    {
      id: "self-hosted",
      label: t("settingsPage.transcription.modes.selfHosted"),
      description: t("settings.meeting.speakerDetection.selfHostedDesc"),
      icon: <Network className="w-4 h-4" />,
    },
  ];

  return (
    <div className="space-y-3">
      <SectionHeader
        title={t("settings.meeting.speakerDetection.serverTitle")}
        description={t("settings.meeting.speakerDetection.serverDescription")}
      />
      <InferenceModeSelector
        modes={modes}
        activeMode={diarizationMode}
        onSelect={setDiarizationMode}
      />
      {diarizationMode === "self-hosted" && (
        <SelfHostedPanel
          url={diarizationRemoteUrl}
          onUrlChange={setDiarizationRemoteUrl}
          apiKey={customTranscriptionApiKey}
          onApiKeyChange={setCustomTranscriptionApiKey}
          urlPlaceholder="https://speech.example.lan/v1"
          urlHelp={t("settings.meeting.speakerDetection.serverUrlHelp")}
        />
      )}
    </div>
  );
}

export function MeetingTranscriptionPanel() {
  const { t } = useTranslation();

  const {
    meetingTranscriptionMode,
    setMeetingTranscriptionMode,
    setMeetingUseLocalWhisper,
    meetingWhisperModel,
    setMeetingWhisperModel,
    meetingLocalTranscriptionProvider,
    setMeetingLocalTranscriptionProvider,
    meetingParakeetModel,
    setMeetingParakeetModel,
    meetingCohereModel,
    setMeetingCohereModel,
    meetingRemoteTranscriptionUrl,
    setMeetingRemoteTranscriptionUrl,
    meetingRemoteTranscriptionModel,
    setMeetingRemoteTranscriptionModel,
    remoteTranscriptionUrl,
    customTranscriptionApiKey,
    setCustomTranscriptionApiKey,
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
  const effectiveTranscriptionMode = meetingTranscriptionMode;
  const handleTranscriptionModeSelect = (mode: TranscriptionMode) => {
    if (mode === effectiveTranscriptionMode) return;
    setMeetingTranscriptionMode(mode);
    setMeetingUseLocalWhisper(mode === "local");
  };

  const handleLocalTranscriptionModelSelect = useCallback(
    (modelId: string, providerId?: string) => {
      const provider = providerId ?? meetingLocalTranscriptionProvider;
      if (provider === "nvidia") {
        setMeetingParakeetModel(modelId);
      } else if (provider === "cohere") {
        setMeetingCohereModel(modelId);
      } else {
        setMeetingWhisperModel(modelId);
      }
    },
    [
      meetingLocalTranscriptionProvider,
      setMeetingParakeetModel,
      setMeetingCohereModel,
      setMeetingWhisperModel,
    ]
  );

  const renderTranscriptionPicker = () => (
    <TranscriptionModelPicker
      selectedLocalModel={
        meetingLocalTranscriptionProvider === "nvidia"
          ? meetingParakeetModel
          : meetingLocalTranscriptionProvider === "cohere"
            ? meetingCohereModel
            : meetingWhisperModel
      }
      onLocalModelSelect={handleLocalTranscriptionModelSelect}
      selectedLocalProvider={meetingLocalTranscriptionProvider}
      onLocalProviderSelect={setMeetingLocalTranscriptionProvider}
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
          url={meetingRemoteTranscriptionUrl}
          onUrlChange={setMeetingRemoteTranscriptionUrl}
          model={meetingRemoteTranscriptionModel}
          onModelChange={setMeetingRemoteTranscriptionModel}
          apiKey={customTranscriptionApiKey}
          onApiKeyChange={setCustomTranscriptionApiKey}
          urlPlaceholder={remoteTranscriptionUrl || undefined}
          urlHelp={t("settingsPage.selfHosted.meetingUrlHelp")}
        />
      )}
      <MeetingSpeakerDetectionRow />
      <MeetingEchoCancellationRow />
      <MeetingKeepAudioRow />
      <SpeakerDetectionServerPanel />
    </div>
  );
}
