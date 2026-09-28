/**
 * Request constraints that belong to a model family, independent of which
 * server runs it. Storing a family fact inside a server branch is what broke
 * gpt-oss (#1611: the "no reasoning off switch" rule lived under one provider,
 * so every other server sent the rejected "none"). New family facts must land
 * here, never in a runtime conditional.
 *
 * Kept free of runtime imports so the table stays unit-testable on its own,
 * like thinkingSuppressionDialects.
 */
export interface ModelFamilyConstraints {
  family: "gpt-oss" | "qwen";
  reasoningEffort?: {
    /** Value that best approximates "thinking off" for reasoning_effort. */
    suppressValue: string;
    /**
     * Effort for deterministic transforms (cleanup, selection edits). gpt-oss
     * defaults to medium; low cuts hidden reasoning tokens (latency) and the
     * tendency to answer the transcript instead of cleaning it. At higher
     * efforts gpt-oss can leave the whole reply in the reasoning channel and
     * return whitespace content, failing selection edits.
     */
    cleanupValue?: string;
  };
}

const FAMILIES: Array<ModelFamilyConstraints & { match: RegExp }> = [
  {
    family: "gpt-oss",
    match: /gpt-oss/,
    // gpt-oss accepts low|medium|high only; it has no off switch (#1611):
    // "none" is a 400.
    reasoningEffort: { suppressValue: "low", cleanupValue: "low" },
  },
  {
    family: "qwen",
    match: /qwen/,
    // qwen3 accepts none|default only; "none" is also what the generic
    // dialect sends everywhere, so the fact is server-agnostic.
    reasoningEffort: { suppressValue: "none" },
  },
];

export function getModelFamilyConstraints(
  model: string | null | undefined
): ModelFamilyConstraints | null {
  const id = (model || "").toLowerCase();
  if (!id) return null;
  return FAMILIES.find((f) => f.match.test(id)) ?? null;
}
