import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { CopyableCommand } from "../ui/CopyableCommand";
import { SectionLabel, SettingsPanel, SettingsPanelRow } from "../ui/SettingsSection";
import { IntegrationsPane } from "./IntegrationsPane";

const CLI_DOCS_URL = "https://docs.openwhispr.com/cli/install";
const INSTALL_CMD = "npm install -g @openwhispr/cli";
const LOCAL_EXAMPLE = "openwhispr --local notes list";

interface CliPaneProps {
  title: string;
}

export function CliPane({ title }: CliPaneProps): ReactElement {
  const { t } = useTranslation();

  return (
    <IntegrationsPane
      title={title}
      description={t("integrations.cli.description")}
      docsUrl={CLI_DOCS_URL}
    >
      <div>
        <SectionLabel>{t("integrations.cli.installLabel")}</SectionLabel>
        <CopyableCommand command={INSTALL_CMD} />
      </div>

      <SettingsPanel>
        <SettingsPanelRow className="space-y-2.5">
          <div>
            <h3 className="text-xs font-semibold text-foreground">
              {t("integrations.cli.local.label")}
            </h3>
            <p className="text-xs text-muted-foreground/70 mt-0.5 leading-relaxed">
              {t("integrations.cli.local.description")}
            </p>
          </div>
          <CopyableCommand command={LOCAL_EXAMPLE} />
        </SettingsPanelRow>
      </SettingsPanel>
    </IntegrationsPane>
  );
}
