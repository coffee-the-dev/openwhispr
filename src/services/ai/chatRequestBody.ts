import type { ReasoningConfig } from "../BaseReasoningService";
import {
  getReasoningEffortCapability,
  hasSelectableReasoningEffort,
  isReasoningEffortSupported,
  type ReasoningEffortCapability,
} from "../../models/reasoningEffort";
import { getModelFamilyConstraints } from "./modelFamilyConstraints";
import { applyThinkingSuppression } from "./thinkingSuppression";
import type { ThinkingDialect } from "./thinkingSuppressionDialects";

/**
 * Single place that turns (model, runtime, config) into the parameter set of
 * an OpenAI-compatible chat-completions body: token limit, temperature,
 * reasoning effort, and thinking suppression. Callers own
 * `model`/`messages`/`stream`; this owns every tunable param, so a family fact
 * changed in the data tables reaches all transports at once (#1611). Both the
 * on-device llama.cpp server and self-hosted servers speak the classic shape:
 * `max_tokens` plus `temperature`.
 */
export function applyChatCompletionsParams(
  requestBody: Record<string, unknown>,
  {
    model,
    dialect,
    config,
    maxTokens,
  }: {
    model: string;
    dialect: ThinkingDialect;
    config: ReasoningConfig;
    maxTokens: number;
  }
): void {
  // No systemPrompt override means the default cleanup path: a deterministic
  // transform, so zero temperature.
  requestBody.max_tokens = maxTokens;
  requestBody.temperature = config.temperature ?? (config.systemPrompt ? 0.3 : 0);

  // The user's chosen effort wins; otherwise deterministic transforms
  // (cleanup, selection edits) pin the family's preferred effort — see
  // modelFamilyConstraints for the gpt-oss rationale. A suppressed request has
  // no chosen effort, so applyThinkingSuppression still decides it.
  const familyEffort = getModelFamilyConstraints(model)?.reasoningEffort;
  const effort = chosenReasoningEffort(dialect, model, config);
  if (effort) {
    requestBody.reasoning_effort = effort;
  } else if (familyEffort?.cleanupValue && isDeterministicTransform(config)) {
    requestBody.reasoning_effort = familyEffort.cleanupValue;
  }

  const suppressed = applyThinkingSuppression(requestBody, model, dialect, config);
  // Some dialects suppress through other fields, so a default effort beside
  // them would contradict the suppression.
  if (!suppressed && !effort && familyEffort?.defaultValue) {
    requestBody.reasoning_effort ??= familyEffort.defaultValue;
  }
}

/**
 * The levels Settings offers for this runtime and model, or null when it
 * shows no picker: "Disable thinking output" is on, or the model has fewer
 * than two.
 */
export function selectableReasoningEffort(
  dialect: ThinkingDialect,
  model: string,
  config: ReasoningConfig
): ReasoningEffortCapability | null {
  if (!model || config.disableThinking === true) return null;
  const capability = getReasoningEffortCapability(dialect, model);
  return hasSelectableReasoningEffort(capability) ? capability : null;
}

/**
 * The effort the user picked for this scope, when Settings offers it for this
 * runtime and model. A stored level it doesn't offer (the model, runtime or
 * toggle changed since) is ignored.
 */
export function chosenReasoningEffort(
  dialect: ThinkingDialect,
  model: string,
  config: ReasoningConfig
): string | undefined {
  const effort = config.reasoningEffort;
  return isReasoningEffortSupported(selectableReasoningEffort(dialect, model, config), effort)
    ? effort
    : undefined;
}

function isDeterministicTransform(config: ReasoningConfig): boolean {
  return !config.systemPrompt || !!config.requireCompleteOutput;
}

/** Finish reasons that mean the output hit the token cap. */
export function isTruncatedFinishReason(reason: unknown): boolean {
  return reason === "length" || reason === "max_tokens";
}

/**
 * Dictation cleanup renders these errors as the toast title, so they carry the key
 * the renderer translates. Local llama reports a code that localInferenceError.ts maps.
 */
export const TRUNCATED_OUTPUT_MESSAGE_KEY =
  "hooks.audioRecording.errorDescriptions.cleanupTruncated";
export const EMPTY_OUTPUT_MESSAGE_KEY = "hooks.audioRecording.errorDescriptions.cleanupEmptyReply";

/** Output cut off at the token cap; callers may pass their own wording for the logs. */
export function truncatedOutputError(
  message = "Model output was truncated"
): Error & { messageKey: string } {
  return Object.assign(new Error(message), { messageKey: TRUNCATED_OUTPUT_MESSAGE_KEY });
}

