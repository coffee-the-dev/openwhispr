import { getModelFamilyConstraints } from "../services/ai/modelFamilyConstraints";
import type { ThinkingDialect } from "../services/ai/thinkingSuppressionDialects";

export interface ReasoningEffortCapability {
  options: string[];
  defaultValue?: string;
}

export const AUTO_REASONING_EFFORT = "";

const OPEN_ENDPOINT_OPTIONS = ["none", "minimal", "low", "medium", "high", "xhigh"];

export function getReasoningEffortCapability(
  dialect: ThinkingDialect,
  model: string
): ReasoningEffortCapability | null {
  const familyOptions = getModelFamilyConstraints(model)?.reasoningEffort?.options;
  // A self-hosted server serves models the registry doesn't describe, so it
  // offers the family's levels, else the OpenAI-style list. On-device models
  // offer only their family's. The server's default is unknown, so none is named.
  if (dialect === "lan") return { options: familyOptions ?? OPEN_ENDPOINT_OPTIONS };
  return familyOptions ? { options: familyOptions } : null;
}

export function isReasoningEffortSupported(
  capability: ReasoningEffortCapability | null | undefined,
  value: string | null | undefined
): boolean {
  return !!capability && !!value && capability.options.includes(value);
}

export function hasSelectableReasoningEffort(
  capability: ReasoningEffortCapability | null | undefined
): capability is ReasoningEffortCapability {
  return Boolean(capability && capability.options.length > 1);
}
