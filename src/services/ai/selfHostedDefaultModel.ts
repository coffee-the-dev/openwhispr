// A self-hosted scope may leave its model empty ("the server's default"), but
// vLLM and most OpenAI-compatible servers reject a request naming no model or
// an unknown one. Use the first id the server lists, looked up once per server
// for the session; "" when it lists none, and the request omits the field.

type ListModels = (config: {
  baseUrl?: string;
  apiKey?: string;
}) => Promise<{ success: boolean; models: string[] }>;

const cache = new Map<string, Promise<string>>();

export async function resolveSelfHostedModel(
  baseUrl: string,
  apiKey: string,
  model: string,
  listModels: ListModels | undefined = typeof window !== "undefined"
    ? window.electronAPI?.listRemoteModels
    : undefined
): Promise<string> {
  const chosen = model.trim();
  if (chosen) return chosen;
  const base = baseUrl.trim();
  if (!base || !listModels) return "";

  const key = `${base}\n${apiKey ? "key" : ""}`;
  let pending = cache.get(key);
  if (!pending) {
    pending = listModels({ baseUrl: base, apiKey })
      .then((result) => (result?.success && result.models[0]) || "")
      .catch(() => "");
    cache.set(key, pending);
  }
  const resolved = await pending;
  // A failed lookup is retried on the next request instead of pinned.
  if (!resolved) cache.delete(key);
  return resolved;
}

export function clearSelfHostedModelCache(): void {
  cache.clear();
}