/** A reply with no text at all; callers may pass their own wording for the logs. */
export function emptyOutputError(
  message = "Model returned an empty response"
): Error & { messageKey: string } {
  return Object.assign(new Error(message), { messageKey: EMPTY_OUTPUT_MESSAGE_KEY });
}

/**
 * Error for a completion that produced no text, or null when the caller may
 * echo its input instead. Only the default cleanup transform (no systemPrompt)
 * may echo: a prompted task would take its raw material as the finished result.
 */
export function emptyResponseError(
  providerName: string,
  config: ReasoningConfig,
  responseIncomplete: boolean
): Error | null {
  if (responseIncomplete) {
    return truncatedOutputError("Model ran out of output tokens before producing a response");
  }
  if (config.requireCompleteOutput) return emptyOutputError();
  if (config.systemPrompt) return new Error(`${providerName} returned empty response`);
  return null;
}

/**
 * Shaped params a backend may reject by name with a 400/422. Only params this
 * module's shaping layer added are strippable — never messages or model — so a
 * retry degrades the request (model reasons when asked not to, default
 * sampling) instead of failing it outright. The strip is logged loudly: a
 * fallback that keeps firing is a dialect bug to fix, not a rescue.
 */
const STRIPPABLE_SHAPED_PARAMS = [
  "reasoning_effort",
  "chat_template_kwargs",
  "thinking",
  "think",
  "temperature",
] as const;

/**
 * Values a server rejected, as `endpoint, model, param=value` → when the
 * memory expires. Keyed by value, so another effort level is still sent; the
 * expiry retries a value once the model behind the endpoint may have changed.
 */
const rejectedParams = new Map<string, number>();
const REJECTION_MEMORY_MS = 10 * 60 * 1000;

/** `remembered`: left out up front because an earlier retry proved it rejected. */
export type ParamFallbackDetails = { status?: number; stripped: string[]; remembered?: true };

/**
 * Fetch with a bounded param-stripping ladder for 400/422 rejections.
 * Rung 1 (blind): old Ollama/strict proxies reject the `reasoning` object
 * without naming it — drop it and retry once. Rung 2 (named): strip exactly
 * the shaped params the error body names and retry once. At most two retries;
 * the caller must build the body inside `doFetch` so retries re-serialize.
 * A value the error named whose removal let the retry through is left out of
 * later requests to the same endpoint and model for REJECTION_MEMORY_MS, so
 * each pays the rejection once rather than on every request.
 */
export async function fetchWithParamFallback(
  endpoint: string,
  doFetch: () => Promise<Response>,
  requestBody: Record<string, unknown>,
  logRejection: (details: ParamFallbackDetails) => void
): Promise<Response> {
  const rejectionKey = (param: string) =>
    `${endpoint}\n${requestBody.model}\n${param}=${JSON.stringify(requestBody[param])}`;
  const remembered = ["reasoning", ...STRIPPABLE_SHAPED_PARAMS].filter(
    (param) => param in requestBody && (rejectedParams.get(rejectionKey(param)) ?? 0) > Date.now()
  );
  if (remembered.length > 0) {
    logRejection({ stripped: remembered, remembered: true });
    for (const param of remembered) delete requestBody[param];
  }
  const readError = (response: Response) =>
    response
      .clone()
      .text()
      .catch(() => "");
  const retryWithout = async (params: readonly string[], remember: boolean) => {
    const keys = params.map(rejectionKey);
    for (const param of params) delete requestBody[param];
    const retried = await doFetch();
    if (remember && retried.ok) {
      const expiresAt = Date.now() + REJECTION_MEMORY_MS;
      for (const key of keys) rejectedParams.set(key, expiresAt);
    }
    return retried;
  };

  let res = await doFetch();
  if (res.ok || (res.status !== 400 && res.status !== 422)) return res;

  if (requestBody.reasoning) {
    // Remembered only when the error names it: a blind 400 may have come from
    // one of several backends behind the same endpoint.
    const reasoningNamed = (await readError(res)).toLowerCase().includes("reasoning");
    logRejection({ status: res.status, stripped: ["reasoning"] });
    void res.body?.cancel();
    res = await retryWithout(["reasoning"], reasoningNamed);
    if (res.ok || (res.status !== 400 && res.status !== 422)) return res;
  }

  const errorText = await readError(res);
  const named = STRIPPABLE_SHAPED_PARAMS.filter((p) => p in requestBody && errorText.includes(p));
  if (named.length > 0) {
    logRejection({ status: res.status, stripped: named });
    void res.body?.cancel();
    res = await retryWithout(named, true);
  }
  return res;
}
