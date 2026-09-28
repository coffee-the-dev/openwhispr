import { BaseReasoningService, ReasoningConfig } from "./BaseReasoningService";
import { withRetry, createApiRetryStrategy, httpError } from "../utils/retry";
import { TOKEN_LIMITS, buildApiUrl } from "../config/constants";
import logger from "../utils/logger";
import { assertValidCleanupOutput } from "../utils/cleanupOutput";
import { getSettings } from "../stores/settingsStore";
import { wrapCleanupTranscript } from "../config/prompts";
import { stripThinkingTags } from "../helpers/stripThinking.js";
import {
  getLlmRequestTimeoutSeconds,
  llmRequestTimeoutError,
} from "../helpers/llmRequestTimeout.js";
import { streamText, stepCountIs } from "ai";
import { getAIModel } from "./ai/providers";
import { PROVIDER_REGISTRY, type ProviderContext } from "./ai/inferenceProviders";
import { resolveSelfHostedOpenAIBase } from "./ai/openaiBase";
import {
  applyChatCompletionsParams,
  emptyResponseError,
  fetchWithParamFallback,
  isTruncatedFinishReason,
  truncatedOutputError,
} from "./ai/chatRequestBody";
import { createStreamingThinkFilter } from "./ai/streamingThinkFilter";
import { extractApiErrorMessage } from "./ai/apiErrorMessage";
import { resolveChatRoute } from "../helpers/chatRouting";
import i18n from "../i18n";

export type ToolMetadata = Record<string, unknown> | Array<Record<string, unknown>>;

export type AgentStreamChunk =
  | { type: "content"; text: string }
  | { type: "tool_calls"; calls: Array<{ id: string; name: string; arguments: string }> }
  | {
      type: "tool_result";
      callId: string;
      toolName: string;
      displayText: string;
      metadata?: ToolMetadata;
    }
  | { type: "done"; finishReason?: string };

function logParamFallback(logEvent: string) {
  return (details: { status: number; stripped: string[] }) =>
    logger.logReasoning(logEvent, details);
}

// Either the on-device llama.cpp server or the user's self-hosted server, as
// the Chat Completions endpoint and key a streaming request should use.
interface StreamingTarget {
  kind: "local" | "self-hosted";
  baseURL: string;
  apiKey: string;
}

class ReasoningService extends BaseReasoningService {
  private static readonly MAX_TOOL_STEPS = 20;
  private streamAbortController: AbortController | null = null;
  private activeRequestControllers = new Set<AbortController>();
  private requestCancellationGeneration = 0;

  private readonly providerContext: ProviderContext;

  constructor() {
    super();
    this.providerContext = {
      getSystemPrompt: this.getSystemPrompt.bind(this),
      callChatCompletionsApi: this.callChatCompletionsApi.bind(this),
    };

    if (typeof window !== "undefined") {
      window.addEventListener("beforeunload", () => this.destroy());
    }
  }

  private async callChatCompletionsApi(
    endpoint: string,
    apiKey: string,
    model: string,
    text: string,
    agentName: string | null,
    config: ReasoningConfig
  ): Promise<string> {
    // No systemPrompt override means the default cleanup path: a deterministic
    // transform, so zero temperature and a delimited transcript.
    const isCleanup = !config.systemPrompt;
    const systemPrompt = config.systemPrompt || this.getSystemPrompt(agentName);
    const userPrompt = isCleanup ? wrapCleanupTranscript(text) : text;

    const messages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ];

    const requestBody: Record<string, unknown> = { model, messages };
    applyChatCompletionsParams(requestBody, {
      model,
      dialect: "lan",
      config,
      maxTokens:
        config.maxTokens ||
        Math.max(
          4096,
          this.calculateMaxTokens(
            text.length,
            TOKEN_LIMITS.MIN_TOKENS,
            TOKEN_LIMITS.MAX_TOKENS,
            TOKEN_LIMITS.TOKEN_MULTIPLIER
          )
        ),
    });

    logger.logReasoning("LAN_REQUEST", {
      endpoint,
      model,
      hasApiKey: !!apiKey,
      requestBody: JSON.stringify(requestBody).substring(0, 200),
    });

