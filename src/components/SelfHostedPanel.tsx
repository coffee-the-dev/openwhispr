import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useConnectionAutoCheck } from "../hooks/useConnectionAutoCheck";
import { useFocusHold } from "../hooks/useFocusHold";
import { useTypingPause } from "../hooks/useTypingPause";
import { Button } from "./ui/button";
import ApiKeyInput from "./ui/ApiKeyInput";
import { ConnectionCheckAnnouncer } from "./ui/ConnectionCheckAnnouncer";
import { ProviderCheckField } from "./ui/ProviderCheckField";
import { usePanelVisible } from "./ui/usePanelVisible";

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

// A self-hosted OpenAI-compatible speech-to-text server: URL, optional Bearer
// key, a model picked from its /models list (free text when it lists none), and
// an automatic connection check.
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
  const urlHold = useFocusHold();
  const editing = useFocusHold();
  const visible = usePanelVisible();

  const trimmedUrl = url.trim();
  const key = apiKey ?? "";
  const trimmedModel = (model ?? "").trim();
  // The address, key and model save as they are typed.
  const delayMs = useTypingPause({
    typed: `${url}\n${key}\n${model ?? ""}`,
    context: JSON.stringify([visible]),
    held: editing.held,
  });
  const check = useConnectionAutoCheck({
    config: {
      scope: "transcription",
      provider: "custom",
      baseUrl: url,
      ...(model !== undefined ? { model } : {}),
      ...(key ? { apiKey: key } : {}),
    },
    ready:
      Boolean(trimmedUrl && (!onModelChange || trimmedModel)) &&
      // A hidden panel is not ready to ask; a shown one asks again, and the main process
      // answers a check it remembers at once.
      visible,
    // A half-typed address may belong to someone else: nothing is sent while it is edited.
    hold: urlHold.held,
    delayMs,
  });
  // Sent without a key, a refusal means the server wants one.
  const failureReason =
    !key.trim() && check.failure?.errorCode === "credentialsRejected"
      ? t("reasoning.custom.endpointUnauthorized")
      : undefined;

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
    <div
      className="border border-border rounded-lg p-3 space-y-2.5"
      onFocus={editing.onFocus}
      onBlur={editing.onBlur}
    >
      <ConnectionCheckAnnouncer announcement={check.announcement} />
      <div className="space-y-1.5">
        <label className="block text-xs font-medium text-foreground">
          {t("settingsPage.selfHosted.serverUrl")}
        </label>
        <ProviderCheckField
          aria-label={t("settingsPage.selfHosted.serverUrl")}
          // With no model field, the server address carries the check's status.
          check={onModelChange ? undefined : check}
          failureReason={failureReason}
          value={url}
          onChange={(e) => onUrlChange(e.target.value)}
          onFocus={urlHold.onFocus}
          onBlur={urlHold.onBlur}
          placeholder={urlPlaceholder}
          autoComplete="off"
          spellCheck={false}
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
          <ProviderCheckField
            aria-label={t("common.model")}
            check={check}
            invalidOn="modelNotFound"
            failureReason={failureReason}
            list={datalistId}
            value={model ?? ""}
            onChange={(e) => onModelChange(e.target.value)}
            placeholder={models[0] ?? "whisper-1"}
            autoComplete="off"
            spellCheck={false}
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
    </div>
  );
}
