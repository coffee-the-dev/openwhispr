import { useState, useRef, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import ReasoningService from "../../services/ReasoningService";
import { providerSupportsImages } from "../../services/ai/inferenceProviders";
import { getSettings, useSettingsStore } from "../../stores/settingsStore";
import { resolveChatStreamingInference } from "../../helpers/dictationAgentInference.js";
import { resolveToolCalling } from "../../helpers/toolCallingPolicy.js";
import { describeProviderError } from "../../utils/describeProviderError";
import logger from "../../utils/logger";
import {
  appendDictionarySuffix,
  appendPlainTextResponseSuffix,
  appendScreenContextSuffix,
  getAgentSystemPrompt,
} from "../../config/prompts";
import type { ToneAppCategory } from "../../config/toneStyle";
import { getDictionaryHintWords } from "../../utils/snippets";
import { FULL_TRANSCRIPT_MAX_TOKENS } from "../../utils/transcriptEvidence";
import { createToolRegistry } from "../../services/tools";
import type { ToolRegistry } from "../../services/tools/ToolRegistry";
import { createToolExecutionScope, type ToolExecutionScope } from "./toolExecutionScope";
import { getAgentToolActivityRemainingMs } from "../../helpers/agentToolPresentation";
import type { Message, AgentState, ChatImageAttachment, ToolCallInfo } from "./types";
import { toHistoryMessages, withoutEchoedToolTrace, type HistoryMessage } from "./historyMessages";
import type { ContainerScope } from "../../types/chat";
import {
  buildAgentRequestText,
  type AgentSelectionContext,
} from "../../utils/agentSelectionContext";

const RAG_NOTE_LIMIT = 5;
const RAG_NOTE_SNIPPET_LENGTH = 500;
const STREAM_FLUSH_INTERVAL_MS = 32;

async function buildRAGContext(userText: string, scope?: ContainerScope): Promise<string> {
  if (!window.electronAPI?.semanticSearchNotes) return "";
  try {
    const results = await window.electronAPI.semanticSearchNotes(
      userText,
      RAG_NOTE_LIMIT,
      scope?.spaceId ?? null,
      scope?.folderId ?? null
    );
    if (!results || results.length === 0) return "";

    const snippets = await Promise.all(
      results.map(async (r: { id: number; title: string; score?: number }) => {
        const note = await window.electronAPI.getNote(r.id);
        if (!note) return null;
        const content = (note.content || "").slice(0, RAG_NOTE_SNIPPET_LENGTH);
        return `<note id="${note.id}" title="${note.title}">\n${content}\n</note>`;
      })
    );

    return snippets.filter(Boolean).join("\n\n");
  } catch {
    return "";
  }
}

/**
 * Which settings scope answers a conversation. Typed chat surfaces stay on the
 * Chat scope; the voice assistant panel runs on the Voice Assistant scope so
 * the model picked under Settings > Voice Assistant is the one that answers
 * (see resolveChatStreamingInference for its Chat fallback).
 */
export type ChatStreamingScope = "chatIntelligence" | "dictationAgent";

export interface OpenNoteContext {
  text: string;
  /** Only the start of the transcript is included; get_note reads the rest. */
  transcriptPreview: boolean;
}

interface UseChatStreamingOptions {
  messages: Message[];
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
  /** Settings scope the conversation resolves its provider and model from. */
  inferenceScope?: ChatStreamingScope;
  /** Notes listed in the system prompt as possibly relevant (container overview chat). */
  noteContext?: string;
  /**
   * The note a note's chat is about. The model answers from it first, and no
   * other notes are added up front: it reaches them through search_notes.
   */
  openNote?: string | ((maxTranscriptTokens: number) => OpenNoteContext);
  /** Optional container scope applied to RAG and the search_notes tool (container overview chat). */
  searchScope?: ContainerScope;
  onStreamComplete?: (assistantId: string, content: string, toolCalls?: ToolCallInfo[]) => void;
  /** Fires exactly once when displayable assistant content or tool activity becomes available. */
  onResponseContent?: () => void;
}

export interface SendToAIOptions {
  /** Screenshot for this message; attached only when the resolved model can see it. */
  attachment?: ChatImageAttachment;
  /** Agent-response selection attached to this request without changing chat history. */
  selectedContext?: AgentSelectionContext;
  /**
   * Sent to the model in place of this turn's visible message, which is what the
   * chat shows and saves (a note action shows its name while its prompt is sent).
   */
  requestText?: string;
  /** This turn isn't offered update_note, so it can't change a note (a note's chat action). */
  keepNotesUnchanged?: boolean;
  /** Keeps a caret-destined voice response in the compact pill while it streams. */
  suppressResponseContent?: boolean;
  /** Asks the model for plain prose because the answer will be pasted into a plain-text app. */
  plainTextResponse?: boolean;
  /** Tone & Style: the kind of app a caret-destined answer will be typed into. */
  destinationAppCategory?: ToneAppCategory;
  /** Per-request completion hook used to deliver a finished voice response. */
  onComplete?: (result: {
    assistantId: string;
    content: string;
    toolCalls?: ToolCallInfo[];
  }) => void | Promise<void>;
}

export interface ChatStreaming {
  agentState: AgentState;
  toolStatus: string;
  activeToolName: string;
  sendToAI: (userText: string, allMessages: Message[], options?: SendToAIOptions) => Promise<void>;
  cancelStream: () => void;
}

// Walks backward to the newest user message; a null transform keeps walking.
function transformLastUserMessage(
  history: HistoryMessage[],
  transform: (message: HistoryMessage) => HistoryMessage | null
): void {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role !== "user") continue;
    const replacement = transform(history[i]);
    if (replacement === null) continue;
    history[i] = replacement;
    break;
  }
}

