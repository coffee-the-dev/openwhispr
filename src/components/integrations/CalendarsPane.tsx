import { useState, useEffect, useCallback, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { CalendarDays, Loader2, Unlink } from "../icons";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import { SettingsPanel, SettingsPanelRow } from "../ui/SettingsSection";
import { AlertDialog, ConfirmDialog } from "../ui/dialog";
import { useSettingsStore } from "../../stores/settingsStore";
import { useSystemAudioPermission } from "../../hooks/useSystemAudioPermission";
import { canManageSystemAudioInApp } from "../../utils/systemAudioAccess";
import { IntegrationsPane } from "./IntegrationsPane";
import appleCalendarIcon from "../../assets/icons/apple-calendar.svg";

interface ProviderRowProps {
  icon: string;
  i18nKey: string;
  connected: boolean;
  isConnecting: boolean;
  onConnect: () => void;
}

function ProviderRow({ icon, i18nKey, connected, isConnecting, onConnect }: ProviderRowProps) {
  const { t } = useTranslation();
  return (
    <SettingsPanelRow>
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 rounded-lg bg-white dark:bg-surface-raised shadow-[0_0_0_1px_rgba(0,0,0,0.04)] dark:shadow-none dark:border dark:border-white/10 flex items-center justify-center shrink-0">
          <img src={icon} alt="" className="w-5 h-5" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-xs font-semibold text-foreground">{t(`${i18nKey}.title`)}</p>
          <p className="text-xs text-muted-foreground/70 mt-0.5 leading-relaxed">
            {t(`${i18nKey}.description`)}
          </p>
        </div>
        {connected ? (
          <Badge variant="success" className="shrink-0">
            {t(`${i18nKey}.connected`)}
          </Badge>
        ) : (
          <Button size="sm" onClick={onConnect} disabled={isConnecting} className="shrink-0">
            {isConnecting ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              t(`${i18nKey}.connect`)
            )}
          </Button>
        )}
      </div>
    </SettingsPanelRow>
  );
}

interface CalendarsPaneProps {
  title: string;
}

export function CalendarsPane({ title }: CalendarsPaneProps): ReactElement {
  const { t } = useTranslation();
  const { appleCalendarConnected, setAppleCalendarConnected } = useSettingsStore();
  const [showPermissionDialog, setShowPermissionDialog] = useState(false);
  const [isAppleConnecting, setIsAppleConnecting] = useState(false);
  const [appleSourceNames, setAppleSourceNames] = useState<string[]>([]);
  const [confirmAppleDisconnect, setConfirmAppleDisconnect] = useState(false);
  const [appleConnectError, setAppleConnectError] = useState<"denied" | "failed" | null>(null);
  const systemAudio = useSystemAudioPermission();
  const { request: requestSystemAudioAccess } = systemAudio;
  const needsSystemAudioGrant = !systemAudio.granted && canManageSystemAudioInApp(systemAudio);
  const isMac = window.electronAPI?.getPlatform?.() === "darwin";

  const connectAppleCalendar = useCallback(async () => {
    setIsAppleConnecting(true);
    try {
      const result = await window.electronAPI?.acalConnect?.();
      if (result?.success) {
        setAppleCalendarConnected(true);
      } else {
        // Only send the user to Privacy settings when access was actually
        // denied; helper-missing/snapshot-failed are not permission problems.
        setAppleConnectError(result?.reason === "denied" ? "denied" : "failed");
      }
    } finally {
      setIsAppleConnecting(false);
    }
  }, [setAppleCalendarConnected]);

  const withSystemAudioGate = useCallback(
    async (connect: () => Promise<void>) => {
      if (needsSystemAudioGrant) {
        const granted = await requestSystemAudioAccess();
        if (!granted) {
          setShowPermissionDialog(true);
          return;
        }
      }
      await connect();
    },
    [needsSystemAudioGrant, requestSystemAudioAccess]
  );

  const handleAppleConnect = useCallback(
    () => withSystemAudioGate(connectAppleCalendar),
    [withSystemAudioGate, connectAppleCalendar]
  );

  const handleAppleDisconnect = useCallback(async () => {
    await window.electronAPI?.acalDisconnect?.();
    setAppleCalendarConnected(false);
    setAppleSourceNames([]);
  }, [setAppleCalendarConnected]);

  useEffect(() => {
    if (!isMac) return;
    window.electronAPI?.acalGetConnectionStatus?.().then((status) => {
      if (status) {
        setAppleCalendarConnected(status.connected);
        setAppleSourceNames(status.sourceNames);
      }
    });
    const unsub = window.electronAPI?.onAcalConnectionChanged?.((data) => {
      setAppleCalendarConnected(data.connected);
      setAppleSourceNames(data.sourceNames ?? []);
    });
    return () => unsub?.();
  }, [isMac, setAppleCalendarConnected]);

  return (
    <IntegrationsPane title={title} description={t("integrations.notABot.description")}>
      <SettingsPanel>
        {isMac && (
          <ProviderRow
            icon={appleCalendarIcon}
            i18nKey="integrations.appleCalendar"
            connected={appleCalendarConnected}
            isConnecting={isAppleConnecting}
            onConnect={handleAppleConnect}
          />
        )}

        {isMac && appleCalendarConnected && (
          <SettingsPanelRow>
            <div className="group flex items-center gap-3 ps-12">
              <CalendarDays className="h-3.5 w-3.5 text-muted-foreground/70 shrink-0" />
              <span className="text-xs text-muted-foreground truncate flex-1">
                {appleSourceNames.join(" · ")}
              </span>
              <button
                onClick={() => setConfirmAppleDisconnect(true)}
                className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 p-1 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-all"
                aria-label={t("integrations.appleCalendar.disconnect")}
              >
                <Unlink className="h-3.5 w-3.5" />
              </button>
            </div>
          </SettingsPanelRow>
        )}
      </SettingsPanel>

      <ConfirmDialog
        open={showPermissionDialog}
        onOpenChange={setShowPermissionDialog}
        title={t("integrations.systemAudio.title")}
        description={t("integrations.systemAudio.description")}
        confirmText={
          systemAudio.mode === "native"
            ? t("integrations.systemAudio.openSettings")
            : t("onboarding.permissions.grantAccess")
        }
        onConfirm={systemAudio.mode === "native" ? systemAudio.openSettings : systemAudio.request}
      />

      <ConfirmDialog
        open={confirmAppleDisconnect}
        onOpenChange={setConfirmAppleDisconnect}
        title={t("integrations.appleCalendar.disconnectConfirm")}
        description={t("integrations.appleCalendar.disconnectDescription")}
        confirmText={t("integrations.appleCalendar.disconnect")}
        variant="destructive"
        onConfirm={handleAppleDisconnect}
      />

      <ConfirmDialog
        open={appleConnectError === "denied"}
        onOpenChange={(open) => !open && setAppleConnectError(null)}
        title={t("integrations.appleCalendar.permissionDenied")}
        description={t("integrations.appleCalendar.permissionDeniedDescription")}
        confirmText={t("integrations.appleCalendar.openSettings")}
        onConfirm={() => window.electronAPI?.openCalendarPrivacySettings?.()}
      />

      <AlertDialog
        open={appleConnectError === "failed"}
        onOpenChange={(open) => !open && setAppleConnectError(null)}
        title={t("integrations.appleCalendar.connectFailed")}
        description={t("integrations.appleCalendar.connectFailedDescription")}
        onOk={() => {}}
      />
    </IntegrationsPane>
  );
}
