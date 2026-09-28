// Resolve Chat from Chat-owned settings only. In particular, this must never
// consult Dictation Cleanup's mode or endpoint. A self-hosted route with no URL
// stays self-hosted so the caller reports the missing server instead of
// quietly starting a local model the user did not pick.
export function resolveChatRoute({ provider, lanUrl, customApiKey }) {
  const baseUrl = lanUrl?.trim() || "";
  if (baseUrl || provider === "lan") {
    return {
      kind: "self-hosted",
      baseUrl,
      apiKey: customApiKey?.trim() || "",
    };
  }

  return { kind: "local", baseUrl: "", apiKey: "" };
}
