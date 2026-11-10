import { appendFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ImapFlow,
  type FetchMessageObject,
  type MessageStructureObject,
  type SearchObject,
} from "imapflow";
import { simpleParser } from "mailparser";
import type { SkyMailConfig } from "./config.js";
import { buildMimeMessage, sendRawMimeViaSmtp } from "./smtp.js";

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OPERATIONS_LOG_PATH = join(PROJECT_ROOT, "operations.log");

export async function logOperation(
  action: string,
  details: Record<string, unknown>,
): Promise<void> {
  const entry = {
    timestamp: new Date().toISOString(),
    action,
    ...details,
  };
  const line = JSON.stringify(entry);
  console.error(`[skymail-audit] ${line}`);
  try {
    await appendFile(OPERATIONS_LOG_PATH, `${line}\n`, "utf8");
  } catch (err) {
    console.error("[skymail-audit] failed to write operations.log:", (err as Error).message);
  }
}

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
  cc: string[];
  subject: string;
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
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
  offset?: number;
  beforeUid?: number;
  uidsOnly?: boolean;
}

export interface SearchEmailsResult {
  folder: string;
  total: number;
  offset: number;
  count: number;
  hasMore: boolean;
  nextOffset: number | null;
  nextBeforeUid: number | null;
  uidsOnly: boolean;
  uids?: number[];
  emails?: EmailSummary[];
}

export interface CreateFolderResult {
  path: string;
  created: boolean;
  exists: boolean;
  createdParents: string[];
}

export interface MoveEmailsInput {
  folder: string;
  uids: number[];
  destination: string;
  dryRun?: boolean;
}

export interface MoveUidMapping {
  oldUid: number;
  newUid: number | null;
}

export interface MoveEmailsResult {
  folder: string;
  destination: string;
  dryRun: boolean;
  moved: number;
  notFound: number[];
  mapping: MoveUidMapping[];
}

export interface RenameFolderResult {
  path: string;
  newPath: string;
  renamedSubfolders: number;
}

export interface DeleteFolderResult {
  path: string;
  deleted: boolean;
}

export interface FindKeywordInput {
  folder?: string;
  keyword: string;
  uids?: number[];
  since?: string;
  before?: string;
  contextChars?: number;
  offset?: number;
  limit?: number;
}

export interface BodyKeywordMatch {
  snippet: string;
  position: number;
  inQuotedReply: boolean;
  inSignature: boolean;
}

export interface FindKeywordHit {
  uid: number;
  date: string | null;
  from: string;
  subject: string;
  inHeader: Array<"subject" | "from" | "to" | "cc">;
  bodyMatches: BodyKeywordMatch[];
  matchedOnlyInAttachmentsOrEncodedData: boolean;
}

export interface FindKeywordMiss {
  uid: number;
  noTextMatch: true;
  matchedOnlyInAttachmentsOrEncodedData: true;
}

export type FindKeywordItem = FindKeywordHit | FindKeywordMiss;

export interface FindKeywordResult {
  folder: string;
  keyword: string;
  totalCandidates: number;
  offset: number;
  count: number;
  hasMore: boolean;
  nextOffset: number | null;
  matchedCount: number;
  falsePositiveCount: number;
  results: FindKeywordItem[];
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
const SOCKET_TIMEOUT_MS = 90_000;
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

let sharedClient: ImapFlow | null = null;
let imapQueue: Promise<unknown> = Promise.resolve();
let pendingImapCalls = 0;

async function getConnectedClient(config: SkyMailConfig): Promise<ImapFlow> {
  if (sharedClient && sharedClient.usable) {
    return sharedClient;
  }
  if (sharedClient) {
    try {
      sharedClient.close();
    } catch {
      // Ignore
    }
    sharedClient = null;
  }

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
    socketTimeout: SOCKET_TIMEOUT_MS,
  });

  client.on("error", (err) => {
    console.error("[imap] socket error:", err.message);
  });

  client.on("close", () => {
    if (sharedClient === client) {
      sharedClient = null;
    }
  });

  await client.connect();
  sharedClient = client;
  return client;
}

/**
 * Serializes IMAP operations over a single connection and automatically runs LOGOUT
 * as soon as the last queued call finishes (`pendingImapCalls === 0`), so no idle
 * session is ever left open to compete with Outlook.
 */
