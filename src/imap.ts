import {
  ImapFlow,
  type FetchMessageObject,
  type MessageStructureObject,
  type SearchObject,
} from "imapflow";
import { simpleParser } from "mailparser";
import type { SkyMailConfig } from "./config.js";
import { buildMimeMessage, sendRawMimeViaSmtp } from "./smtp.js";

export interface FolderInfo {
  path: string;
  name: string;
  specialUse: string | null;
  total: number;
  unread: number;
}

export interface EmailSummary {
  uid: number;
  date: string | null;
  from: string;
  to: string[];
  subject: string;
  seen: boolean;
  hasAttachments: boolean;
}

export interface AttachmentMeta {
  filename: string;
  contentType: string;
  size: number;
}

export interface EmailDetail {
  uid: number;
  folder: string;
  messageId: string | null;
  date: string | null;
  from: string;
  to: string[];
  cc: string[];
  replyTo: string[];
  inReplyTo: string | null;
  references: string[];
  subject: string;
  seen: boolean;
  body: string;
  truncated: boolean;
  attachments: AttachmentMeta[];
}

export interface SearchEmailsInput {
  folder?: string;
  from?: string;
  to?: string;
  subject?: string;
  text?: string;
  since?: string;
  before?: string;
  unreadOnly?: boolean;
  limit?: number;
}

export interface DraftOrSendInput {
  to: string;
  cc?: string;
  subject: string;
  body: string;
  replyToUid?: number;
  replyToFolder?: string;
}

export interface CreateDraftResult {
  folder: string;
  uid: number | null;
  messageId: string;
  subject: string;
  to: string;
  cc: string | null;
  inReplyTo: string | null;
}

export interface SendEmailResult {
  messageId: string;
  subject: string;
  to: string;
  cc: string | null;
  inReplyTo: string | null;
  smtpResponse: string;
  sentFolder: string;
  sentUid: number | null;
}

const TIMEOUT_MS = 15_000;
const MAX_BODY_CHARS = 20_000;

/**
 * Converts HTML email content into readable plain text when no text/plain part exists.
 */
export function htmlToReadableText(html: string): string {
  let text = html
    // Remove non-visible blocks
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(head|style|script|noscript|title|svg)[^>]*>[\s\S]*?<\/\1>/gi, "")
    // Preserve useful links: <a href="https://...">Label</a> -> Label (https://...)
    .replace(
      /<a\b[^>]*?\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
      (_match, href: string, inner: string) => {
        const cleanInner = inner.replace(/<[^>]+>/g, "").trim();
        const cleanHref = href.trim();
        if (
          !cleanHref ||
          cleanHref.startsWith("#") ||
          cleanHref.toLowerCase().startsWith("javascript:")
        ) {
          return cleanInner;
        }
        if (!cleanInner || cleanInner === cleanHref) {
          return cleanHref;
        }
        return `${cleanInner} (${cleanHref})`;
      },
    )
    // Structural line breaks
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6]|blockquote|section|article|header|footer|table)>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "• ")
    .replace(/<\/(td|th)>/gi, "\t")
    // Strip remaining tags
    .replace(/<[^>]+>/g, "");

  // Decode HTML entities
  const namedEntities: Record<string, string> = {
    nbsp: " ",
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    copy: "©",
    reg: "®",
    ndash: "–",
    mdash: "—",
    bull: "•",
    hellip: "…",
    aacute: "á",
    Aacute: "Á",
    acirc: "â",
    Acirc: "Â",
    atilde: "ã",
    Atilde: "Ã",
    agrave: "à",
    Agrave: "À",
    eacute: "é",
    Eacute: "É",
    ecirc: "ê",
    Ecirc: "Ê",
    iacute: "í",
    Iacute: "Í",
    oacute: "ó",
    Oacute: "Ó",
    ocirc: "ô",
    Ocirc: "Ô",
    otilde: "õ",
    Otilde: "Õ",
    uacute: "ú",
    Uacute: "Ú",
    ccedil: "ç",
    Ccedil: "Ç",
    ordm: "º",
    ordf: "ª",
  };

  text = text
    .replace(/&#(\d+);/g, (_m, dec: string) => {
      const code = Number.parseInt(dec, 10);
      return Number.isNaN(code) ? _m : String.fromCodePoint(code);
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex: string) => {
      const code = Number.parseInt(hex, 16);
      return Number.isNaN(code) ? _m : String.fromCodePoint(code);
    })
    .replace(/&([a-zA-Z]+);/g, (m, name: string) => namedEntities[name] ?? m);

  return text
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Opens a fresh IMAP connection, runs the callback, and cleanly logs out.
 * logger: false is critical so ImapFlow never writes logs to stdout (which breaks MCP stdio).
 */
