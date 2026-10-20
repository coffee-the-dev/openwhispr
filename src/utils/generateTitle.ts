import reasoningService from "../services/ReasoningService";
import { getSettings, selectResolvedNoteFormatting } from "../stores/settingsStore";
import {
  buildNoteFormattingOverrides,
  isNoteFormattingConfigured,
} from "../helpers/noteFormattingOverrides";
import { sanitizeGeneratedTitle } from "./sanitizeGeneratedTitle";

const TITLE_SYSTEM_PROMPT =
  "Generate a concise 3-8 word title for these notes. Return ONLY the title text, nothing else — no quotes, no prefix, no explanation.";

// Every generated title runs on the Note Formatting scope — its runtime,
// server, key and model — whichever surface asks. A self-hosted scope with no
// model uses the server's first listed one (see selfHostedDefaultModel).
// Resolves "" when the scope is not configured or the request fails.
export async function generateNoteTitle(text: string): Promise<string> {
  const settings = getSettings();
  const noteFormatting = selectResolvedNoteFormatting(settings);
  if (!isNoteFormattingConfigured(noteFormatting)) return "";
  try {
    const raw = await reasoningService.processText(
      text.slice(0, 2000),
      noteFormatting.model,
      null,
      {
        ...buildNoteFormattingOverrides(noteFormatting),
        systemPrompt: TITLE_SYSTEM_PROMPT,
        temperature: 0.3,
        disableThinking: settings.noteFormattingDisableThinking,
        reasoningEffort: settings.noteFormattingReasoningEffort,
      }
    );
    return sanitizeGeneratedTitle(raw);
  } catch {
    return "";
  }
}