export async function withImap<T>(
  config: SkyMailConfig,
  work: (client: ImapFlow) => Promise<T>,
): Promise<T> {
  pendingImapCalls++;
  const run = async (): Promise<T> => {
    try {
      const client = await getConnectedClient(config);
      return await work(client);
    } finally {
      pendingImapCalls--;
      if (pendingImapCalls === 0 && sharedClient) {
        const clientToClose = sharedClient;
        sharedClient = null;
        try {
          await clientToClose.logout();
        } catch {
          clientToClose.close();
        }
      }
    }
  };

  const resultPromise = imapQueue.then(run, run);
  imapQueue = resultPromise.then(
    () => undefined,
    () => undefined,
  );
  return resultPromise;
}

export async function closeImapConnection(): Promise<void> {
  const client = sharedClient;
  sharedClient = null;
  if (!client) return;
  try {
    await client.logout();
  } catch {
    client.close();
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
 * Extracts Message-ID tokens from a raw References header buffer fetched via BODY.PEEK[HEADER.FIELDS (REFERENCES)].
 */
function parseReferencesFromHeaderBuffer(headersBuf?: Buffer): string[] {
  if (!headersBuf || headersBuf.length === 0) return [];
  const raw = headersBuf.toString("utf8");
  const matches = raw.match(/<[^>\s]+>/g);
  if (matches && matches.length > 0) {
    return Array.from(new Set(matches));
  }
  const colonIdx = raw.indexOf(":");
  if (colonIdx < 0) return [];
  return raw
    .slice(colonIdx + 1)
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
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
  // Preserve exact folder string (do not .trim(), as folders may have trailing spaces)
  const targetFolder = folder && folder.length > 0 ? folder : "INBOX";
  return withImap(config, async (client) => {
    const lock = await client.getMailboxLock(targetFolder);
    try {
      return await fetchEmailInLockedMailbox(client, targetFolder, uid);
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
    cc: formatAddressList(msg.envelope?.cc),
    subject: msg.envelope?.subject ?? "(no subject)",
    messageId: msg.envelope?.messageId || null,
    inReplyTo: msg.envelope?.inReplyTo || null,
    references: parseReferencesFromHeaderBuffer(msg.headers),
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
): Promise<SearchEmailsResult> {
  // Never .trim() folder names: some SkyMail folders have trailing spaces (e.g. "Tomate ")
  const folder = input.folder && input.folder.length > 0 ? input.folder : "INBOX";
  const uidsOnly = Boolean(input.uidsOnly);
  const maxLimit = uidsOnly ? 5000 : 50;
  const defaultLimit = uidsOnly ? 1000 : 20;
  const limit = Math.min(Math.max(input.limit ?? defaultLimit, 1), maxLimit);
  const offset = Math.max(input.offset ?? 0, 0);

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
      const rawUids = await client.search(criteria, { uid: true });
      if (rawUids === false) {
        throw new Error(`IMAP SEARCH failed or timed out in folder "${folder}".`);
      }
      const allAscending = rawUids;
      const total = allAscending.length;

      // Sort descending (newest UIDs first)
      const descending = [...allAscending].reverse();

      // Apply optional beforeUid filter (only UIDs strictly older/smaller than beforeUid)
      const filtered =
        typeof input.beforeUid === "number" && input.beforeUid > 0
          ? descending.filter((u) => u < input.beforeUid!)
          : descending;

      const pageUids = filtered.slice(offset, offset + limit);
      const hasMore = offset + pageUids.length < filtered.length;
      const nextOffset = hasMore ? offset + pageUids.length : null;
      const nextBeforeUid =
        hasMore && pageUids.length > 0 ? pageUids[pageUids.length - 1] : null;

      if (uidsOnly) {
        return {
          folder,
          total,
          offset,
          count: pageUids.length,
          hasMore,
          nextOffset,
          nextBeforeUid,
          uidsOnly: true,
          uids: pageUids,
        };
      }

      if (pageUids.length === 0) {
        return {
          folder,
          total,
          offset,
          count: 0,
          hasMore: false,
          nextOffset: null,
          nextBeforeUid: null,
          uidsOnly: false,
          emails: [],
        };
      }

      const fetched = await client.fetchAll(
        pageUids,
        {
          uid: true,
          flags: true,
          envelope: true,
          bodyStructure: true,
          headers: ["references"],
        },
        { uid: true },
      );

      const byUid = new Map(fetched.map((m) => [m.uid, m]));
      const emails: EmailSummary[] = [];
      for (const uid of pageUids) {
        const msg = byUid.get(uid);
        if (msg) {
          emails.push(summariseMessageObject(msg));
        }
      }

      return {
        folder,
        total,
        offset,
        count: emails.length,
        hasMore,
        nextOffset,
        nextBeforeUid,
        uidsOnly: false,
        emails,
      };
    } finally {
      lock.release();
    }
  });
}

function folderExistsInList(
  boxes: Array<{ path: string }>,
  targetPath: string,
): boolean {
  if (targetPath.toUpperCase() === "INBOX") return true;
  return boxes.some((b) => b.path === targetPath);
}

/**
 * Creates a folder (and any missing parent folders along the "." hierarchy) and subscribes to it.
 * Idempotent: if the folder already exists, returns { path, created: false, exists: true }.
 */
export async function createFolder(
  config: SkyMailConfig,
  path: string,
): Promise<CreateFolderResult> {
  if (!path || path.length === 0) {
    throw new Error("Folder path must not be empty.");
  }

  return withImap(config, async (client) => {
    const boxes = await client.list();
    const existing = new Set(boxes.map((b) => b.path));

    if (existing.has(path) || path.toUpperCase() === "INBOX") {
      try {
        await client.mailboxSubscribe(path);
      } catch {
        // Ignore if server doesn't need/allow subscribing existing folder
      }
      await logOperation("create_folder", {
        path,
        created: false,
        exists: true,
        createdParents: [],
      });
      return {
        path,
        created: false,
        exists: true,
        createdParents: [],
      };
    }

    const parts = path.split(".");
    if (parts.some((p) => p.length === 0)) {
      throw new Error(`Invalid folder path "${path}": contains empty hierarchy segment.`);
    }

    const createdParents: string[] = [];
    for (let i = 1; i < parts.length; i++) {
      const parentPath = parts.slice(0, i).join(".");
      if (!existing.has(parentPath)) {
        const parentRes = await client.mailboxCreate(parentPath);
        existing.add(parentPath);
        if (parentRes?.created) {
          createdParents.push(parentPath);
        }
        try {
          await client.mailboxSubscribe(parentPath);
        } catch {
          // mailboxCreate in ImapFlow already runs SUBSCRIBE, ignore if redundant
        }
      }
    }

    const res = await client.mailboxCreate(path);
    try {
      await client.mailboxSubscribe(path);
    } catch {
      // Already subscribed by mailboxCreate
    }

    const result: CreateFolderResult = {
      path,
      created: Boolean(res?.created),
      exists: true,
      createdParents,
    };

    await logOperation("create_folder", { ...result });
    return result;
  });
}

/**
 * Moves up to 200 emails by UID from `folder` to `destination` while preserving read/unread flags.
 * Uses UID MOVE (RFC 6851) or falls back to UID COPY + UID STORE \Deleted + UID EXPUNGE (UIDPLUS).
 * Never executes a mailbox-wide EXPUNGE.
 */
export async function moveEmails(
  config: SkyMailConfig,
  input: MoveEmailsInput,
): Promise<MoveEmailsResult> {
  const folder = input.folder;
  const destination = input.destination;
  const dryRun = Boolean(input.dryRun);

  if (!folder || folder.length === 0) {
    throw new Error("Source folder is required.");
  }
  if (!destination || destination.length === 0) {
    throw new Error("Destination folder is required.");
  }
  if (folder === destination) {
    throw new Error(`Source and destination folders must be different ("${folder}").`);
  }
  if (!Array.isArray(input.uids) || input.uids.length === 0) {
    throw new Error("At least one UID must be provided in `uids`.");
  }
  if (input.uids.length > 200) {
    throw new Error(
      `Maximum 200 UIDs allowed per move_emails call (received ${input.uids.length}).`,
    );
  }

  const uniqueUids = Array.from(new Set(input.uids));

  return withImap(config, async (client) => {
    const boxes = await client.list();
    if (!folderExistsInList(boxes, folder)) {
      throw new Error(`Source folder "${folder}" does not exist.`);
    }
    if (!folderExistsInList(boxes, destination)) {
      throw new Error(
        `Destination folder "${destination}" does not exist. Create it first with create_folder.`,
      );
    }

    const lock = await client.getMailboxLock(folder);
    try {
      // Check which UIDs actually exist in the source folder
      const existingMsgs = await client.fetchAll(
        uniqueUids,
        { uid: true },
        { uid: true },
      );
      const existingUidSet = new Set(existingMsgs.map((m) => m.uid));
      const foundUids = uniqueUids.filter((u) => existingUidSet.has(u));
      const notFound = uniqueUids.filter((u) => !existingUidSet.has(u));

      if (dryRun || foundUids.length === 0) {
        const result: MoveEmailsResult = {
          folder,
          destination,
          dryRun,
          moved: foundUids.length,
          notFound,
          mapping: foundUids.map((oldUid) => ({ oldUid, newUid: null })),
        };
        await logOperation("move_emails", {
          folder,
          destination,
          dryRun,
          requestedCount: uniqueUids.length,
          moved: result.moved,
          uids: foundUids,
          notFound,
        });
        return result;
      }

      // Safety guarantee: never run a mailbox-wide EXPUNGE
      const hasMove = client.capabilities.has("MOVE");
      const hasUidPlus = client.capabilities.has("UIDPLUS");
      if (!hasMove && !hasUidPlus) {
        throw new Error(
          "Server supports neither UID MOVE (RFC 6851) nor UIDPLUS (UID EXPUNGE); refusing to move to avoid mailbox-wide EXPUNGE.",
        );
      }

      const moveRes = await client.messageMove(foundUids, destination, {
        uid: true,
      });
      if (!moveRes) {
        throw new Error(
          `IMAP move command failed from "${folder}" to "${destination}".`,
        );
      }

      const uidMap = moveRes.uidMap;
      const mapping: MoveUidMapping[] = foundUids.map((oldUid) => ({
        oldUid,
        newUid: uidMap?.get(oldUid) ?? null,
      }));

      const result: MoveEmailsResult = {
        folder,
        destination,
        dryRun: false,
        moved: foundUids.length,
        notFound,
        mapping,
      };

      await logOperation("move_emails", {
        folder,
        destination,
        dryRun: false,
        moved: result.moved,
        uids: foundUids,
        notFound,
        mapping,
      });

      return result;
    } finally {
      lock.release();
    }
  });
}

/**
 * Renames a folder (moving all its messages and subfolders) and updates IMAP subscriptions.
 * Errors if `newPath` already exists.
 */
export async function renameFolder(
  config: SkyMailConfig,
  path: string,
  newPath: string,
): Promise<RenameFolderResult> {
  if (!path || path.length === 0) {
    throw new Error("Current folder `path` is required.");
  }
  if (!newPath || newPath.length === 0) {
    throw new Error("Target folder `newPath` is required.");
  }
  if (path === newPath) {
    throw new Error("`path` and `newPath` must be different.");
  }
  if (path.toUpperCase() === "INBOX") {
    throw new Error("Cannot rename INBOX.");
  }

  return withImap(config, async (client) => {
    const boxes = await client.list();
    const existing = new Set(boxes.map((b) => b.path));

    if (!existing.has(path)) {
      throw new Error(`Folder "${path}" does not exist.`);
    }
    if (existing.has(newPath) || newPath.toUpperCase() === "INBOX") {
      throw new Error(`Target folder "${newPath}" already exists.`);
    }

    // Ensure parent folders of newPath exist if moving into a hierarchy
    const newParts = newPath.split(".");
    for (let i = 1; i < newParts.length; i++) {
      const parentPath = newParts.slice(0, i).join(".");
      if (!existing.has(parentPath)) {
        await client.mailboxCreate(parentPath);
        existing.add(parentPath);
      }
    }

    const subfolders = boxes
      .filter((b) => b.path.startsWith(`${path}.`))
      .map((b) => b.path);

    await client.mailboxRename(path, newPath);

    // Update subscriptions for the renamed folder and any subfolders
    try {
      await client.mailboxSubscribe(newPath);
    } catch {
      // Ignore subscription warning
    }
    try {
      await client.mailboxUnsubscribe(path);
    } catch {
      // Ignore unsubscribe warning
    }

    for (const oldSub of subfolders) {
      const newSub = `${newPath}${oldSub.slice(path.length)}`;
      try {
        await client.mailboxSubscribe(newSub);
      } catch {
        // Ignore
      }
      try {
        await client.mailboxUnsubscribe(oldSub);
      } catch {
        // Ignore
      }
    }

    const result: RenameFolderResult = {
      path,
      newPath,
      renamedSubfolders: subfolders.length,
    };

    await logOperation("rename_folder", { ...result });
    return result;
  });
}

/**
 * Deletes a folder ONLY if it has zero messages and zero subfolders.
 */
export async function deleteFolder(
  config: SkyMailConfig,
  path: string,
): Promise<DeleteFolderResult> {
  if (!path || path.length === 0) {
    throw new Error("Folder `path` is required.");
  }
  if (path.toUpperCase() === "INBOX") {
    throw new Error("Cannot delete INBOX.");
  }

  return withImap(config, async (client) => {
    const boxes = await client.list();
    const targetBox = boxes.find((b) => b.path === path);
    if (!targetBox) {
      throw new Error(`Folder "${path}" does not exist.`);
    }
    if (targetBox.specialUse) {
      throw new Error(
        `Cannot delete special-use system folder "${path}" (${targetBox.specialUse}).`,
      );
    }

    const subfolders = boxes
      .filter((b) => b.path.startsWith(`${path}.`))
      .map((b) => b.path);
    if (subfolders.length > 0) {
      throw new Error(
        `Cannot delete folder "${path}" because it has ${subfolders.length} subfolder(s): ${subfolders.slice(0, 5).join(", ")}.`,
      );
    }

    const status = await client.status(path, { messages: true });
    const messageCount = status.messages ?? 0;
    if (messageCount > 0) {
      throw new Error(
        `Cannot delete folder "${path}" because it is not empty (${messageCount} message(s)).`,
      );
    }

    try {
      await client.mailboxUnsubscribe(path);
    } catch {
      // Ignore
    }
    await client.mailboxDelete(path);

    const result: DeleteFolderResult = {
      path,
      deleted: true,
    };

    await logOperation("delete_folder", { ...result });
    return result;
  });
}

interface TextPartSpec {
  key: string;
  mimeType: "text/plain" | "text/html";
  encoding: string;
  charset: string;
}

function collectTextParts(
  node?: MessageStructureObject,
  isRoot = true,
): TextPartSpec[] {
  if (!node) return [];
  const disposition = (node.disposition || "").toLowerCase();
  if (disposition === "attachment") {
    return [];
  }

  const mimeType = (node.type || "").toLowerCase();
  if (mimeType === "message/rfc822") {
    // Never descend into attached/encapsulated message/rfc822 parts
    return [];
  }

  if (Array.isArray(node.childNodes) && node.childNodes.length > 0) {
    const out: TextPartSpec[] = [];
    for (const child of node.childNodes) {
      out.push(...collectTextParts(child, false));
    }
    return out;
  }

  // Skip inline files that carry a filename
  const hasFilename = Boolean(
    node.dispositionParameters?.filename || node.parameters?.name,
  );
  if (hasFilename) {
    return [];
  }

  if (mimeType === "text/plain" || mimeType === "text/html") {
    const key = isRoot && !node.part ? "text" : (node.part || "text").toLowerCase();
    const encoding = (node.encoding || "7bit").toLowerCase();
    const charset = (node.parameters?.charset || "utf-8").toLowerCase().trim();
    return [{ key, mimeType, encoding, charset }];
  }

  return [];
}

function decodeQuotedPrintable(input: Buffer): Buffer {
  const str = input.toString("latin1").replace(/=[ \t]*\r?\n/g, "");
  const bytes: number[] = [];
  for (let i = 0; i < str.length; i++) {
    if (
      str[i] === "=" &&
      i + 2 < str.length &&
      /^[0-9A-Fa-f]{2}$/.test(str.slice(i + 1, i + 3))
    ) {
      bytes.push(Number.parseInt(str.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(str.charCodeAt(i));
    }
  }
  return Buffer.from(bytes);
}

function decodePartBuffer(
  raw: Buffer,
  encoding: string,
  charset: string,
): string {
  let bytes: Buffer;
  if (encoding === "base64") {
    bytes = Buffer.from(raw.toString("ascii"), "base64");
  } else if (encoding === "quoted-printable") {
    bytes = decodeQuotedPrintable(raw);
  } else {
    bytes = raw;
  }

  const normalizedCharset =
    charset === "utf8" || !charset
      ? "utf-8"
      : charset === "latin1" || charset === "iso8859-1" || charset === "cp1252"
        ? "windows-1252"
        : charset;

  try {
    return new TextDecoder(normalizedCharset, { fatal: false }).decode(bytes);
  } catch {
    return bytes.toString("utf8");
  }
}

function foldChar(ch: string): string {
  return ch
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function foldWithIndexMap(text: string): { folded: string; mapToOrig: number[] } {
  const chars: string[] = [];
  const mapToOrig: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const f = foldChar(text[i]);
    for (let j = 0; j < f.length; j++) {
      chars.push(f[j]);
      mapToOrig.push(i);
    }
  }
  mapToOrig.push(text.length);
  return { folded: chars.join(""), mapToOrig };
}

function buildKeywordRegex(keyword: string): RegExp {
  const foldedKw = keyword
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
  if (!foldedKw) {
    throw new Error("Keyword must not be empty.");
  }
  const escaped = foldedKw
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\s+/g, "\\s+");
  const prefix = /^[a-z0-9]/.test(foldedKw) ? "(?<![a-z0-9])" : "";
  const suffix = /[a-z0-9]$/.test(foldedKw) ? "(?![a-z0-9])" : "";
  return new RegExp(`${prefix}${escaped}${suffix}`, "g");
}

function hasWholeWordMatch(text: string, regex: RegExp): boolean {
  if (!text) return false;
  const { folded } = foldWithIndexMap(text);
  regex.lastIndex = 0;
  return regex.test(folded);
}

interface LineSpan {
  index: number;
  start: number;
  end: number;
  raw: string;
  folded: string;
}

function splitLinesWithSpans(text: string): LineSpan[] {
  const spans: LineSpan[] = [];
  let pos = 0;
  const rawLines = text.split("\n");
  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i].replace(/\r$/, "");
    const start = pos;
    const end = pos + rawLines[i].length;
    spans.push({
      index: i,
      start,
      end,
      raw,
      folded: raw
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .trim(),
    });
    pos = end + 1;
  }
  return spans;
}

function isReplyHeaderLine(lines: LineSpan[], idx: number): boolean {
  const line = lines[idx].folded;
  if (!line) return false;

  // Classic Outlook / webmail separators
  if (
    /^-{2,}\s*(original message|mensagem original|forwarded message|mensagem encaminhada)/i.test(
      line,
    )
  ) {
    return true;
  }
  // "On ... wrote:" / "Em ... escreveu:"
  if (/^(on\s+.+\s+wrote|em\s+.+\s+escreveu)\s*:?$/i.test(line)) {
    return true;
  }
  // "De: ..." / "From: ..." / "Enviada em: ..." / "Assunto: ..." / "Subject: ..."
  if (
    /^[>\s*]*(de|from|enviada em|sent|assunto|subject)\s*:\s*\S+/i.test(line)
  ) {
    if (line.includes("@")) return true;
    const windowStart = Math.max(0, idx - 4);
    const windowEnd = Math.min(lines.length, idx + 8);
    for (let j = windowStart; j < windowEnd; j++) {
      if (j === idx) continue;
      if (
        /^[>\s*]*(de|from|enviada em|sent|data|date|para|to|cc|assunto|subject)\s*:\s*\S+/i.test(
          lines[j].folded,
        )
      ) {
        return true;
      }
    }
  }
  return false;
}

function isSignOffLine(foldedLine: string): boolean {
  if (!foldedLine) return false;
  if (/^--\s*$/.test(foldedLine)) return true;
  return /^(atenciosamente|att\.?(?:,|;|$)|abracos|cordialmente|best regards|kind regards|warm regards|regards|sincerely|saludos|cordiales saludos|atentamente|cordiali saluti|distinti saluti|cordialement|bien cordialement)\b/i.test(
    foldedLine,
  );
}

function isDisclaimerLine(foldedLine: string): boolean {
  if (!foldedLine) return false;
  return /\b(aviso de confidencialidade|esta mensagem pode conter|this email and any attachments|confidentiality notice|disclaimer|antes de imprimir|before printing)\b/i.test(
    foldedLine,
  );
}

export function extractBodyKeywordMatches(
  text: string,
  regex: RegExp,
  contextChars: number,
): BodyKeywordMatch[] {
  if (!text) return [];
  const { folded, mapToOrig } = foldWithIndexMap(text);
  const lines = splitLinesWithSpans(text);

  // Locate all reply header boundaries
  const replyBoundaryIndices: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (isReplyHeaderLine(lines, i)) {
      replyBoundaryIndices.push(i);
    }
  }
  const firstReplyBoundary =
    replyBoundaryIndices.length > 0 ? replyBoundaryIndices[0] : Infinity;

  const matches: BodyKeywordMatch[] = [];
  regex.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(folded)) !== null) {
    const origStart = mapToOrig[m.index] ?? 0;
    const origEnd = mapToOrig[m.index + m[0].length] ?? text.length;

    const snippetStart = Math.max(0, origStart - contextChars);
    const snippetEnd = Math.min(text.length, origEnd + contextChars);
    const snippet = text
      .slice(snippetStart, snippetEnd)
      .replace(/\s+/g, " ")
      .trim();

    const position = Number(
      (origStart / Math.max(text.length, 1)).toFixed(3),
    );

    // Find which line contains origStart
    let lineIdx = 0;
    for (let i = 0; i < lines.length; i++) {
      if (origStart >= lines[i].start && origStart <= lines[i].end) {
        lineIdx = i;
        break;
      }
    }

    const lineRaw = lines[lineIdx]?.raw ?? "";
    const inQuotedReply =
      /^\s*>/.test(lineRaw) || lineIdx >= firstReplyBoundary;

    // Determine segment bounds [segStart, segEnd) for signature detection
    let segStart = 0;
    let segEnd = lines.length;
    for (const bIdx of replyBoundaryIndices) {
      if (bIdx <= lineIdx) {
        segStart = bIdx;
      } else if (bIdx > lineIdx) {
        segEnd = bIdx;
        break;
      }
    }

    let inSignature = false;
    // Check if inside a legal/disclaimer block (within 15 lines after disclaimer start)
    for (let i = Math.max(segStart, lineIdx - 15); i <= lineIdx; i++) {
      if (isDisclaimerLine(lines[i].folded)) {
        inSignature = true;
        break;
      }
    }

    // Check if after a sign-off line in the current message segment and within ~25 lines of the end of the segment
    if (!inSignature && segEnd - lineIdx <= 25) {
      const lookbackStart = Math.max(segStart, lineIdx - 18);
      for (let i = lookbackStart; i < lineIdx; i++) {
        if (isSignOffLine(lines[i].folded)) {
          inSignature = true;
          break;
        }
      }
    }

    matches.push({
      snippet,
      position,
      inQuotedReply,
      inSignature,
    });
  }

  return matches;
}