export function useChatStreaming({
  messages,
  setMessages,
  inferenceScope = "chatIntelligence",
  noteContext: externalNoteContext,
  openNote,
  searchScope,
  onStreamComplete,
  onResponseContent,
}: UseChatStreamingOptions): ChatStreaming {
  const { t } = useTranslation();
  const [agentState, setAgentState] = useState<AgentState>("idle");
  const [toolStatus, setToolStatus] = useState("");
  const [activeToolName, setActiveToolName] = useState("");
  const mountedRef = useRef(true);
  const messagesRef = useRef<Message[]>([]);
  const noteContextRef = useRef(externalNoteContext);
  noteContextRef.current = externalNoteContext;
  const openNoteRef = useRef(openNote);
  openNoteRef.current = openNote;
  const searchScopeRef = useRef(searchScope);
  searchScopeRef.current = searchScope;
  const toolRegistryRef = useRef<{ key: string; registry: ToolRegistry } | null>(null);
  const toolActivityStartedAtRef = useRef<number | null>(null);
  const toolActivityTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearToolActivityTimer = useCallback(() => {
    if (toolActivityTimerRef.current) {
      clearTimeout(toolActivityTimerRef.current);
      toolActivityTimerRef.current = null;
    }
  }, []);

  const clearToolActivity = useCallback(() => {
    clearToolActivityTimer();
    toolActivityStartedAtRef.current = null;
    if (!mountedRef.current) return;
    setToolStatus("");
    setActiveToolName("");
  }, [clearToolActivityTimer]);

  const beginToolActivity = useCallback(
    (name: string, status: string) => {
      clearToolActivityTimer();
      toolActivityStartedAtRef.current = Date.now();
      setActiveToolName(name);
      setToolStatus(status);
    },
    [clearToolActivityTimer]
  );

  const completeToolActivity = useCallback(() => {
    const startedAt = toolActivityStartedAtRef.current;
    if (startedAt == null) {
      clearToolActivity();
      return;
    }

    const remainingMs = getAgentToolActivityRemainingMs(startedAt);
    clearToolActivityTimer();
    if (remainingMs === 0) {
      clearToolActivity();
      return;
    }

    toolActivityTimerRef.current = setTimeout(clearToolActivity, remainingMs);
  }, [clearToolActivity, clearToolActivityTimer]);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  const sendGenerationRef = useRef(0);
  // Generation stamped by the most recent cancel issued while still mounted
  // (Esc, a Stop button). The unmount cleanup below flips mountedRef off
  // before routing through cancelStream, so it never stamps this — which is
  // how sendToAI tells a user's cancel from an unmount mid-stream.
  const explicitCancelGenerationRef = useRef(0);
  const toolScopeRef = useRef<ToolExecutionScope | null>(null);
  const cancelStream = useCallback(() => {
    sendGenerationRef.current += 1;
    if (mountedRef.current) {
      explicitCancelGenerationRef.current = sendGenerationRef.current;
    }
    toolScopeRef.current?.abort();
    toolScopeRef.current = null;
    ReasoningService.cancelActiveStream();
    setAgentState("idle");
    clearToolActivity();
  }, [clearToolActivity]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // Route through cancelStream so every cancellation path — Esc/Stop and
      // an unmount mid-stream alike — bumps the same generation counter.
      // Calling ReasoningService.cancelActiveStream() directly here (as this
      // used to) left sendToAI's cancelled() check unaware of an unmount
      // cancel, so its empty-response fallback still fired and persisted a
      // fabricated reply for a send the user never saw complete.
      cancelStream();
    };
  }, [cancelStream]);

  const sendToAI = useCallback(
    async (userText: string, allMessages: Message[], options?: SendToAIOptions) => {
      const sendGeneration = ++sendGenerationRef.current;
      const cancelled = () => sendGeneration !== sendGenerationRef.current;
      // This send supersedes any still running, so that turn's tools are
      // released now rather than when (or if) they settle.
      toolScopeRef.current?.abort();
      const toolScope = createToolExecutionScope();
      toolScopeRef.current = toolScope;
      clearToolActivity();

      // Every exit, thrown errors included, releases tools still running for
      // this turn. A newer send may already own toolScopeRef.
      try {
        await runSend();
      } finally {
        toolScope.abort();
        if (toolScopeRef.current === toolScope) toolScopeRef.current = null;
      }

      async function runSend(): Promise<void> {
        let responseAnnounced = false;
        const announceResponse = () => {
          if (responseAnnounced) return;
          responseAnnounced = true;
          if (!options?.suppressResponseContent) onResponseContent?.();
        };
        const settings = getSettings();
        const { config: llmConfig, attachScreenContext } = resolveChatStreamingInference(settings, {
          inferenceScope,
          hasScreenContext: !!options?.attachment,
          isProviderImageWired: providerSupportsImages,
        });
        const requestedAttachment = attachScreenContext ? (options?.attachment ?? null) : null;
        const llmMode = llmConfig.mode;
        setAgentState("thinking");
        const isLanAgent = llmMode === "self-hosted";
        // The scope's Tool calling setting; Auto keeps small models, which answer
        // tool schemas with noise, off them.
        const supportsTools = resolveToolCalling({
          setting: llmConfig.toolCalling,
          mode: llmMode,
          model: llmConfig.model,
        });

        const scope = searchScopeRef.current;
        let registry: ToolRegistry | null = null;
        if (supportsTools) {
          const scopeKey = scope ? `${scope.spaceId}:${scope.folderId ?? ""}` : "";
          // The calendar tool reads the shared events table Apple Calendar fills.
          const calendarConnected = settings.appleCalendarConnected;
          // Triggers ride in the tool description, so a snippet edit rebuilds the registry.
          const snippetKey = settings.snippets.map((s) => s.trigger).join("|");
          const webSearchUrl = settings.webSearchEnabled ? settings.webSearchUrl.trim() : "";
          const keepNotesUnchanged = !!options?.keepNotesUnchanged;
          const cacheKey = `${calendarConnected}-${scopeKey}-${snippetKey}-${webSearchUrl}-${keepNotesUnchanged}`;
          if (toolRegistryRef.current?.key === cacheKey) {
            registry = toolRegistryRef.current.registry;
          } else {
            registry = createToolRegistry({
              calendarConnected,
              webSearchUrl,
              searchScope: scope,
              vocabulary: {
                getDictionary: () => getSettings().customDictionary,
                updateDictionary: (changes) =>
                  useSettingsStore.getState().updateCustomDictionary(changes),
                getSnippets: () => getSettings().snippets,
                setSnippets: (snippets) => useSettingsStore.getState().setSnippets(snippets),
              },
              keepNotesUnchanged,
            });
            toolRegistryRef.current = { key: cacheKey, registry };
          }
        }

        // A note's chat is about its note: other notes up front would compete with
        // it, and search_notes still reaches them when it doesn't answer.
        const ragContext = openNoteRef.current ? "" : await buildRAGContext(userText, scope);
        if (cancelled() || !mountedRef.current) return;
        // A transcript too long for the model is read through get_note, except
        // by whole-note actions, which work from the complete source.
        const maxTranscriptTokens =
          registry?.get("get_note") && !options?.requestText
            ? FULL_TRANSCRIPT_MAX_TOKENS.selfHosted
            : Infinity;
        const currentNote: OpenNoteContext =
          typeof openNoteRef.current === "function"
            ? openNoteRef.current(maxTranscriptTokens)
            : { text: openNoteRef.current ?? "", transcriptPreview: false };
        const libraryContext = [noteContextRef.current, ragContext].filter(Boolean).join("\n\n");
        // The user's dictionary rides on every conversation so replies use their
        // jargon — same suffix the dictation prompts carry.
        let systemPrompt = appendDictionarySuffix(
          getAgentSystemPrompt(registry?.getAll(), libraryContext || undefined, {
            toolTrace: registry !== null,
            openNote: currentNote.text || undefined,
            openNoteTranscriptPreview: currentNote.transcriptPreview,
            userName: settings.userName,
            writingStyle: settings.toneStyleEnabled
              ? { tones: settings.toneStyles, destination: options?.destinationAppCategory }
              : undefined,
          }),
          getDictionaryHintWords(settings),
          settings.uiLanguage
        );

        const history: HistoryMessage[] = toHistoryMessages(allMessages, {
          includeToolTrace: registry !== null,
        });

        const requestText = options?.requestText;
        if (requestText) {
          transformLastUserMessage(history, (message) => ({ ...message, content: requestText }));
        }

        const selectedContext = options?.selectedContext;
        if (selectedContext) {
          transformLastUserMessage(history, (message) =>
            typeof message.content === "string"
              ? { ...message, content: buildAgentRequestText(message.content, selectedContext) }
              : null
          );
        }

        // A screenshot the resolver kept rides with the command it came with as
        // an image part. A dropped one costs nothing but the image — the command
        // still runs.
        const attachment = requestedAttachment;
        if (attachment) {
          // The screenshot needs its grounding instruction, exactly like the
          // dictation path pairs the suffix with an attached image.
          systemPrompt = appendScreenContextSuffix(systemPrompt, settings.uiLanguage);
        }
        if (options?.plainTextResponse) {
          systemPrompt = appendPlainTextResponseSuffix(systemPrompt);
        }
        if (attachment) {
          transformLastUserMessage(history, (message) => ({
            role: "user",
            content: [
              { type: "text", text: message.content as string },
              { type: "image", image: attachment.image, mediaType: attachment.mediaType },
            ],
          }));
        }

        const llmMessages = [{ role: "system", content: systemPrompt }, ...history];

        const assistantId = crypto.randomUUID();
        setMessages((prev) => [
          ...prev,
          { id: assistantId, role: "assistant", content: "", isStreaming: true },
        ]);
        setAgentState("streaming");

        // Chat re-parses the whole answer through react-markdown on every
        // content write, so one write per streamed token made parse cost scale
        // with token count. Buffer and flush at most once per interval.
        let rawContent = "";
        let fullContent = "";
        let contentFlushTimer: ReturnType<typeof setTimeout> | null = null;
        const cancelContentFlush = () => {
          if (contentFlushTimer === null) return;
          clearTimeout(contentFlushTimer);
          contentFlushTimer = null;
        };
        const flushContentNow = () => {
          cancelContentFlush();
          setMessages((prev) =>
            prev.map((m) => (m.id === assistantId ? { ...m, content: fullContent } : m))
          );
        };
        const scheduleContentFlush = () => {
          if (contentFlushTimer !== null) return;
          contentFlushTimer = setTimeout(flushContentNow, STREAM_FLUSH_INTERVAL_MS);
        };

        try {
          // Each call's own step text: the AI SDK hands the stream only the
          // model-facing output.
          const toolDisplayTexts = new Map<string, string>();
          const aiTools = registry?.toAISDKFormat(
            (toolCallId, abortSignal) =>
              toolScope.createContext({
                messageId: assistantId,
                toolCallId,
                signal: abortSignal,
              }),
            (id, text) => toolDisplayTexts.set(id, text)
          );
          const stream = ReasoningService.processTextStreamingAI(
            llmMessages,
            llmConfig.model,
            isLanAgent ? "lan" : "local",
            {
              systemPrompt,
              // Requests are judged by the scope that actually answers, so the
              // panel's Chat fallback counts as Chat.
              inferenceScope: llmConfig.scope,
              lanUrl: isLanAgent ? llmConfig.remoteUrl : undefined,
              customApiKey: isLanAgent ? llmConfig.customApiKey || undefined : undefined,
              disableThinking: llmConfig.disableThinking,
              reasoningEffort: llmConfig.reasoningEffort,
            },
            aiTools
          );

          for await (const chunk of stream) {
            if (!mountedRef.current) {
              ReasoningService.cancelActiveStream();
              break;
            }
            if (chunk.type === "content") {
              rawContent += chunk.text;
              fullContent = withoutEchoedToolTrace(rawContent);
              if (fullContent) announceResponse();
              scheduleContentFlush();
            } else if (chunk.type === "tool_calls") {
              // Text that arrived before a tool step must be on screen before the
              // step appears, not an interval after it.
              flushContentNow();
              if (chunk.calls.length > 0) announceResponse();
              for (const call of chunk.calls) {
                setAgentState("tool-executing");
                beginToolActivity(
                  call.name,
                  t(`agentMode.tools.${call.name}Status`, { defaultValue: `Using ${call.name}...` })
                );
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === assistantId
                      ? {
                          ...m,
                          toolCalls: [
                            ...(m.toolCalls || []),
                            {
                              id: call.id,
                              name: call.name,
                              arguments: call.arguments,
                              status: "executing" as const,
                            },
                          ],
                        }
                      : m
                  )
                );
              }
            } else if (chunk.type === "tool_result") {
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantId && m.toolCalls
                    ? {
                        ...m,
                        toolCalls: m.toolCalls.map((tc) =>
                          tc.id === chunk.callId
                            ? {
                                ...tc,
                                status: "completed" as const,
                                result: toolDisplayTexts.get(chunk.callId) ?? chunk.displayText,
                                ...(chunk.metadata ? { metadata: chunk.metadata } : {}),
                              }
                            : tc
                        ),
                      }
                    : m
                )
              );
              setAgentState("streaming");
              completeToolActivity();
            }
          }

          if (cancelled() || !mountedRef.current) {
            flushContentNow();
            setMessages((prev) =>
              prev.map((message) =>
                message.id === assistantId ? { ...message, isStreaming: false } : message
              )
            );
            // An unmount mid-stream (page navigation) keeps the partial reply in
            // history so the saved conversation matches what the user last saw;
            // an explicit cancel drops it. The unmount cleanup cancels too, so
            // cancelled() alone cannot tell the two apart. Neither path may run
            // the per-request delivery hook.
            const explicitlyCancelled = explicitCancelGenerationRef.current > sendGeneration;
            if (!explicitlyCancelled && fullContent.trim().length > 0) {
              const finalMsg = messagesRef.current.find((m) => m.id === assistantId);
              onStreamComplete?.(assistantId, fullContent, finalMsg?.toolCalls);
            }
            return;
          }

          flushContentNow();
          const hasDeliverableContent = fullContent.trim().length > 0;
          if (!responseAnnounced && !cancelled()) {
            // The stream ended without a visible token or tool call (think-only
            // local model, empty completion). Show that as a reply so every
            // listener — the assistant panel's thinking state included — sees a
            // terminal outcome.
            fullContent = t("agentMode.chat.emptyResponse");
            announceResponse();
            setMessages((prev) =>
              prev.map((m) => (m.id === assistantId ? { ...m, content: fullContent } : m))
            );
          }

          setMessages((prev) =>
            prev.map((m) => (m.id === assistantId ? { ...m, isStreaming: false } : m))
          );

          const finalMsg = messagesRef.current.find((m) => m.id === assistantId);
          onStreamComplete?.(assistantId, fullContent, finalMsg?.toolCalls);
          if (hasDeliverableContent) {
            await options?.onComplete?.({
              assistantId,
              content: fullContent,
              toolCalls: finalMsg?.toolCalls,
            });
          }
        } catch (error) {
          if (cancelled()) {
            flushContentNow();
            setMessages((prev) =>
              prev.map((message) =>
                message.id === assistantId ? { ...message, isStreaming: false } : message
              )
            );
          } else {
            cancelContentFlush();
            logger.error(
              "Assistant request failed",
              {
                scope: llmConfig.scope,
                mode: llmMode,
                provider: llmConfig.provider,
                model: llmConfig.model,
                attachScreenContext,
                error: (error as Error).message,
              },
              "reasoning"
            );
            announceResponse();
            const failure = describeProviderError(error, t);
            const messageError = failure.settingsTarget
              ? { settingsTarget: failure.settingsTarget }
              : undefined;
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantId
                  ? {
                      ...m,
                      content: `${t("agentMode.chat.errorPrefix")}: ${failure.description}`,
                      isStreaming: false,
                      ...(messageError ? { error: messageError } : {}),
                    }
                  : m
              )
            );
          }
        }

        setAgentState("idle");
        completeToolActivity();
      }
    },
    [
      inferenceScope,
      t,
      setMessages,
      onStreamComplete,
      onResponseContent,
      clearToolActivity,
      beginToolActivity,
      completeToolActivity,
    ]
  );

  return {
    agentState,
    toolStatus,
    activeToolName,
    sendToAI,
    cancelStream,
  };
}