export async function withImap<T>(
  config: SkyMailConfig,
  work: (client: ImapFlow) => Promise<T>,
): Promise<T> {
  const client = new ImapFlow({
    host: config.imapHost,
    port: config.imapPort,
    secure: true,
    auth: {
      user: config.user,
      pass: config.password,
    },
    logger: false,
    connectionTimeout: TIMEOUT_MS,
    greetingTimeout: TIMEOUT_MS,
    socketTimeout: TIMEOUT_MS,
  });

  client.on("error", (err) => {
    console.error("[imap] socket error:", err.message);
  });

  await client.connect();
  try {
    return await work(client);
  } finally {
    try {
      await client.logout();
    } catch {
      client.close();
    }
  }
}

function formatAddress(addr?: { name?: string; address?: string }): string {
  if (!addr) return "";
  const name = addr.name?.trim();
  const email = addr.address?.trim();
  if (name && email) return `${name} <${email}>`;
  return email || name || "";
}

function formatAddressList(list?: Array<{ name?: string; address?: string }>): string[] {
  if (!list || list.length === 0) return [];
  return list.map(formatAddress).filter(Boolean);
}

/**
 * Checks an IMAP BODYSTRUCTURE tree for attachments without downloading message bodies.
 */
export function hasAttachmentsInStructure(structure?: MessageStructureObject): boolean {
  if (!structure) return false;
  const disposition = structure.disposition?.toLowerCase();
  if (disposition === "attachment") {
    return true;
  }
  if (
    disposition === "inline" &&
    structure.dispositionParameters?.filename &&
    structure.type &&
    !structure.type.startsWith("text/")
  ) {
    return true;
  }
  if (
    !structure.childNodes &&
    structure.parameters?.name &&
    structure.type &&
    !structure.type.startsWith("text/")
  ) {
    return true;
  }
  if (Array.isArray(structure.childNodes)) {
    return structure.childNodes.some((child) => hasAttachmentsInStructure(child));
  }
  return false;
}

export async function listFolders(config: SkyMailConfig): Promise<FolderInfo[]> {
  return withImap(config, async (client) => {
    const boxes = await client.list({
      statusQuery: {
        messages: true,
        unseen: true,
      },
    });

    return boxes.map((box) => ({
      path: box.path,
      name: box.name,
      specialUse: box.specialUse || null,
      total: box.status?.messages ?? 0,
      unread: box.status?.unseen ?? 0,
    }));
  });
}

/**
 * Fetches and parses a single email by UID inside an already-locked mailbox.
 * Uses `source: true`, which ImapFlow translates to `BODY.PEEK[]` so `\Seen` is NEVER set.
 */
export async function fetchEmailInLockedMailbox(
  client: ImapFlow,
  folder: string,
  uid: number,
): Promise<EmailDetail> {
  const msg: FetchMessageObject | false = await client.fetchOne(
    String(uid),
    {
      uid: true,
      flags: true,
      envelope: true,
      source: true,
    },
    { uid: true },
  );

  if (!msg || !msg.source) {
    throw new Error(`Email with UID ${uid} not found in folder "${folder}".`);
  }

  const parsed = await simpleParser(msg.source);

  let rawBody = (parsed.text || "").trim();
  if (!rawBody && typeof parsed.html === "string" && parsed.html.trim().length > 0) {
    rawBody = htmlToReadableText(parsed.html);
  }
  const truncated = rawBody.length > MAX_BODY_CHARS;
  const body = truncated ? rawBody.slice(0, MAX_BODY_CHARS) : rawBody;

  const attachments: AttachmentMeta[] = (parsed.attachments || []).map((att) => ({
    filename: att.filename || "unnamed",
    contentType: att.contentType || "application/octet-stream",
    size: att.size ?? 0,
  }));

  const refs = Array.isArray(parsed.references)
    ? parsed.references
    : parsed.references
      ? [parsed.references]
      : [];

  return {
    uid: msg.uid,
    folder,
    messageId: parsed.messageId || msg.envelope?.messageId || null,
    date: (parsed.date || msg.envelope?.date)?.toISOString() ?? null,
    from: parsed.from?.text || formatAddress(msg.envelope?.from?.[0]),
    to: formatAddressList(msg.envelope?.to),
    cc: formatAddressList(msg.envelope?.cc),
    replyTo: formatAddressList(msg.envelope?.replyTo),
    inReplyTo: parsed.inReplyTo || msg.envelope?.inReplyTo || null,
    references: refs,
    subject: parsed.subject ?? msg.envelope?.subject ?? "(no subject)",
    seen: msg.flags ? msg.flags.has("\\Seen") : false,
    body,
    truncated,
    attachments,
  };
}

