import type { SendToAIOptions } from "../chat/useChatStreaming";
import type { ChatImageAttachment } from "../chat/types";
import type { AgentSelectionContext } from "../../utils/agentSelectionContext";
import type { AssistantResponseDelivery } from "../../helpers/assistantResponseDelivery";

interface CommandInput {
  attachment: ChatImageAttachment | null;
  selectedContext: AgentSelectionContext | null;
  delivery: AssistantResponseDelivery | null;
}

interface CommandHandlers {
  deliver: (
    delivery: AssistantResponseDelivery,
    content: string
  ) => Promise<{ pasted: boolean; copied: boolean }>;
  confirmCopied: (content: string) => void;
}

/**
 * Send options for one voice command: a caret delivery suppresses the panel's
 * streamed content, and the completed answer is delivered (pasted or copied).
 */
export function buildAssistantCommandSendOptions(
  command: CommandInput,
  handlers: CommandHandlers
): { options: SendToAIOptions; wasDelivered: () => boolean } {
  const { delivery } = command;
  let delivered = false;

  return {
    options: {
      attachment: command.attachment ?? undefined,
      selectedContext: command.selectedContext ?? undefined,
      suppressResponseContent: delivery?.mode === "paste",
      // A caret in a markdown-friendly app still keeps the compact pill.
      plainTextResponse: delivery?.mode === "paste" && delivery.plainText,
      destinationAppCategory: delivery?.mode === "paste" ? delivery.appCategory : undefined,
      onComplete: delivery
        ? async ({ content }) => {
            const result = await handlers.deliver(delivery, content);
            delivered = result.pasted;
            if (result.copied) handlers.confirmCopied(content);
          }
        : undefined,
    },
    wasDelivered: () => delivered,
  };
}
