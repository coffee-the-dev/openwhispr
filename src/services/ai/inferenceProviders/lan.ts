import type { InferenceProvider } from "./types";
import { buildApiUrl } from "../../../config/constants";
import { getSettings } from "../../../stores/settingsStore";
import logger from "../../../utils/logger";
import { resolveSelfHostedOpenAIBase } from "../openaiBase";
import { resolveSelfHostedModel } from "../selfHostedDefaultModel";

async function currentCleanupApiKey(): Promise<string> {
  try {
    const key = await window.electronAPI?.getCleanupCustomKey?.();
    if (key?.trim()) return key.trim();
  } catch (err) {
    logger.logReasoning("CUSTOM_KEY_IPC_FALLBACK", { error: (err as Error)?.message });
  }
  return getSettings().cleanupCustomApiKey?.trim() || "";
}

export const lanProvider: InferenceProvider = {
  id: "lan",
  async call({ text, model, agentName, config, ctx }) {
    const isAgentCall = !!config.lanUrl;
    const settings = getSettings();
    const lanUrl = (config.lanUrl || settings.cleanupRemoteUrl).trim();
    logger.logReasoning("LAN_START", { url: lanUrl, agentName, model });

    try {
      const baseUrl = resolveSelfHostedOpenAIBase(lanUrl);
      const endpoint = buildApiUrl(baseUrl, "/chat/completions");
      // Ask for the cleanup key at call time: the store copy in the dictation
      // panel is only hydrated at startup, so a key saved in the control panel
      // later would not be sent.
      const apiKey =
        config.customApiKey?.trim() || (isAgentCall ? "" : await currentCleanupApiKey());
      const resolvedModel = await resolveSelfHostedModel(baseUrl, apiKey, model || "");
      return await ctx.callChatCompletionsApi(
        endpoint,
        apiKey,
        resolvedModel,
        text,
        agentName,
        config
      );
    } catch (error) {
      logger.logReasoning("LAN_ERROR", {
        url: lanUrl,
        error: (error as Error).message,
        errorType: (error as Error).name,
      });
      throw error;
    }
  },
};
