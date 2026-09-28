import type { InferenceProvider } from "./types";
import { localProvider } from "./local";
import { lanProvider } from "./lan";

export const PROVIDER_REGISTRY: Readonly<Record<string, InferenceProvider>> = Object.freeze({
  local: localProvider,
  lan: lanProvider,
});

export type { InferenceProvider, ProviderContext, ProviderCallParams } from "./types";

// Whether a provider's client is wired to send image parts. Shared by the
// dictation route and the assistant panel so both gate screenshots alike.
export const providerSupportsImages = (providerId: string | undefined): boolean =>
  !!(providerId && PROVIDER_REGISTRY[providerId]?.supportsImages);
