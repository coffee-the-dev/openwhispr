import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Input } from "./ui/input";
import { Button } from "./ui/button";
import ApiKeyInput from "./ui/ApiKeyInput";
import ProviderConnectionTest from "./onboarding/ProviderConnectionTest";

interface SelfHostedPanelProps {
  url: string;
  onUrlChange: (url: string) => void;
  model?: string;
  onModelChange?: (model: string) => void;
  apiKey?: string;
  onApiKeyChange?: (key: string) => void;
  urlPlaceholder?: string;
  urlHelp?: ReactNode;
}

const MODEL_LIST_DEBOUNCE_MS = 500;
const ignoreConnectionResult = () => {};

// A self-hosted OpenAI-compatible speech-to-text server: URL, optional Bearer
// key, a model picked from its /models list (free text when it lists none), and
// a connection test.
export default function SelfHostedPanel({
  url,
  onUrlChange,
  model,
  onModelChange,
  apiKey,
  onApiKeyChange,
  urlPlaceholder = "https://whisper.example.lan/v1",
  urlHelp,
}: SelfHostedPanelProps) {
  const { t } = useTranslation();
  const datalistId = useId();
  const [models, setModels] = useState<string[]>([]);
  const [modelsFailed, setModelsFailed] = useState(false);
  const [loading, setLoading] = useState(false);
  const requestRef = useRef(0);

  const trimmedUrl = url.trim();
  const key = apiKey ?? "";

  const loadModels = useCallback(async () => {
    const requestId = ++requestRef.current;
    if (!trimmedUrl || !window.electronAPI?.listRemoteModels) {
      setModels([]);
      setModelsFailed(false);
      return;
    }
    setLoading(true);
    try {
      const result = await window.electronAPI.listRemoteModels({
        baseUrl: trimmedUrl,
        apiKey: key,
      });
      if (requestId !== requestRef.current) return;
      setModels(result?.success ? result.models : []);
      setModelsFailed(!result?.success);
    } catch {
      if (requestId !== requestRef.current) return;
      setModels([]);
      setModelsFailed(true);
    } finally {
      if (requestId === requestRef.current) setLoading(false);
    }
  }, [trimmedUrl, key]);

  useEffect(() => {
    if (!onModelChange) return;
    const timer = setTimeout(() => void loadModels(), MODEL_LIST_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [loadModels, onModelChange]);

  useEffect(
    () => () => {
      requestRef.current += 1;
    },
    []
  );

  return (
    <div className="border border-border rounded-lg p-3 space-y-2.5">
      <div className="space-y-1.5">
        <label className="block text-xs font-medium text-foreground">
          {t("settingsPage.selfHosted.serverUrl")}
        </label>
        <Input
          dir="ltr"
          value={url}
          onChange={(e) => onUrlChange(e.target.value)}
          placeholder={urlPlaceholder}
          className="h-8 text-sm"
        />
        {urlHelp && <p className="text-xs text-muted-foreground">{urlHelp}</p>}
      </div>

      {onApiKeyChange && (
        <div className="space-y-1.5">
          <label className="block text-xs font-medium text-foreground">
            {t("settingsPage.selfHosted.apiKeyOptional")}
          </label>
          <ApiKeyInput
            apiKey={key}
            setApiKey={onApiKeyChange}
            label=""
            helpText={t("settingsPage.selfHosted.apiKeyHelp")}
          />
        </div>
      )}

      {onModelChange && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <label className="block text-xs font-medium text-foreground">{t("common.model")}</label>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void loadModels()}
              disabled={loading || !trimmedUrl}
              className="h-6 px-2 text-xs"
            >
              {loading ? t("common.loading") : t("common.refresh")}
            </Button>
          </div>
          <Input
            dir="ltr"
            list={datalistId}
            value={model ?? ""}
            onChange={(e) => onModelChange(e.target.value)}
            placeholder={models[0] ?? "whisper-1"}
            className="h-8 text-sm"
          />
          <datalist id={datalistId}>
            {models.map((id) => (
              <option key={id} value={id} />
            ))}
          </datalist>
          <p className="text-xs text-muted-foreground">
            {modelsFailed && trimmedUrl
              ? t("settingsPage.selfHosted.modelsUnavailable")
              : t("settingsPage.selfHosted.modelHelp")}
          </p>
        </div>
      )}

      {trimmedUrl && (
        <ProviderConnectionTest
          config={{ baseUrl: trimmedUrl, apiKey: key }}
          onSuccessChange={ignoreConnectionResult}
        />
      )}
    </div>
  );
}
