export interface SkyMailConfig {
  user: string;
  password: string;
  imapHost: string;
  imapPort: number;
  smtpHost: string;
  smtpPort: number;
  allowSend: boolean;
}

export function loadConfig(): SkyMailConfig {
  const user = process.env.SKYMAIL_USER?.trim();
  const password = process.env.SKYMAIL_PASSWORD;
  const imapHost = process.env.SKYMAIL_IMAP_HOST?.trim() || "imap.skymail.net.br";
  const imapPort = Number.parseInt(process.env.SKYMAIL_IMAP_PORT || "993", 10);
  const smtpHost = process.env.SKYMAIL_SMTP_HOST?.trim() || "smtp.skymail.net.br";
  const smtpPort = Number.parseInt(process.env.SKYMAIL_SMTP_PORT || "465", 10);
  const allowSend = process.env.SKYMAIL_ALLOW_SEND?.trim().toLowerCase() === "true";

  if (!user) {
    throw new Error("Missing required environment variable: SKYMAIL_USER");
  }
  if (!password) {
    throw new Error("Missing required environment variable: SKYMAIL_PASSWORD");
  }
  if (Number.isNaN(imapPort) || imapPort <= 0) {
    throw new Error("Invalid SKYMAIL_IMAP_PORT");
  }
  if (Number.isNaN(smtpPort) || smtpPort <= 0) {
    throw new Error("Invalid SKYMAIL_SMTP_PORT");
  }

  return {
    user,
    password,
    imapHost,
    imapPort,
    smtpHost,
    smtpPort,
    allowSend,
  };
}

/**
 * Scrubs password from any error message or string before logging or returning to MCP client.
 */
export function sanitizeError(err: unknown, config?: SkyMailConfig): string {
  let raw: string;
  if (err instanceof Error) {
    const extra = err as Error & {
      responseText?: string;
      serverResponseCode?: string;
      authenticationFailed?: boolean;
      code?: string;
    };
    const details = [
      extra.code ? `code=${extra.code}` : "",
      extra.serverResponseCode ? `imapCode=${extra.serverResponseCode}` : "",
      extra.authenticationFailed ? "authenticationFailed=true" : "",
      extra.responseText ? `serverResponse="${extra.responseText}"` : "",
    ]
      .filter(Boolean)
      .join(", ");
    raw = details ? `${err.message} (${details})` : err.message;
  } else if (typeof err === "string") {
    raw = err;
  } else {
    raw = JSON.stringify(err);
  }
  const secrets = [config?.password, process.env.SKYMAIL_PASSWORD].filter(
    (s): s is string => Boolean(s && s.length > 0),
  );
  let safe = raw;
  for (const secret of secrets) {
    safe = safe.split(secret).join("[REDACTED]");
  }
  return safe;
}