export async function findKeyword(
  config: SkyMailConfig,
  input: FindKeywordInput,
): Promise<FindKeywordResult> {
  // Never .trim() folder names: preserve trailing spaces
  const folder = input.folder && input.folder.length > 0 ? input.folder : "INBOX";
  const keyword = input.keyword.trim();
  if (!keyword) {
    throw new Error("`keyword` must not be empty.");
  }
  const regex = buildKeywordRegex(keyword);
  const contextChars = Math.min(Math.max(input.contextChars ?? 120, 20), 1000);
  const offset = Math.max(input.offset ?? 0, 0);
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);

  if (input.uids && input.uids.length > 200) {
    throw new Error(
      `Maximum 200 UIDs allowed in find_keyword \`uids\` (received ${input.uids.length}).`,
    );
  }

  return withImap(config, async (client) => {
    const lock = await client.getMailboxLock(folder);
    try {
      let allCandidateUids: number[];
      if (input.uids && input.uids.length > 0) {
        allCandidateUids = Array.from(new Set(input.uids));
      } else {
        const criteria: SearchObject = { text: keyword };
        if (input.since?.trim()) {
          criteria.since = parseDateCriteria(input.since.trim(), "since");
        }
        if (input.before?.trim()) {
          criteria.before = parseDateCriteria(input.before.trim(), "before");
        }
        const rawUids = await client.search(criteria, { uid: true });
        if (rawUids === false) {
          throw new Error(`IMAP SEARCH failed or timed out in folder "${folder}".`);
        }
        allCandidateUids = [...rawUids].reverse();
      }

      const totalCandidates = allCandidateUids.length;
      const pageUids = allCandidateUids.slice(offset, offset + limit);
      const hasMore = offset + pageUids.length < totalCandidates;
      const nextOffset = hasMore ? offset + pageUids.length : null;

      if (pageUids.length === 0) {
        return {
          folder,
          keyword,
          totalCandidates,
          offset,
          count: 0,
          hasMore: false,
          nextOffset: null,
          matchedCount: 0,
          falsePositiveCount: 0,
          results: [],
        };
      }

      // 1. Fetch envelope and bodyStructure for all candidates in pageUids
      const metaList = await client.fetchAll(
        pageUids,
        {
          uid: true,
          envelope: true,
          bodyStructure: true,
        },
        { uid: true },
      );
      const metaByUid = new Map(metaList.map((m) => [m.uid, m]));

      // 2. Group UIDs by the text bodyParts keys they require
      const specsByUid = new Map<number, TextPartSpec[]>();
      const groupMap = new Map<string, { keys: string[]; uids: number[] }>();

      for (const uid of pageUids) {
        const meta = metaByUid.get(uid);
        if (!meta) continue;
        const specs = collectTextParts(meta.bodyStructure, true);
        specsByUid.set(uid, specs);
        if (specs.length > 0) {
          const uniqueKeys = Array.from(new Set(specs.map((s) => s.key))).sort();
          const sig = uniqueKeys.join(",");
          let group = groupMap.get(sig);
          if (!group) {
            group = { keys: uniqueKeys, uids: [] };
            groupMap.set(sig, group);
          }
          group.uids.push(uid);
        }
      }

      // 3. Batch-fetch only those text bodyParts (never attachments!) via BODY.PEEK
      const bodyPartsByUid = new Map<number, Map<string, Buffer>>();
      for (const group of groupMap.values()) {
        const fetchedParts = await client.fetchAll(
          group.uids,
          {
            uid: true,
            bodyParts: group.keys,
          },
          { uid: true },
        );
        for (const item of fetchedParts) {
          if (item.bodyParts) {
            bodyPartsByUid.set(item.uid, item.bodyParts);
          }
        }
      }

      // 4. Decode text parts and run accent/case-insensitive whole-word matching
      const results: FindKeywordItem[] = [];
      let matchedCount = 0;
      let falsePositiveCount = 0;

      for (const uid of pageUids) {
        const meta = metaByUid.get(uid);
        if (!meta) {
          falsePositiveCount++;
          results.push({
            uid,
            noTextMatch: true,
            matchedOnlyInAttachmentsOrEncodedData: true,
          });
          continue;
        }

        const subjectStr = meta.envelope?.subject ?? "";
        const fromStr = formatAddress(meta.envelope?.from?.[0]);
        const toStr = formatAddressList(meta.envelope?.to).join(", ");
        const ccStr = formatAddressList(meta.envelope?.cc).join(", ");

        const inHeader: Array<"subject" | "from" | "to" | "cc"> = [];
        if (hasWholeWordMatch(subjectStr, regex)) inHeader.push("subject");
        if (hasWholeWordMatch(fromStr, regex)) inHeader.push("from");
        if (hasWholeWordMatch(toStr, regex)) inHeader.push("to");
        if (hasWholeWordMatch(ccStr, regex)) inHeader.push("cc");

        const specs = specsByUid.get(uid) ?? [];
        const partsMap = bodyPartsByUid.get(uid);

        const plainChunks: string[] = [];
        const htmlChunks: string[] = [];

        if (partsMap) {
          for (const spec of specs) {
            const rawBuf =
              partsMap.get(spec.key) ?? partsMap.get(spec.key.toUpperCase());
            if (!rawBuf || rawBuf.length === 0) continue;
            const decoded = decodePartBuffer(
              rawBuf,
              spec.encoding,
              spec.charset,
            );
            if (spec.mimeType === "text/plain") {
              plainChunks.push(decoded);
            } else {
              htmlChunks.push(htmlToReadableText(decoded));
            }
          }
        }

        const plainText = plainChunks.join("\n\n").trim();
        const htmlText = htmlChunks.join("\n\n").trim();

        let bodyMatches: BodyKeywordMatch[] = [];
        if (plainText) {
          bodyMatches = extractBodyKeywordMatches(plainText, regex, contextChars);
        }
        if (htmlText) {
          if (!plainText) {
            bodyMatches = extractBodyKeywordMatches(htmlText, regex, contextChars);
          } else {
            const htmlMatches = extractBodyKeywordMatches(
              htmlText,
              regex,
              contextChars,
            );
            for (const hm of htmlMatches) {
              // Only add an HTML match if it wasn't already captured at a nearby relative position in text/plain
              const alreadyPresent = bodyMatches.some(
                (bm) => Math.abs(bm.position - hm.position) < 0.08,
              );
              if (!alreadyPresent) {
                bodyMatches.push(hm);
              }
            }
          }
        }

        if (inHeader.length === 0 && bodyMatches.length === 0) {
          falsePositiveCount++;
          results.push({
            uid,
            noTextMatch: true,
            matchedOnlyInAttachmentsOrEncodedData: true,
          });
        } else {
          matchedCount++;
          results.push({
            uid,
            date: meta.envelope?.date ? meta.envelope.date.toISOString() : null,
            from: fromStr,
            subject: subjectStr || "(no subject)",
            inHeader,
            bodyMatches,
            matchedOnlyInAttachmentsOrEncodedData: false,
          });
        }
      }

      return {
        folder,
        keyword,
        totalCandidates,
        offset,
        count: results.length,
        hasMore,
        nextOffset,
        matchedCount,
        falsePositiveCount,
        results,
      };
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

  // Preserve exact folder name (do not .trim())
  const replyFolder =
    input.replyToFolder && input.replyToFolder.length > 0
      ? input.replyToFolder
      : "INBOX";
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
