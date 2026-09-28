import type { ReasoningConfig } from "../BaseReasoningService";
import { getLocalModel } from "../../models/ModelRegistry";
import { suppressThinking, type ThinkingDialect } from "./thinkingSuppressionDialects";

export function applyThinkingSuppression(
  requestBody: Record<string, unknown>,
  model: string,
  dialect: ThinkingDialect,
  config: ReasoningConfig
): void {
  if (config.disableThinking !== true) return;

  // A catalog model that cannot think needs no suppression; a self-hosted id
  // is unknown, so it always gets the switch.
  const localModel = getLocalModel(model);
  if (localModel && !localModel.supportsThinking) return;

  suppressThinking(requestBody, dialect, model);
}
