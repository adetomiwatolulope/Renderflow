/**
 * PR-WEBHOOK-001 URL rules, kept free of any database import so the validation
 * can be tested without a live client. `register-endpoint` owns persistence; this
 * file owns the rule.
 */

export class InsecureWebhookUrlError extends Error {
  readonly url: string;

  constructor(url: string) {
    super("Webhook URL must use https://");
    this.name = "InsecureWebhookUrlError";
    this.url = url;
  }
}

export class InvalidWebhookUrlError extends Error {
  constructor() {
    super("Webhook URL is not a valid absolute URL");
    this.name = "InvalidWebhookUrlError";
  }
}

/**
 * Throws rather than returning a boolean so the caller cannot forget to branch on
 * the reason: an `http://` URL is a 422 the caller must see, not a value to
 * normalise away.
 *
 * The PRD deliberately puts this check in application code rather than a database
 * constraint. The HMAC in PR-WEBHOOK-003 proves authenticity, not
 * confidentiality, so an unencrypted transport would expose job results in
 * cleartext; rewriting the scheme for the caller would hide a real exposure
 * behind a silent upgrade.
 */
export function assertHttpsWebhookUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new InvalidWebhookUrlError();
  }

  if (parsed.protocol !== "https:") {
    throw new InsecureWebhookUrlError(rawUrl);
  }

  return parsed;
}
