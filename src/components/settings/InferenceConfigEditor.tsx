import { useCallback } from "react";
import { useShallow } from "zustand/react/shallow";
import { useTranslation } from "react-i18next";
import { Cpu, Network } from "../icons";
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import {
  TOOL_CALLING_SETTINGS,
  effectiveToolCallingSetting,
} from "../../helpers/toolCallingPolicy.js";
import type { InferenceMode } from "../../types/electron";
import type { InferenceScope } from "../../config/inferenceScopes";
import { isProviderValidForMode, getLocalModel } from "../../models/ModelRegistry";
import { AUTO_REASONING_EFFORT, isReasoningEffortSupported } from "../../models/reasoningEffort";
import { selectableReasoningEffort } from "../../services/ai/chatRequestBody";

// Radix Select can't hold an empty value, so Auto ("") gets a sentinel.
const AUTO_REASONING_EFFORT_VALUE = "__auto__";

const MODE_LABEL_PREFIX: Record<InferenceScope, string> = {
  dictationCleanup: "settingsPage.aiModels.modes",
  noteFormatting: "settingsPage.aiModels.modes",
  dictationAgent: "dictationAgent.modes",
  chatIntelligence: "agentMode.settings.modes",
  dictationTranslation: "settingsPage.aiModels.modes",
};

interface InferenceConfigEditorProps {
  scope: InferenceScope;
  onModeChange?: (mode: InferenceMode) => void;
}

export default function InferenceConfigEditor({ scope, onModeChange }: InferenceConfigEditorProps) {
  const { t } = useTranslation();
  const config = useSettingsStore(
    useShallow((settings): ResolvedLLMConfig => selectResolvedLLMConfig(settings, scope))
  );
  const keepLocalModelLoaded = useSettingsStore((s) => s.keepLocalModelLoaded);
  const setKeepLocalModelLoaded = useSettingsStore((s) => s.setKeepLocalModelLoaded);

  const prefix = MODE_LABEL_PREFIX[scope];
  const modes: InferenceModeOption[] = [
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
  ];
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

      const patch: Parameters<typeof setResolvedLLMConfig>[1] = { mode };
      if (mode === "self-hosted") {
        patch.provider = "lan";
        patch.model = "";
      } else if (!isProviderValidForMode(config.provider, mode)) {
        patch.provider = "";
        patch.model = "";
      }
      setResolvedLLMConfig(scope, patch);
      onModeChange?.(mode);
    },
    [scope, config.provider, effectiveMode, onModeChange]
  );

  const setModel = setField("model");

  const showToolCalling = config.toolCalling !== undefined;
  const showAcceptsImages = effectiveMode === "self-hosted" && config.acceptsImages !== undefined;

  const showThinkingToggle =
    effectiveMode === "self-hosted" ||
    (effectiveMode === "local" && !!getLocalModel(config.model)?.supportsThinking);

  const effortCapability = selectableReasoningEffort(
    effectiveMode === "self-hosted" ? "lan" : "local",
    config.model,
    config
  );

  return (
    <div className="space-y-3">
      <InferenceModeSelector modes={modes} activeMode={effectiveMode} onSelect={handleModeSelect} />

      {effectiveMode === "local" && (
        <ReasoningModelSelector
          reasoningModel={config.model}
          setReasoningModel={setModel}
          localReasoningProvider={config.provider}
          setLocalReasoningProvider={setField("provider")}
        />
      )}

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

      {showToolCalling && (
        <div className="flex items-start justify-between gap-3 pt-1">
          <div className="flex-1 min-w-0">
            <h4 className="text-sm font-medium text-foreground">
              {t("reasoning.toolCalling.label")}
            </h4>
            <p className="text-xs text-muted-foreground">{t("reasoning.toolCalling.help")}</p>
          </div>
          <Select
            value={effectiveToolCallingSetting(config.toolCalling, effectiveMode)}
            onValueChange={(value: "auto" | "on" | "off") =>
              setResolvedLLMConfig(scope, { toolCalling: value })
            }
          >
            <SelectTrigger className="h-7 w-28 text-xs rounded-lg px-2.5 [&>svg]:h-3 [&>svg]:w-3">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TOOL_CALLING_SETTINGS.map((option) => (
                <SelectItem key={option} value={option}>
                  {t(`reasoning.toolCalling.options.${option}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {showAcceptsImages && (
        <div className="flex items-start justify-between gap-3 pt-1">
          <div className="flex-1 min-w-0">
            <h4 className="text-sm font-medium text-foreground">
              {t("reasoning.acceptsImages.label")}
            </h4>
            <p className="text-xs text-muted-foreground">{t("reasoning.acceptsImages.help")}</p>
          </div>
          <Toggle checked={config.acceptsImages === true} onChange={setField("acceptsImages")} />
        </div>
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

      {effortCapability && (
        <div className="flex items-start justify-between gap-3 pt-1">
          <div className="flex-1 min-w-0">
            <h4 className="text-sm font-medium text-foreground">{t("reasoning.effort.title")}</h4>
            <p className="text-xs text-muted-foreground">
              {effortCapability.defaultValue
                ? t("reasoning.effort.descriptionWithDefault", {
                    value: t(`reasoning.effort.options.${effortCapability.defaultValue}`),
                  })
                : t("reasoning.effort.description")}
            </p>
          </div>
          <Select
            value={
              isReasoningEffortSupported(effortCapability, config.reasoningEffort)
                ? config.reasoningEffort
                : AUTO_REASONING_EFFORT_VALUE
            }
            onValueChange={(value) =>
              setField("reasoningEffort")(
                value === AUTO_REASONING_EFFORT_VALUE ? AUTO_REASONING_EFFORT : value
              )
            }
          >
            <SelectTrigger className="h-7 w-44 shrink-0 text-xs rounded-lg px-2.5 [&>svg]:h-3 [&>svg]:w-3">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem
                value={AUTO_REASONING_EFFORT_VALUE}
                className="text-xs py-1.5 ps-2.5 pe-7 rounded-md"
              >
                {t("reasoning.effort.auto")}
              </SelectItem>
              {effortCapability.options.map((effort) => (
                <SelectItem
                  key={effort}
                  value={effort}
                  className="text-xs py-1.5 ps-2.5 pe-7 rounded-md"
                >
                  {t(`reasoning.effort.options.${effort}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {effectiveMode === "local" && (
        <div className="flex items-start justify-between gap-3 pt-1">
          <div className="flex-1 min-w-0">
            <h4 className="text-sm font-medium text-foreground">
              {t("reasoning.keepModelLoaded.label")}
            </h4>
            <p className="text-xs text-muted-foreground">{t("reasoning.keepModelLoaded.help")}</p>
          </div>
          <Toggle checked={keepLocalModelLoaded} onChange={setKeepLocalModelLoaded} />
        </div>
      )}
    </div>
  );
}
