// OpenAI Chat Completions image parts for the raw (non-AI-SDK) request paths.
// The AI SDK converts its own `{ type: "image" }` parts; these helpers do the
// same for the SSE stream and the single-shot LAN call. Images ride only in the
// request body — callers must never log or persist the returned content.

export interface InlineImage {
  mediaType: string;
  /** Base64 bytes, or an already-built data URL. */
  data: string;
}

type ContentPart = Record<string, unknown>;
type ChatContent = string | ContentPart[];

export function imageDataUrl({ mediaType, data }: InlineImage): string {
  return data.startsWith("data:") ? data : `data:${mediaType};base64,${data}`;
}

export function buildUserContent(text: string, image?: InlineImage | null): ChatContent {
  if (!image?.data) return text;
  return [
    { type: "text", text },
    { type: "image_url", image_url: { url: imageDataUrl(image) } },
  ];
}

function toOpenAIPart(part: ContentPart): ContentPart {
  if (part?.type !== "image") return part;
  const image = part.image;
  const data = typeof image === "string" ? image : image instanceof URL ? image.toString() : "";
  if (!data) return part;
  const mediaType = typeof part.mediaType === "string" ? part.mediaType : "image/jpeg";
  return { type: "image_url", image_url: { url: imageDataUrl({ mediaType, data }) } };
}

export function toOpenAIChatMessages<M extends { role: string; content: ChatContent }>(
  messages: M[]
): M[] {
  return messages.map((message) =>
    Array.isArray(message.content)
      ? { ...message, content: message.content.map(toOpenAIPart) }
      : message
  );
}

export function hasImageContent(messages: Array<{ content: ChatContent }>): boolean {
  return messages.some(
    (m) =>
      Array.isArray(m.content) &&
      m.content.some((part) => part?.type === "image" || part?.type === "image_url")
  );
}
