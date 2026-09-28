import { getModelFamilyConstraints } from "./modelFamilyConstraints";

/**
 * How each runtime wants a model's thinking turned off. Model-family
 * constraints (which reasoning_effort values a family accepts) come from
 * modelFamilyConstraints; this module only knows how the on-device llama.cpp
 * server and self-hosted OpenAI-compatible servers want the suppression
 * expressed. Kept free of heavier runtime imports so it stays unit-testable.
 */
export type ThinkingDialect = "local" | "lan";

export function suppressThinking(
  requestBody: Record<string, unknown>,
  dialect: ThinkingDialect,
  model: string | null | undefined
): void {
  const family = getModelFamilyConstraints(model);

  if (dialect === "local") {
    requestBody.think = false;
  } else {
    // `lan` always talks to an OpenAI-compat /v1 endpoint: the `reasoning` object
    // disables Ollama thinking; other backends drop it (flat reasoning_effort trips vLLM).
    // The effort value is the family's — gpt-oss has no off switch, so "none" would
    // contradict the "low" cleanup pin the same body carries.
    requestBody.reasoning = { effort: family?.reasoningEffort?.suppressValue ?? "none" };
  }
  requestBody.chat_template_kwargs = { enable_thinking: false };
}
