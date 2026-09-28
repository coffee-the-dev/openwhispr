import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSettingsStore } from "../../stores/settingsStore";
import { isSecureHttpEndpoint, withHttpsScheme } from "../../utils/urlUtils";
import { Toggle } from "../ui/toggle";
import { Input } from "../ui/input";
import { Button } from "../ui/button";
import { SettingsPanel, SettingsPanelRow, SettingsRow, SectionHeader } from "../ui/SettingsSection";

const TEST_QUERY = "SearXNG";
const TRANSLATED_ERRORS = new Set([
  "invalidUrl",
  "httpsRequired",
  "jsonDisabled",
  "rateLimited",
  "timeout",
  "network",
  "invalidResponse",
]);

type TestState =
  | { status: "idle" }
  | { status: "testing" }
  | { status: "success"; count: number }
  | { status: "error"; message: string };

function validateUrl(url: string): "invalidUrl" | "httpsRequired" | null {
  if (!url) return null;
  try {
    new URL(url);
  } catch {
    return "invalidUrl";
  }
  return isSecureHttpEndpoint(url) ? null : "httpsRequired";
}

/** The SearXNG instance behind the agent's web_search tool, shared by chat and the voice assistant. */
export default function WebSearchSettings() {
  const { t } = useTranslation();
  const webSearchEnabled = useSettingsStore((s) => s.webSearchEnabled);
  const setWebSearchEnabled = useSettingsStore((s) => s.setWebSearchEnabled);
  const webSearchUrl = useSettingsStore((s) => s.webSearchUrl);
  const setWebSearchUrl = useSettingsStore((s) => s.setWebSearchUrl);
  const [draftUrl, setDraftUrl] = useState(webSearchUrl);
  const [urlError, setUrlError] = useState<string | null>(null);
  const [test, setTest] = useState<TestState>({ status: "idle" });

  useEffect(() => setDraftUrl(webSearchUrl), [webSearchUrl]);

  const commitUrl = useCallback((): string | null => {
    const url = withHttpsScheme(draftUrl);
    const error = validateUrl(url);
    setUrlError(error ? t(`agentMode.settings.webSearch.errors.${error}`) : null);
    if (error) return null;
    setDraftUrl(url);
    if (url !== webSearchUrl) setWebSearchUrl(url);
    return url;
  }, [draftUrl, webSearchUrl, setWebSearchUrl, t]);

  const handleTest = useCallback(async () => {
    const url = commitUrl();
    if (!url) return;
    setTest({ status: "testing" });
    try {
      const result = await window.electronAPI.agentWebSearch!(TEST_QUERY, 10, { baseUrl: url });
      if (result.success) {
        setTest({ status: "success", count: result.results?.length ?? 0 });
      } else {
        setTest({
          status: "error",
          message:
            result.errorCode && TRANSLATED_ERRORS.has(result.errorCode)
              ? t(`agentMode.settings.webSearch.errors.${result.errorCode}`)
              : result.error || "",
        });
      }
    } catch (error) {
      setTest({ status: "error", message: (error as Error).message });
    }
  }, [commitUrl, t]);

  return (
    <div className="border-t border-border/70 pt-6 space-y-3">
      <SectionHeader
        title={t("agentMode.settings.webSearch.title")}
        description={t("agentMode.settings.webSearch.description")}
      />
      <SettingsPanel>
        <SettingsPanelRow>
          <SettingsRow
            label={t("agentMode.settings.webSearch.enable")}
            description={t("agentMode.settings.webSearch.enableDescription")}
          >
            <Toggle checked={webSearchEnabled} onChange={setWebSearchEnabled} />
          </SettingsRow>
        </SettingsPanelRow>
        {webSearchEnabled && (
          <SettingsPanelRow>
            <div className="space-y-2">
              <p className="text-xs font-medium text-foreground">
                {t("agentMode.settings.webSearch.urlLabel")}
              </p>
              <div className="flex gap-2">
                <Input
                  dir="ltr"
                  value={draftUrl}
                  onChange={(e) => {
                    setDraftUrl(e.target.value);
                    setUrlError(null);
                    setTest({ status: "idle" });
                  }}
                  onBlur={() => commitUrl()}
                  placeholder="https://searx.example.lan"
                  spellCheck={false}
                  className="flex-1 text-xs font-mono"
                />
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleTest}
                  disabled={!draftUrl.trim() || test.status === "testing"}
                >
                  {test.status === "testing"
                    ? t("agentMode.settings.webSearch.testing")
                    : t("agentMode.settings.webSearch.test")}
                </Button>
              </div>
              {urlError && <p className="text-[11px] text-destructive leading-snug">{urlError}</p>}
              {test.status === "success" && (
                <p className="text-[11px] text-success leading-snug">
                  {t("agentMode.settings.webSearch.testSuccess", { count: test.count })}
                </p>
              )}
              {test.status === "error" && (
                <p className="text-[11px] text-destructive leading-snug">
                  {t("agentMode.settings.webSearch.testFailed", { error: test.message })}
                </p>
              )}
              <p className="text-[11px] text-muted-foreground/70 leading-snug">
                {t("agentMode.settings.webSearch.urlHelp")}
              </p>
            </div>
          </SettingsPanelRow>
        )}
      </SettingsPanel>
    </div>
  );
}
