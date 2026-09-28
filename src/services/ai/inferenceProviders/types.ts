import type { ReasoningConfig } from "../../BaseReasoningService";

export interface ProviderContext {
  getSystemPrompt(agentName: string | null): string;
  callChatCompletionsApi(
    endpoint: string,
    apiKey: string,
    model: string,
    text: string,
    agentName: string | null,
    config: ReasoningConfig
  ): Promise<string>;
}

export interface ProviderCallParams {
  text: string;
  model: string;
  agentName: string | null;
  config: ReasoningConfig;
  ctx: ProviderContext;
}

export interface InferenceProvider {
  readonly id: string;
  /** True when this client can send `config.screenContext` as image content. */
  readonly supportsImages?: boolean;
  call(params: ProviderCallParams): Promise<string>;
}
