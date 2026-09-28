// Whether a chat or voice-assistant request is sent with tool schemas.
//
// Each tool-capable scope stores "auto" | "on" | "off", or "" for the mode's
// default: "on" for a self-hosted server (vLLM, llama.cpp and Ollama builds
// serving Qwen, GLM and similar models parse tool calls), "auto" on-device.
// "auto" sends tools when the model id names a size large enough to call them
// reliably, or belongs to a family known to support them — small models answer
// tool schemas with noise.

export const TOOL_CALLING_SETTINGS = ["auto", "on", "off"];

const MIN_TOOL_PARAMS_B = 4;

// Families whose chat templates and servers handle OpenAI-style tool calls,
// matched against the model id whatever its size suffix says.
const KNOWN_TOOL_CAPABLE_FAMILIES = [
  /qwen[\d.]*/i,
  /glm/i,
  /llama-?3\.[1-9]/i,
  /llama-?4/i,
  /mistral/i,
  /mixtral/i,
  /hermes/i,
  /gpt-oss/i,
  /deepseek/i,
  /command-r/i,
  /granite/i,
];

export function normalizeToolCallingSetting(value) {
  return TOOL_CALLING_SETTINGS.includes(value) ? value : "";
}

export function defaultToolCallingSetting(mode) {
  return mode === "self-hosted" ? "on" : "auto";
}

export function effectiveToolCallingSetting(setting, mode) {
  return normalizeToolCallingSetting(setting) || defaultToolCallingSetting(mode);
}

export function estimateModelSizeB(modelId) {
  const match = String(modelId || "").match(/-([\d.]+)[bB](?![a-zA-Z])/);
  return match ? parseFloat(match[1]) : 0;
}

export function isKnownToolCapableModel(modelId) {
  const id = String(modelId || "");
  if (!id) return false;
  return KNOWN_TOOL_CAPABLE_FAMILIES.some((pattern) => pattern.test(id));
}

/**
 * @param {{ setting?: string, mode?: string, model?: string }} input
 * @returns {boolean}
 */
export function resolveToolCalling({ setting, mode, model }) {
  const effective = effectiveToolCallingSetting(setting, mode);
  if (effective === "on") return true;
  if (effective === "off") return false;
  const size = estimateModelSizeB(model);
  if (size > 0) return size >= MIN_TOOL_PARAMS_B;
  return isKnownToolCapableModel(model);
}
