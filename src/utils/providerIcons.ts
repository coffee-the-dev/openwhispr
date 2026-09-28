import orukIcon from "@/assets/icons/providers/oruk.webp";
import openaiIcon from "@/assets/icons/providers/openai.svg";
import llamaIcon from "@/assets/icons/providers/llama.svg";
import mistralIcon from "@/assets/icons/providers/mistral.svg";
import qwenIcon from "@/assets/icons/providers/qwen.svg";
// The square brand tile (green field, white mark) rather than the bare eye: the
// eye SVG is 163x108, and ProviderIcon renders a square img, so it came out
// squashed in every row. WebP because NVIDIA ships the tile as raster art.
import nvidiaIcon from "@/assets/icons/providers/nvidia.webp";
import cohereIcon from "@/assets/icons/providers/cohere.svg";
import openaiOssIcon from "@/assets/icons/providers/openai-oss.svg";
import gemmaIcon from "@/assets/icons/providers/gemma.svg";
import liquidaiIcon from "@/assets/icons/providers/liquidai.svg";

export const PROVIDER_ICONS: Record<string, string> = {
  oruk: orukIcon,
  openai: openaiIcon,
  whisper: openaiIcon,
  llama: llamaIcon,
  mistral: mistralIcon,
  qwen: qwenIcon,
  nvidia: nvidiaIcon,
  cohere: cohereIcon,
  "openai-oss": openaiOssIcon,
  gemma: gemmaIcon,
  liquidai: liquidaiIcon,
};

export function getProviderIcon(provider: string): string | undefined {
  return PROVIDER_ICONS[provider];
}

export const MONOCHROME_PROVIDERS = ["openai", "whisper", "openai-oss", "liquidai"] as const;

export function isMonochromeProvider(provider: string): boolean {
  return (MONOCHROME_PROVIDERS as readonly string[]).includes(provider);
}

// Publisher prefixes (the slug before "/") a self-hosted server may report → our icon keys.
const REMOTE_PROVIDER_ALIASES: Record<string, string> = {
  "meta-llama": "llama",
  meta: "llama",
  mistralai: "mistral",
};

// Resolves the icon for a remote provider prefix (e.g. "qwen" from "qwen/qwen3-8b").
// A model family with its own icon wins over the publisher prefix, so
// "google/gemma-7b" gets the Gemma icon.
export function getRemoteProviderIcon(
  prefix: string,
  modelName?: string
): {
  icon: string | undefined;
  invertInDark: boolean;
} {
  const base = prefix.startsWith("~") ? prefix.slice(1) : prefix;
  const family = modelName?.split(/[-.:@ ]/, 1)[0].toLowerCase();
  const key = family && PROVIDER_ICONS[family] ? family : (REMOTE_PROVIDER_ALIASES[base] ?? base);
  return { icon: PROVIDER_ICONS[key], invertInDark: isMonochromeProvider(key) };
}