    const requestGeneration = this.requestCancellationGeneration;
    const response = await withRetry(async () => {
      if (requestGeneration !== this.requestCancellationGeneration) {
        throw httpError("Request cancelled", 499);
      }
      const controller = new AbortController();
      this.activeRequestControllers.add(controller);
      const timeoutSeconds = getLlmRequestTimeoutSeconds({ scope: config.inferenceScope });
      const timeoutId = setTimeout(() => controller.abort(), timeoutSeconds * 1000);
      try {
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (apiKey) {
          headers["Authorization"] = `Bearer ${apiKey}`;
        }

        const res = await fetchWithParamFallback(
          () =>
            fetch(endpoint, {
              method: "POST",
              headers,
              body: JSON.stringify(requestBody),
              signal: controller.signal,
            }),
          requestBody,
          logParamFallback("LAN_PARAM_FALLBACK")
        );

        if (!res.ok) {
          const errorText = await res.text();
          let errorData: unknown = { error: res.statusText };

          try {
            errorData = JSON.parse(errorText);
          } catch {
            errorData = { error: errorText || res.statusText };
          }

          const errorMessage = extractApiErrorMessage(errorData, `API error: ${res.status}`);

          logger.logReasoning("LAN_API_ERROR_DETAIL", {
            status: res.status,
            statusText: res.statusText,
            error: errorData,
            errorMessage,
            fullResponse: errorText.substring(0, 500),
          });
          throw httpError(errorMessage, res.status);
        }

        const jsonResponse = await res.json();

        logger.logReasoning("LAN_RAW_RESPONSE", {
          hasResponse: !!jsonResponse,
          responseKeys: jsonResponse ? Object.keys(jsonResponse) : [],
          hasChoices: !!jsonResponse?.choices,
          choicesLength: jsonResponse?.choices?.length || 0,
          fullResponse: JSON.stringify(jsonResponse).substring(0, 500),
        });

        return jsonResponse;
      } catch (error) {
        if ((error as Error).name === "AbortError") {
          if (requestGeneration !== this.requestCancellationGeneration) {
            throw httpError("Request cancelled", 499);
          }
          throw llmRequestTimeoutError(timeoutSeconds);
        }
        throw error;
      } finally {
        clearTimeout(timeoutId);
        this.activeRequestControllers.delete(controller);
      }
    }, createApiRetryStrategy());

    if (!response.choices || !response.choices[0]) {
      logger.logReasoning("LAN_RESPONSE_ERROR", {
        model,
        response: JSON.stringify(response).substring(0, 500),
        hasChoices: !!response.choices,
        choicesCount: response.choices?.length || 0,
      });
      throw new Error("Invalid response structure from the self-hosted server");
    }

    const choice = response.choices[0];
    if (config.requireCompleteOutput && isTruncatedFinishReason(choice?.finish_reason)) {
      throw truncatedOutputError();
    }
    // Reasoning models leak <think> blocks into non-streamed output; strip them
    // unless the user explicitly enabled thinking (same default as streaming).
    const rawContent = choice.message?.content?.trim() || "";
    const responseText =
      config.disableThinking !== false ? stripThinkingTags(rawContent) : rawContent;

    if (!responseText) {
      logger.logReasoning("LAN_EMPTY_RESPONSE", {
        model,
        finishReason: choice.finish_reason,
        hasMessage: !!choice.message,
        response: JSON.stringify(choice).substring(0, 500),
      });
      throw (
        emptyResponseError(
          "Self-hosted server",
          config,
          isTruncatedFinishReason(choice.finish_reason)
        ) ?? new Error("Self-hosted server returned an empty response")
      );
    }

    logger.logReasoning("LAN_RESPONSE", {
      model,
      responseLength: responseText.length,
      tokensUsed: response.usage?.total_tokens || 0,
      success: true,
    });

