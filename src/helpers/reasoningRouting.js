// Whether a scope may borrow the fallback scope's API key along with its endpoint.
// A scope pointing somewhere of its own, or in another mode, would send that key to
// a host it was never entered for.
export function inheritsFallbackEndpoint(own, fallbackMode) {
  if (own.remoteUrl) return false;
  return !!fallbackMode && own.mode === fallbackMode;
}

export const REASONING_SCOPES = [
  "dictationCleanup",
  "noteFormatting",
  "dictationAgent",
  "chatIntelligence",
  "dictationTranslation",
];

// Fan one runtime choice out to all five LLM scopes, as onboarding does. The
// endpoint and key ride along so a self-hosted server is reachable from every
// scope, not just the one onboarding wrote; only the fields that are set are
// mirrored.
/**
 * @param {{ mode: string, provider?: string, model?: string, remoteUrl?: string, customApiKey?: string }} selection
 */
export function buildReasoningScopePatches({ mode, provider, model, remoteUrl, customApiKey }) {
  const routing = Object.fromEntries(
    Object.entries({
      mode,
      provider: mode === "self-hosted" ? "lan" : provider,
      model,
      remoteUrl,
      customApiKey,
    }).filter(([, value]) => value !== undefined)
  );
  return Object.fromEntries(REASONING_SCOPES.map((scope) => [scope, { ...routing }]));
}
