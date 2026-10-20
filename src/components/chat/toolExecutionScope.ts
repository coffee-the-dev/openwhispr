import type { ToolExecutionContext } from "../../services/tools/ToolRegistry";

export interface ToolContextRequest {
  /** The assistant message the tool call belongs to. */
  messageId: string;
  toolCallId: string;
  /** The model SDK's own per-call abort signal, when it has one. */
  signal?: AbortSignal;
}

export interface ToolExecutionScope {
  createContext: (request: ToolContextRequest) => ToolExecutionContext;
  abort: () => void;
}

/**
 * One scope per chat send. Its signal is the single thing every
 * conversation-ending path (Esc, new chat, unmount) aborts, so tools still
 * running are released no matter how the turn ended.
 */
export function createToolExecutionScope(): ToolExecutionScope {
  const controller = new AbortController();
  return {
    createContext: ({ messageId, toolCallId, signal }) => ({
      messageId,
      toolCallId,
      // Either the turn ending or the SDK abandoning this one call releases
      // whatever the tool is waiting on.
      signal: signal ? AbortSignal.any([controller.signal, signal]) : controller.signal,
    }),
    abort: () => controller.abort(),
  };
}
