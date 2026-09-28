import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";

// Renderer-side AI SDK factory. Both runtimes — the on-device llama.cpp server
// and a self-hosted OpenAI-compatible server — implement Chat Completions, not
// the OpenAI Responses API.
export function getAIModel(model: string, apiKey: string, baseURL: string): LanguageModel {
  return createOpenAI({ apiKey: apiKey || "no-key", baseURL }).chat(model);
}
