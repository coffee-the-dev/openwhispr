import type { InferenceProvider } from "./types";
import { wrapCleanupTranscript } from "../../../config/prompts";
import logger from "../../../utils/logger";
import { buildLocalInferenceError } from "../../../utils/localInferenceError";
import { chosenReasoningEffort } from "../chatRequestBody";

export const localProvider: InferenceProvider = {
  id: "local",
  async call({ text, model, agentName, config, ctx }) {
    if (typeof window === "undefined" || !window.electronAPI) {
      throw new Error("Local reasoning is not available in this environment");
    }

    logger.logReasoning("LOCAL_START", { model, agentName, environment: "browser" });
    const startTime = Date.now();

    logger.logReasoning("LOCAL_IPC_CALL", { model, textLength: text.length });

    const systemPrompt = config.systemPrompt || ctx.getSystemPrompt(agentName, config.toneStyle);
    const userContent = config.systemPrompt ? text : wrapCleanupTranscript(text);
    const result = await window.electronAPI.processLocalReasoning(userContent, model, agentName, {
      ...config,
      systemPrompt,
      // Only a level Settings offers for this model reaches the server.
      reasoningEffort: chosenReasoningEffort("local", model, config),
    });

    const processingTimeMs = Date.now() - startTime;

    if (!result.success) {
      logger.logReasoning("LOCAL_ERROR", { model, processingTimeMs, error: result.error });
      throw buildLocalInferenceError(result);
    }

    logger.logReasoning("LOCAL_SUCCESS", {
      model,
      processingTimeMs,
      resultLength: result.text.length,
    });
    return result.text;
  },
};
