import modelDataRaw from "./modelRegistryData.json";
import type { InferenceMode } from "../types/electron";

export interface ModelDefinition {
  id: string;
  name: string;
  size: string;
  sizeBytes: number;
  description: string;
  descriptionKey?: string;
  fileName: string;
  quantization: string;
  contextLength: number;
  hfRepo: string;
  recommended?: boolean;
  supportsThinking?: boolean;
  // Optional MTP speculative-decoding drafter downloaded alongside the main GGUF.
  draftHfRepo?: string;
  draftFileName?: string;
  draftSizeBytes?: number;
}

export interface LocalProviderData {
  id: string;
  name: string;
  baseUrl: string;
  models: ModelDefinition[];
}

export interface ModelProvider {
  id: string;
  name: string;
  baseUrl: string;
  models: ModelDefinition[];
  getDownloadUrl(model: ModelDefinition): string;
}

export interface WhisperModelInfo {
  name: string;
  description: string;
  descriptionKey?: string;
  size: string;
  sizeMb: number;
  fileName: string;
  downloadUrl: string;
  recommended?: boolean;
}

export interface WhisperModelConfig {
  url: string;
  size: number;
  fileName: string;
}

export type WhisperModelsMap = Record<string, WhisperModelInfo>;

export interface ParakeetModelInfo {
  name: string;
  description: string;
  descriptionKey?: string;
  size: string;
  sizeMb: number;
  expectedSizeBytes?: number;
  manifestUrl?: string;
  language: string;
  supportedLanguages: string[];
  runtime?: "offline" | "online";
  modelType?: "transducer" | "cohere-transcribe";
  /** Verified sherpa decoder type; skips redundant encoder loading during detection. */
  sherpaModelType?: "nemo_transducer";
  organization?: { id: string; name: string };
  license?: string;
  modelCardUrl?: string;
  recommended?: boolean;
  downloadUrl: string;
  extractDir: string;
}

export type ParakeetModelsMap = Record<string, ParakeetModelInfo>;

interface ModelRegistryData {
  parakeetModels: ParakeetModelsMap;
  whisperModels: WhisperModelsMap;
  localProviders: LocalProviderData[];
}

const modelData: ModelRegistryData = modelDataRaw as ModelRegistryData;

class ModelRegistry {
  private static instance: ModelRegistry;
  private providers = new Map<string, ModelProvider>();

  private constructor() {
    this.registerProvidersFromData();
  }

  static getInstance(): ModelRegistry {
    if (!ModelRegistry.instance) {
      ModelRegistry.instance = new ModelRegistry();
    }
    return ModelRegistry.instance;
  }

  registerProvider(provider: ModelProvider) {
    this.providers.set(provider.id, provider);
  }

  getProvider(providerId: string): ModelProvider | undefined {
    return this.providers.get(providerId);
  }

  getAllProviders(): ModelProvider[] {
    return Array.from(this.providers.values());
  }

  getModel(modelId: string): { model: ModelDefinition; provider: ModelProvider } | undefined {
    for (const provider of this.providers.values()) {
      const model = provider.models.find((m) => m.id === modelId);
      if (model) {
        return { model, provider };
      }
    }
    return undefined;
  }

  getAllModels(): Array<ModelDefinition & { providerId: string }> {
    const models: Array<ModelDefinition & { providerId: string }> = [];
    for (const provider of this.providers.values()) {
      for (const model of provider.models) {
        models.push({ ...model, providerId: provider.id });
      }
    }
    return models;
  }

  private registerProvidersFromData() {
    const localProviders = modelData.localProviders;

    for (const providerData of localProviders) {
      this.registerProvider({
        id: providerData.id,
        name: providerData.name,
        baseUrl: providerData.baseUrl,
        models: providerData.models,
        getDownloadUrl(model: ModelDefinition): string {
          return `${providerData.baseUrl}/${model.hfRepo}/resolve/main/${model.fileName}`;
        },
      });
    }
  }
}

export const modelRegistry = ModelRegistry.getInstance();

// A local scope stores its selection as a catalog family id (qwen, gemma, …);
// a self-hosted scope's model is whatever its server lists.
export function isProviderValidForMode(provider: string, mode: InferenceMode): boolean {
  return mode === "local" ? modelRegistry.getAllProviders().some((p) => p.id === provider) : true;
}

export function getWhisperModels(): WhisperModelsMap {
  return modelData.whisperModels;
}

export function getWhisperModelInfo(modelId: string): WhisperModelInfo | undefined {
  return modelData.whisperModels[modelId];
}

export const WHISPER_MODEL_INFO = modelData.whisperModels;

export function getLocalModel(modelId: string): ModelDefinition | undefined {
  return modelRegistry.getModel(modelId)?.model;
}

export function getParakeetModels(): ParakeetModelsMap {
  return modelData.parakeetModels;
}

export function getParakeetModelInfo(modelId: string): ParakeetModelInfo | undefined {
  return modelData.parakeetModels[modelId];
}

export function isOnlineParakeetModel(modelId: string): boolean {
  return modelData.parakeetModels[modelId]?.runtime === "online";
}

export function isCohereTranscribeModel(modelId: string): boolean {
  return modelData.parakeetModels[modelId]?.modelType === "cohere-transcribe";
}

// Both providers run on the parakeet/sherpa-onnx stack; only whisper differs.
export function isSherpaLocalProvider(provider: string): boolean {
  return provider === "nvidia" || provider === "cohere";
}

export const PARAKEET_MODEL_INFO = modelData.parakeetModels;

export function getWhisperModelConfig(modelId: string): WhisperModelConfig | null {
  const modelInfo = modelData.whisperModels[modelId];
  if (!modelInfo) return null;
  return {
    url: modelInfo.downloadUrl,
    size: modelInfo.sizeMb * 1_000_000,
    fileName: modelInfo.fileName,
  };
}

export function getValidWhisperModelNames(): string[] {
  return Object.keys(modelData.whisperModels);
}
