import type { ComponentType } from "react";
import { Calendar, Terminal } from "../icons";

export type IntegrationsSection = "calendars" | "cli";

export const DEFAULT_INTEGRATIONS_SECTION: IntegrationsSection = "calendars";

export const INTEGRATIONS_SECTION_GROUPS: ReadonlyArray<{
  id: "meetings" | "developer";
  sections: readonly IntegrationsSection[];
}> = [
  { id: "meetings", sections: ["calendars"] },
  { id: "developer", sections: ["cli"] },
];

export const INTEGRATIONS_SECTION_ICONS: Record<
  IntegrationsSection,
  ComponentType<{ size?: number; className?: string }>
> = {
  calendars: Calendar,
  cli: Terminal,
};

export type SectionMeta = { kind: "count"; value: number };

export interface SectionMetaInput {
  connectedCalendars: number;
}

/** The status shown beside a section in the nav: how many are connected. */
export function sectionMeta(
  section: IntegrationsSection,
  { connectedCalendars }: SectionMetaInput
): SectionMeta | null {
  switch (section) {
    case "calendars":
      return connectedCalendars > 0 ? { kind: "count", value: connectedCalendars } : null;
    case "cli":
      return null;
  }
}

export const INTEGRATIONS_SECTIONS: readonly IntegrationsSection[] =
  INTEGRATIONS_SECTION_GROUPS.flatMap((group) => group.sections);
