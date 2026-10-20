import { useEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { useSettingsStore } from "../stores/settingsStore";
import { IntegrationsNav } from "./integrations/IntegrationsNav";
import { CalendarsPane } from "./integrations/CalendarsPane";
import { CliPane } from "./integrations/CliPane";
import {
  INTEGRATIONS_SECTIONS,
  sectionMeta,
  type IntegrationsSection,
  type SectionMeta,
} from "./integrations/integrationsSections";

interface IntegrationsViewProps {
  section: IntegrationsSection;
  onSectionChange: (section: IntegrationsSection) => void;
}

export default function IntegrationsView({
  section: requestedSection,
  onSectionChange,
}: IntegrationsViewProps): ReactElement {
  const { t } = useTranslation();
  const isMac = window.electronAPI?.getPlatform?.() === "darwin";
  // Apple Calendar is the only calendar source, so Calendars exists on macOS only.
  const sections = isMac
    ? INTEGRATIONS_SECTIONS
    : INTEGRATIONS_SECTIONS.filter((id) => id !== "calendars");
  const section = sections.includes(requestedSection) ? requestedSection : sections[0];
  const connectedCalendars = useSettingsStore((state) =>
    isMac && state.appleCalendarConnected ? 1 : 0
  );
  // A section stays mounted once opened, so a connect or dialog in it survives
  // a visit to another section. Calendars always mounts: its connection
  // listeners keep the nav's count fresh.
  const [mounted, setMounted] = useState<ReadonlySet<IntegrationsSection>>(
    () => new Set<IntegrationsSection>(["calendars", section])
  );
  if (!mounted.has(section)) setMounted(new Set(mounted).add(section));
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scroller.current) scroller.current.scrollTop = 0;
  }, [section]);

  const meta = Object.fromEntries(
    INTEGRATIONS_SECTIONS.map((id) => [id, sectionMeta(id, { connectedCalendars })])
  ) as Record<IntegrationsSection, SectionMeta | null>;
  const titleOf = (id: IntegrationsSection): string => t(`integrations.nav.sections.${id}`);

  const panes: Record<IntegrationsSection, ReactNode> = {
    calendars: <CalendarsPane title={titleOf("calendars")} />,
    cli: <CliPane title={titleOf("cli")} />,
  };

  return (
    <div className="@container flex h-full min-h-0">
      <IntegrationsNav
        sections={sections}
        active={section}
        meta={meta}
        onSelect={onSectionChange}
        className="@max-2xl:hidden"
      />

      <div className="flex-1 min-w-0 flex flex-col">
        {/* Outside the scroller, so it stays in view and keeps focus after a pick. */}
        <div className="px-5 pt-6 pb-2 @2xl:hidden">
          <Select
            value={section}
            onValueChange={(value) => onSectionChange(value as IntegrationsSection)}
          >
            <SelectTrigger
              className="h-8 w-full text-xs rounded-lg"
              aria-label={t("integrations.nav.label")}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {sections.map((id) => (
                <SelectItem key={id} value={id}>
                  {titleOf(id)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div ref={scroller} className="flex-1 min-h-0 overflow-y-auto px-8 pt-6 pb-6 @max-2xl:px-5">
          <div className="max-w-[760px]">
            {sections
              .filter((id) => mounted.has(id))
              .map((id) => (
                <div key={id} hidden={id !== section}>
                  {panes[id]}
                </div>
              ))}
          </div>
        </div>
      </div>
    </div>
  );
}
