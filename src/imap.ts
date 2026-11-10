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

let sharedClient: ImapFlow | null = null;
let imapQueue: Promise<unknown> = Promise.resolve();

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
    socketTimeout: TIMEOUT_MS,
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
 * Runs an IMAP operation serialized on a warm, lazy connection (reconnecting automatically if dropped).
 */
export async function withImap<T>(
  config: SkyMailConfig,
  work: (client: ImapFlow) => Promise<T>,
): Promise<T> {
  const run = async (): Promise<T> => {
    const client = await getConnectedClient(config);
    return await work(client);
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
      const allAscending = rawUids || [];
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