export async function getEmail(
  config: SkyMailConfig,
  folder: string,
  uid: number,
): Promise<EmailDetail> {
  return withImap(config, async (client) => {
    const lock = await client.getMailboxLock(folder);
    try {
      return await fetchEmailInLockedMailbox(client, folder, uid);
    } finally {
      lock.release();
    }
  });
}

export function summariseMessageObject(msg: FetchMessageObject): EmailSummary {
  return {
    uid: msg.uid,
    date: msg.envelope?.date ? msg.envelope.date.toISOString() : null,
    from: formatAddress(msg.envelope?.from?.[0]),
    to: formatAddressList(msg.envelope?.to),
    subject: msg.envelope?.subject ?? "(no subject)",
    seen: msg.flags ? msg.flags.has("\\Seen") : false,
    hasAttachments: hasAttachmentsInStructure(msg.bodyStructure),
  };
}

function parseDateCriteria(dateStr: string, fieldName: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    throw new Error(`Invalid ${fieldName} date "${dateStr}". Expected YYYY-MM-DD.`);
  }
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Invalid ${fieldName} date "${dateStr}".`);
  }
  return d;
}

export async function searchEmails(
  config: SkyMailConfig,
  input: SearchEmailsInput,
): Promise<EmailSummary[]> {
  const folder = input.folder?.trim() || "INBOX";
  const limit = Math.min(Math.max(input.limit ?? 20, 1), 50);

  const criteria: SearchObject = {};
  if (input.from?.trim()) criteria.from = input.from.trim();
  if (input.to?.trim()) criteria.to = input.to.trim();
  if (input.subject?.trim()) criteria.subject = input.subject.trim();
  if (input.text?.trim()) criteria.text = input.text.trim();
  if (input.since?.trim()) criteria.since = parseDateCriteria(input.since.trim(), "since");
  if (input.before?.trim()) criteria.before = parseDateCriteria(input.before.trim(), "before");
  if (input.unreadOnly) criteria.seen = false;

  if (Object.keys(criteria).length === 0) {
    criteria.all = true;
  }

  return withImap(config, async (client) => {
    const lock = await client.getMailboxLock(folder);
    try {
      const matchingUids = await client.search(criteria, { uid: true });
      if (!matchingUids || matchingUids.length === 0) {
        return [];
      }

      // UIDs are strictly ascending in IMAP; slice the last `limit` and reverse for newest first
      const newestUids = matchingUids.slice(-limit).reverse();

      const fetched = await client.fetchAll(
        newestUids,
        {
          uid: true,
          flags: true,
          envelope: true,
          bodyStructure: true,
        },
        { uid: true },
      );

      const byUid = new Map(fetched.map((m) => [m.uid, m]));
      const results: EmailSummary[] = [];
      for (const uid of newestUids) {
        const msg = byUid.get(uid);
        if (msg) {
          results.push(summariseMessageObject(msg));
        }
      }
      return results;
    } finally {
      lock.release();
    }
  });
}

/**
 * Finds a folder by its IMAP special-use flag (e.g. "\Drafts", "\Sent"), falling back to `fallbackPath`.
 */
export async function findSpecialUseFolder(
  client: ImapFlow,
  specialUseFlag: string,
  fallbackPath: string,
): Promise<string> {
  const boxes = await client.list();
  const match = boxes.find((b) => b.specialUse === specialUseFlag);
  if (match) return match.path;
  const byName = boxes.find(
    (b) => b.path.toLowerCase() === fallbackPath.toLowerCase(),
  );
  return byName ? byName.path : fallbackPath;
}

export interface ResolvedReplyHeaders {
  subject: string;
  inReplyTo?: string;
  references?: string[];
}

/**
 * Resolves In-Reply-To, References, and a "Re: ..." subject from an existing message without marking it read.
 */
export async function resolveReplyHeaders(
  client: ImapFlow,
  input: DraftOrSendInput,
): Promise<ResolvedReplyHeaders> {
  let subject = input.subject.trim();
  if (!input.replyToUid) {
    return { subject };
  }

  const replyFolder = input.replyToFolder?.trim() || "INBOX";
  const lock = await client.getMailboxLock(replyFolder);
  try {
    const orig = await client.fetchOne(
      String(input.replyToUid),
      {
        uid: true,
        envelope: true,
        headers: ["message-id", "references", "subject"],
      },
      { uid: true },
    );

    if (!orig) {
      throw new Error(
        `Original email UID ${input.replyToUid} not found in folder "${replyFolder}".`,
      );
    }

    const parsedHeaders = orig.headers ? await simpleParser(orig.headers) : null;
    const origMessageId =
      parsedHeaders?.messageId || orig.envelope?.messageId || undefined;
    const origSubject =
      parsedHeaders?.subject || orig.envelope?.subject || subject;

    const existingRefs = parsedHeaders?.references
      ? Array.isArray(parsedHeaders.references)
        ? parsedHeaders.references
        : [parsedHeaders.references]
      : [];

    const references = [...existingRefs];
    if (origMessageId && !references.includes(origMessageId)) {
      references.push(origMessageId);
    }

    const baseSubject = subject || origSubject;
    if (!/^re:/i.test(baseSubject)) {
      subject = `Re: ${baseSubject}`;
    } else {
      subject = baseSubject;
    }

    return {
      subject,
      inReplyTo: origMessageId,
      references: references.length > 0 ? references : undefined,
    };
  } finally {
    lock.release();
  }
}

export async function createDraft(
  config: SkyMailConfig,
  input: DraftOrSendInput,
): Promise<CreateDraftResult> {
  return withImap(config, async (client) => {
    const replyMeta = await resolveReplyHeaders(client, input);
    const draftsFolder = await findSpecialUseFolder(client, "\\Drafts", "Drafts");

    const mime = await buildMimeMessage({
      from: config.user,
      to: input.to,
      cc: input.cc,
      subject: replyMeta.subject,
      text: input.body,
      inReplyTo: replyMeta.inReplyTo,
      references: replyMeta.references,
    });

    const appended = await client.append(draftsFolder, mime.raw, ["\\Draft"]);

    return {
      folder: draftsFolder,
      uid: appended && typeof appended.uid === "number" ? appended.uid : null,
      messageId: mime.messageId,
      subject: replyMeta.subject,
      to: input.to,
      cc: input.cc?.trim() || null,
      inReplyTo: replyMeta.inReplyTo ?? null,
    };
  });
}

export async function sendEmail(
  config: SkyMailConfig,
  input: DraftOrSendInput,
): Promise<SendEmailResult> {
  if (!config.allowSend) {
    throw new Error("Sending email is disabled (SKYMAIL_ALLOW_SEND is not true).");
  }

  return withImap(config, async (client) => {
    const replyMeta = await resolveReplyHeaders(client, input);
    const sentFolder = await findSpecialUseFolder(client, "\\Sent", "Sent");

    const mime = await buildMimeMessage({
      from: config.user,
      to: input.to,
      cc: input.cc,
      subject: replyMeta.subject,
      text: input.body,
      inReplyTo: replyMeta.inReplyTo,
      references: replyMeta.references,
    });

    // 1. Send over SMTP
    const smtpRes = await sendRawMimeViaSmtp(config, mime);

    // 2. SkyMail SMTP does not auto-save to \Sent, so APPEND a copy with \Seen
    const appended = await client.append(sentFolder, mime.raw, ["\\Seen"]);

    return {
      messageId: mime.messageId,
      subject: replyMeta.subject,
      to: input.to,
      cc: input.cc?.trim() || null,
      inReplyTo: replyMeta.inReplyTo ?? null,
      smtpResponse: smtpRes.response,
      sentFolder,
      sentUid: appended && typeof appended.uid === "number" ? appended.uid : null,
    };
  });
}
