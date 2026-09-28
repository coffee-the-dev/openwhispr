// Pure orchestration for the cleanup-then-translate chain. No imports: callers
// inject the actual cleanup/translate calls and logging so this stays node-testable.

function normalizeComparableText(value) {
  if (typeof value !== "string") return value;
  return value.trim().replace(/\s+/g, " ");
}

// Shared guard for reasoning/cleanup output (#1616): a whitespace-only reply counts
// as empty and must never replace existing text. Also used by the agent/cleanup
// call sites in audioManager and the history-retry path in ControlPanel.
export function hasTextContent(value) {
  return typeof value === "string" && value.trim().length > 0;
}

// Whether the translate step should run: skip only when an explicit source language
// equals the target. "auto" (or empty, treated as auto) always translates.
export function shouldRunTranslateStep(sourceLanguage, targetLanguage) {
  return (sourceLanguage || "auto") === "auto" || sourceLanguage !== targetLanguage;
}

// Step 1 (optional cleanup) soft-fails to the input text; Step 2 translates unless
// shouldTranslate is false. translated tracks whether the output really reached the
// target language.
export async function executeTranslationChain({
  text,
  cleanupReachable,
  runCleanup,
  runTranslate,
  shouldTranslate,
  onCleanupError,
  onEmptyTranslate,
  onUnchangedTranslate,
}) {
  let out = text;
  let translated = false;

  if (cleanupReachable) {
    try {
      const cleaned = await runCleanup(out);
      if (hasTextContent(cleaned)) out = cleaned;
    } catch (cleanupError) {
      if (onCleanupError) onCleanupError(cleanupError);
    }
  }

  if (shouldTranslate) {
    const translateResult = await runTranslate(out);
    const normalizedResult = normalizeComparableText(translateResult);
    const translationChanged = normalizedResult !== normalizeComparableText(out);
    if (normalizedResult && translationChanged) {
      out = translateResult;
      translated = true;
    } else if (normalizedResult) {
      if (onUnchangedTranslate) onUnchangedTranslate();
    } else if (onEmptyTranslate) {
      onEmptyTranslate();
    }
  }

  return { text: out, translated };
}
