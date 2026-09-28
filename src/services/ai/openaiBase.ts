import { ensureV1Suffix } from "../../config/constants";
import { isSecureHttpEndpoint } from "../../utils/urlUtils";
import i18n from "../../i18n";

export function resolveSelfHostedOpenAIBase(configuredBaseUrl: string): string {
  const normalized = ensureV1Suffix(configuredBaseUrl.trim());
  if (!normalized || !isSecureHttpEndpoint(normalized)) {
    throw new Error(i18n.t("reasoning.custom.httpsRequired"));
  }

  return normalized;
}
