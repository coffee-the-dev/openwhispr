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
  family: "gpt-oss" | "qwen" | "glm-5.3";
  reasoningEffort?: {
    /** Value that best approximates "thinking off" for reasoning_effort. */
    suppressValue: string;
    /** Levels Settings offers for this family. */
    options?: string[];
    /**
     * Effort for deterministic transforms (cleanup, selection edits). gpt-oss
     * defaults to medium; low cuts hidden reasoning tokens (latency) and the
     * tendency to answer the transcript instead of cleaning it. At higher
     * efforts gpt-oss can leave the whole reply in the reasoning channel and
     * return whitespace content, failing selection edits.
     */
    cleanupValue?: string;
    /**
     * Effort sent while thinking is on, for a family whose server default
     * reasons past the app's output caps. Without it the server's default applies.
     */
    defaultValue?: string;
  };
}

const FAMILIES: Array<ModelFamilyConstraints & { match: RegExp }> = [
  {
    family: "gpt-oss",
    match: /gpt-oss/,
    // gpt-oss accepts low|medium|high only; it has no off switch (#1611):
    // "none" is a 400.
    reasoningEffort: {
      suppressValue: "low",
      cleanupValue: "low",
      options: ["low", "medium", "high"],
    },
  },
  {
    family: "qwen",
    match: /qwen/,
    // qwen3 accepts none|default only; "none" is also what the generic
    // dialect sends everywhere, so the fact is server-agnostic.
    reasoningEffort: { suppressValue: "none", options: ["none"] },
  },
  {
    family: "glm-5.3",
    match: /glm[-_]?5[-.]?3/,
    // GLM-5.3/Flash always reason: low|high|max only, no off switch.
    // "low" is the closest to off. At the server default, max, a long meeting
    // spent the whole 4,096-token notes budget thinking (#2008); at high it fit,
    // so max isn't offered either.
    reasoningEffort: { suppressValue: "low", defaultValue: "high", options: ["low", "high"] },
  },
];

export function getModelFamilyConstraints(
  model: string | null | undefined
): ModelFamilyConstraints | null {
  const id = (model || "").toLowerCase();
  if (!id) return null;
  return FAMILIES.find((f) => f.match.test(id)) ?? null;
}
