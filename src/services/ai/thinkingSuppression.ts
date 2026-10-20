import type { ReasoningConfig } from "../BaseReasoningService";
import { getLocalModel } from "../../models/ModelRegistry";
import { suppressThinking, type ThinkingDialect } from "./thinkingSuppressionDialects";

export function isThinkingSuppressed(model: string, config: ReasoningConfig): boolean {
  if (config.disableThinking !== true) return false;

  // A catalog model that cannot think needs no suppression; a self-hosted id
  // is unknown, so it always gets the switch.
  const localModel = getLocalModel(model);
  return !localModel || !!localModel.supportsThinking;
}

/** Returns whether it suppressed thinking. */
export function applyThinkingSuppression(
  requestBody: Record<string, unknown>,
  model: string,
  dialect: ThinkingDialect,
  config: ReasoningConfig
): boolean {
  if (!isThinkingSuppressed(model, config)) return false;
  suppressThinking(requestBody, dialect, model);
  return true;
}
