import { useCallback } from "react";
import { useShallow } from "zustand/react/shallow";
import { useTranslation } from "react-i18next";
import { Key, Cpu, Network } from "../icons";
import {
  useSettingsStore,
  selectResolvedLLMConfig,
  setResolvedLLMConfig,
  type ResolvedLLMConfig,
} from "../../stores/settingsStore";
import { InferenceModeSelector } from "../ui/SettingsSection";
import type { InferenceModeOption } from "../ui/SettingsSection";
import ReasoningModelSelector from "../ReasoningModelSelector";
import OpenAICompatiblePanel from "../OpenAICompatiblePanel";
import { Toggle } from "../ui/toggle";
import type { InferenceMode } from "../../types/electron";
import {
  INFERENCE_SCOPES,
  type InferenceScope,
  type InferenceScopeDefinition,
} from "../../config/inferenceScopes";
import { isProviderValidForMode, getCloudModel, getLocalModel } from "../../models/ModelRegistry";

const MODE_LABEL_PREFIX: Record<InferenceScope, string> = {
  dictationCleanup: "settingsPage.aiModels.modes",
  noteFormatting: "settingsPage.aiModels.modes",
  dictationAgent: "dictationAgent.modes",
  dictationAgentVision: "dictationAgent.modes",
  chatIntelligence: "agentMode.settings.modes",
  dictationTranslation: "settingsPage.aiModels.modes",
};

interface InferenceConfigEditorProps {
  scope: InferenceScope;
  onModeChange?: (mode: InferenceMode) => void;
  /** Restrict the selectable modes (e.g. vision override offers cloud/BYOK only). */
  allowedModes?: InferenceMode[];
}

export default function InferenceConfigEditor({
  scope,
  onModeChange,
  allowedModes,
}: InferenceConfigEditorProps) {
  const { t } = useTranslation();
  const config = useSettingsStore(
    useShallow((settings): ResolvedLLMConfig => {
      const effective = settings;
      const resolved = selectResolvedLLMConfig(effective, scope);
      const definition: InferenceScopeDefinition = INFERENCE_SCOPES[scope];
      // Inherited runtime defaults are not an explicit selection in an optional picker.
      return definition.optional
        ? { ...resolved, model: effective[definition.storeKeys.model] as string }
        : resolved;
    })
  );

  const prefix = MODE_LABEL_PREFIX[scope];
  const modes = (
    [
      {
        id: "providers",
        label: t(`${prefix}.providers`),
        description: t(`${prefix}.providersDesc`),
        icon: <Key className="w-4 h-4" />,
      },
      {
        id: "local",
        label: t(`${prefix}.local`),
        description: t(`${prefix}.localDesc`),
        icon: <Cpu className="w-4 h-4" />,
      },
      {
        id: "self-hosted",
        label: t(`${prefix}.selfHosted`),
        description: t(`${prefix}.selfHostedDesc`),
        icon: <Network className="w-4 h-4" />,
      },
    ] as InferenceModeOption[]
  ).filter((mode) => !allowedModes || allowedModes.includes(mode.id));
  const effectiveMode = config.mode;

  const setField = useCallback(
    <K extends keyof Omit<typeof config, "scope">>(field: K) =>
      (value: NonNullable<(typeof config)[K]>) => {
        setResolvedLLMConfig(scope, { [field]: value });
      },
    [scope]
  );

  const handleModeSelect = useCallback(
    (mode: InferenceMode) => {
      if (mode === effectiveMode) return;

      const patch: Parameters<typeof setResolvedLLMConfig>[1] = {
        mode,
        cloudMode: mode === "openwhispr" ? "openwhispr" : "byok",
      };
      if (!isProviderValidForMode(config.provider, mode)) {
        patch.provider = "";
        patch.model = "";
      }
      setResolvedLLMConfig(scope, patch);
      onModeChange?.(mode);
    },
    [scope, config.provider, effectiveMode, onModeChange]
  );

  const setMode = setField("mode");
  const setProvider = setField("provider");
  const setModel = setField("model");

  const renderModelSelector = (mode?: "cloud" | "local") => (
    <ReasoningModelSelector
      reasoningModel={config.model}
      setReasoningModel={setModel}
      localReasoningProvider={config.provider}
      setLocalReasoningProvider={setProvider}
      cloudReasoningBaseUrl={config.cloudBaseUrl ?? ""}
      setCloudReasoningBaseUrl={setField("cloudBaseUrl")}
      customReasoningApiKey={config.customApiKey ?? ""}
      setCustomReasoningApiKey={setField("customApiKey")}
      setReasoningMode={setMode}
      mode={mode}
    />
  );

  const showThinkingToggle =
    effectiveMode === "self-hosted" ||
    (effectiveMode === "providers" &&
      (config.provider === "custom" ||
        config.provider === "openrouter" ||
        !!getCloudModel(config.model)?.supportsThinking)) ||
    (effectiveMode === "local" && !!getLocalModel(config.model)?.supportsThinking);

  return (
    <div className="space-y-3">
      {modes.length > 1 && (
        <InferenceModeSelector
          modes={modes}
          activeMode={effectiveMode}
          onSelect={handleModeSelect}
        />
      )}

      {effectiveMode === "providers" && renderModelSelector("cloud")}
      {effectiveMode === "local" && renderModelSelector("local")}

      {effectiveMode === "self-hosted" && (
        <OpenAICompatiblePanel
          baseUrl={config.remoteUrl ?? ""}
          setBaseUrl={setField("remoteUrl")}
          apiKey={config.customApiKey ?? ""}
          setApiKey={setField("customApiKey")}
          model={config.model}
          setModel={setModel}
          baseUrlPlaceholder="http://192.168.1.126:11434/v1"
          helpExamples={
            <p className="text-xs text-muted-foreground">
              {t("reasoning.selfHosted.endpointHelp")}
            </p>
          }
        />
      )}

      {showThinkingToggle && (
        <div className="flex items-start justify-between gap-3 pt-1">
          <div className="flex-1 min-w-0">
            <h4 className="text-sm font-medium text-foreground">
              {t("reasoning.disableThinking.label")}
            </h4>
            <p className="text-xs text-muted-foreground">{t("reasoning.disableThinking.help")}</p>
          </div>
          <Toggle checked={config.disableThinking} onChange={setField("disableThinking")} />
        </div>
      )}
    </div>
  );
}