    return responseText;
  }

  async processText(
    text: string,
    model: string = "",
    agentName: string | null = null,
    config: ReasoningConfig = {}
  ): Promise<string> {
    config = { ...config, inferenceScope: config.inferenceScope || "dictationCleanup" };
    const trimmedModel = model?.trim?.() || "";
    const settings = getSettings();
    const validateCleanup =
      config.inferenceScope === "dictationCleanup" &&
      !config.systemPrompt &&
      !config.requiresAgent &&
      !settings.customPrompts.cleanup;
    // A call with no route of its own runs on the Dictation Cleanup scope.
    const isImplicitCleanup = config.provider === undefined && config.lanUrl === undefined;
    const dispatchConfig: ReasoningConfig = isImplicitCleanup
      ? { ...config, provider: settings.cleanupMode === "self-hosted" ? "lan" : "local" }
      : config;
    // Catalog family ids (qwen, gemma, …) all run on the one local runtime.
    const providerId =
      dispatchConfig.lanUrl || dispatchConfig.provider === "lan"
        ? "lan"
        : dispatchConfig.provider
          ? "local"
          : "";
    if (!providerId) {
      throw new Error("No reasoning provider selected");
    }

    if (!trimmedModel && providerId === "local") {
      throw new Error("No reasoning model selected");
    }

    logger.logReasoning("PROVIDER_SELECTION", {
      provider: providerId,
      model: trimmedModel,
      agentName,
      textLength: text.length,
    });

    const handler = PROVIDER_REGISTRY[providerId];
    const startTime = Date.now();
    try {
      const result = await handler.call({
        text,
        model: trimmedModel,
        agentName,
        config: dispatchConfig,
        ctx: this.providerContext,
      });

      if (validateCleanup) assertValidCleanupOutput(text, result);

      logger.logReasoning("PROVIDER_SUCCESS", {
        provider: providerId,
        model: trimmedModel,
        processingTimeMs: Date.now() - startTime,
        resultLength: result.length,
      });

      return result;
    } catch (error) {
      logger.logReasoning("PROVIDER_ERROR", {
        provider: providerId,
        model: trimmedModel,
        error: (error as Error).message,
      });
      throw error;
    }
  }

  // Starts the local llama-server when needed, so a cancel during setup is
  // honored before any request goes out.
  private async resolveStreamingTarget(
    model: string,
    provider: string,
    config: Pick<ReasoningConfig, "lanUrl" | "customApiKey">
  ): Promise<StreamingTarget> {
    const route = resolveChatRoute({
      provider,
      lanUrl: config.lanUrl,
      customApiKey: config.customApiKey,
    });
    if (route.kind === "self-hosted") {
      if (!route.baseUrl) throw new Error(i18n.t("reasoning.custom.enterEndpoint"));
      return {
        kind: "self-hosted",
        baseURL: resolveSelfHostedOpenAIBase(route.baseUrl),
        apiKey: route.apiKey,
      };
    }
    const serverResult = await window.electronAPI.llamaServerStart(model);
    if (!serverResult.success || !serverResult.port) {
      throw new Error(serverResult.error || "Failed to start local model server");
    }
    return { kind: "local", baseURL: `http://127.0.0.1:${serverResult.port}/v1`, apiKey: "" };
  }

  async *processTextStreaming(
    messages: Array<{ role: string; content: string }>,
    model: string,
    provider: string,
    config: ReasoningConfig & { systemPrompt: string }
  ): AsyncGenerator<string, void, unknown> {
    const abortController = new AbortController();
    this.streamAbortController = abortController;
    try {
      yield* this.processTextStreamingRaw(messages, model, provider, config, abortController);
    } finally {
      if (this.streamAbortController === abortController) {
        this.streamAbortController = null;
      }
    }
  }

  private async *processTextStreamingRaw(
    messages: Array<{ role: string; content: string }>,
    model: string,
    provider: string,
    config: ReasoningConfig & { systemPrompt: string },
    abortController: AbortController
  ): AsyncGenerator<string, void, unknown> {
    const target = await this.resolveStreamingTarget(model, provider, config);
    const endpoint = buildApiUrl(target.baseURL, "/chat/completions");

    if (abortController.signal.aborted) return;

    const requestBody: Record<string, unknown> = {
      model,
      messages,
      stream: true,
    };

    applyChatCompletionsParams(requestBody, {
      model,
      dialect: target.kind === "self-hosted" ? "lan" : "local",
      config,
      maxTokens: config.maxTokens || Math.max(4096, TOKEN_LIMITS.MAX_TOKENS),
    });

    logger.logReasoning("AGENT_STREAM_REQUEST", {
      endpoint,
      model,
      kind: target.kind,
      messageCount: messages.length,
    });

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (target.apiKey) {
      headers["Authorization"] = `Bearer ${target.apiKey}`;
    }

    const timeoutSeconds = getLlmRequestTimeoutSeconds({ streaming: true });
    let timeoutTriggered = false;
    const timeoutId = setTimeout(() => {
      if (abortController.signal.aborted) return;
      timeoutTriggered = true;
      abortController.abort();
    }, timeoutSeconds * 1000);

    let response: Response;
    try {
      response = await fetchWithParamFallback(
        () =>
          fetch(endpoint, {
            method: "POST",
            headers,
            body: JSON.stringify(requestBody),
            signal: abortController.signal,
          }),
        requestBody,
        logParamFallback("AGENT_STREAM_PARAM_FALLBACK")
      );
    } catch (error) {
      clearTimeout(timeoutId);
      if ((error as Error).name === "AbortError" && abortController.signal.aborted) {
        if (!timeoutTriggered) return;
        throw new Error("Streaming request timed out");
      }
      throw error;
    }

    if (!response.ok) {
      clearTimeout(timeoutId);
      const errorText = await response.text();
      let errorMessage: string;
      try {
        const errorData = JSON.parse(errorText);
        errorMessage = extractApiErrorMessage(errorData, `API error: ${response.status}`);
      } catch {
        errorMessage = errorText || `API error: ${response.status}`;
      }
      logger.logReasoning("AGENT_STREAM_ERROR", { status: response.status, errorMessage });
      throw new Error(errorMessage);
    }

    const reader = response.body?.getReader();
    if (!reader) {
      clearTimeout(timeoutId);
      throw new Error("No response body");
    }

    const decoder = new TextDecoder();
    let buffer = "";
    const filterThinkTags = config.disableThinking !== false ? createStreamingThinkFilter() : null;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith("data: ")) continue;

          const data = trimmed.slice(6);
          if (data === "[DONE]") {
            const trailing = filterThinkTags?.finish();
            if (trailing) yield trailing;
            return;
          }

          try {
            const parsed = JSON.parse(data);
            let content = parsed.choices?.[0]?.delta?.content;
            if (!content) continue;

            if (filterThinkTags) {
              content = filterThinkTags(content);
              if (!content) continue;
            }

            yield content;
          } catch {
            // skip malformed SSE chunks
          }
        }
      }

      const trailing = filterThinkTags?.finish();
      if (trailing) yield trailing;
    } catch (error) {
      if ((error as Error).name === "AbortError" && abortController.signal.aborted) {
        if (!timeoutTriggered) return;
        throw new Error("Streaming request timed out");
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
      reader.releaseLock();
    }
  }

  async *processTextStreamingAI(
    // Content is a string, or text+image parts when a screenshot rides along
    // (image-capable providers only — the caller drops it elsewhere).
    messages: Array<{ role: string; content: string | Array<Record<string, unknown>> }>,
    model: string,
    provider: string,
    config: ReasoningConfig & { systemPrompt: string },
    tools?: Record<string, import("ai").Tool>
  ): AsyncGenerator<AgentStreamChunk, void, unknown> {
    config = { ...config, inferenceScope: config.inferenceScope || "chatIntelligence" };
    // Both streaming transports share this owner so cancellation survives
    // asynchronous server and model setup.
    const abortController = new AbortController();
    this.streamAbortController = abortController;

    if (!tools) {
      // Attachments are never routed to text-only streaming, so content is string-only here.
      try {
        const contentGen = this.processTextStreamingRaw(
          messages as Array<{ role: string; content: string }>,
          model,
          provider,
          config,
          abortController
        );
        for await (const text of contentGen) {
          yield { type: "content", text };
        }
        yield { type: "done", finishReason: "stop" };
      } catch (error) {
        if (abortController.signal.aborted && (error as Error).name === "AbortError") return;
        throw error;
      } finally {
        if (this.streamAbortController === abortController) {
          this.streamAbortController = null;
        }
      }
      return;
    }

    const filterThinkTags = config.disableThinking !== false ? createStreamingThinkFilter() : null;
    const target = await this.resolveStreamingTarget(model, provider, config);
    const aiModel = getAIModel(model, target.apiKey, target.baseURL);

    if (abortController.signal.aborted) {
      yield { type: "done", finishReason: "stop" };
      return;
    }

    logger.logReasoning("AGENT_AI_SDK_STREAM_REQUEST", {
      model,
      kind: target.kind,
      hasTools: !!tools,
      toolCount: Object.keys(tools).length,
      messageCount: messages.length,
    });

    const result = streamText({
      model: aiModel,
      messages: messages.map((m) => ({
        role: m.role as "system" | "user" | "assistant",
        content: m.content,
      })) as import("ai").ModelMessage[],
      tools,
      stopWhen: stepCountIs(ReasoningService.MAX_TOOL_STEPS),
      abortSignal: abortController.signal,
      temperature: config.temperature ?? 0.3,
      maxOutputTokens: config.maxTokens || 4096,
    });

    let canFlushFilteredText = true;
    const finishFilteredText = (): string => {
      const trailing = filterThinkTags?.finish() ?? "";
      return canFlushFilteredText ? trailing : "";
    };

    try {
      for await (const chunk of result.fullStream) {
        if (chunk.type === "text-delta") {
          const text = filterThinkTags ? filterThinkTags(chunk.text) : chunk.text;
          if (text) yield { type: "content", text };
        } else if (chunk.type === "text-end" || chunk.type === "finish-step") {
          const trailing = finishFilteredText();
          if (trailing) yield { type: "content", text: trailing };
        } else if (chunk.type === "tool-call") {
          yield {
            type: "tool_calls",
            calls: [
              {
                id: chunk.toolCallId,
                name: chunk.toolName,
                arguments: JSON.stringify(chunk.input),
              },
            ],
          };
        } else if (chunk.type === "tool-result") {
          const output = chunk.output;
          const displayText =
            typeof output === "string" ? output : output?.error ? String(output.error) : "Done";
          yield {
            type: "tool_result",
            callId: chunk.toolCallId,
            toolName: chunk.toolName,
            displayText,
          };
        } else if (chunk.type === "abort") {
          canFlushFilteredText = false;
          finishFilteredText();
        } else if (chunk.type === "error") {
          // streamText reports provider failures as error parts and then ends
          // the stream; swallowing them leaves callers with an empty reply and
          // no terminal signal. Re-throw unless we aborted on purpose.
          canFlushFilteredText = false;
          finishFilteredText();
          if (!abortController.signal.aborted) {
            const cause = (chunk as { error?: unknown }).error;
            throw cause instanceof Error ? cause : new Error(String(cause ?? "Stream failed"));
          }
        } else if (chunk.type === "finish") {
          const trailing = finishFilteredText();
          if (trailing) yield { type: "content", text: trailing };
          yield { type: "done", finishReason: chunk.finishReason };
        }
      }
    } catch (error) {
      canFlushFilteredText = false;
      finishFilteredText();
      if (abortController.signal.aborted) {
        yield { type: "done", finishReason: "stop" };
        return;
      }
      throw error;
    } finally {
      if (this.streamAbortController === abortController) {
        this.streamAbortController = null;
      }
    }
  }

  /** Aborts the chat/agent stream only (panel Esc, chat surface unmount). */
  cancelActiveStream(): void {
    this.streamAbortController?.abort();
    this.streamAbortController = null;
  }

  /**
   * Aborts everything in flight in this renderer: the chat stream plus every
   * single-shot request (cleanup, selection edit, titles). Used by the
   * dictation cancel path, never by chat lifecycle — a note or tab switch must
   * not kill unrelated reasoning work.
   */
  cancelAllRequests(): void {
    this.requestCancellationGeneration += 1;
    for (const controller of this.activeRequestControllers) controller.abort();
    this.activeRequestControllers.clear();
    this.cancelActiveStream();
  }

  async isAvailable(): Promise<boolean> {
    try {
      const settings = getSettings();
      if (settings.cleanupMode === "self-hosted") {
        const configured = !!settings.cleanupRemoteUrl?.trim();
        logger.logReasoning("AVAILABILITY_CHECK", { selfHosted: true, configured });
        return configured;
      }

      const localAvailable = !!(await window.electronAPI?.checkLocalReasoningAvailable?.());
      logger.logReasoning("AVAILABILITY_CHECK", { local: true, localAvailable });
      return localAvailable;
    } catch (error) {
      logger.logReasoning("AVAILABILITY_CHECK_ERROR", {
        error: (error as Error).message,
        stack: (error as Error).stack,
        name: (error as Error).name,
      });
      return false;
    }
  }

  destroy(): void {
    this.cancelAllRequests();
  }
}

export default new ReasoningService();
