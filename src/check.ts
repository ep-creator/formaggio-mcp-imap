import { loadConfig, sanitizeError } from "./config.js";
import {
  closeImapConnection,
  fetchEmailInLockedMailbox,
  listFolders,
  summariseMessageObject,
  withImap,
} from "./imap.js";
import { verifySmtpLogin } from "./smtp.js";

async function runCheck(): Promise<void> {
  const config = loadConfig();
  console.log(`Checking SkyMail connection for: ${config.user}`);
  console.log(`IMAP: ${config.imapHost}:${config.imapPort} (TLS)`);
  console.log(`SMTP: ${config.smtpHost}:${config.smtpPort} (TLS)\n`);

  // 1. List folders
  console.log("1) Listing IMAP folders...");
  const folders = await listFolders(config);
  for (const f of folders) {
    const special = f.specialUse ? ` [${f.specialUse}]` : "";
    console.log(`   - ${f.path}${special} (total: ${f.total}, unread: ${f.unread})`);
  }
  console.log("");

  // 2 & 3. Fetch 5 newest INBOX messages + verify unread read stays unread
  await withImap(config, async (client) => {
    const lock = await client.getMailboxLock("INBOX");
    try {
      console.log("2) Fetching 5 newest INBOX messages...");
      const allUids = await client.search({ all: true }, { uid: true });
      const newestUids = (allUids || []).slice(-5).reverse();

      if (newestUids.length === 0) {
        console.log("   (INBOX is empty)");
      } else {
        const fetched = await client.fetchAll(
          newestUids,
          { uid: true, flags: true, envelope: true, bodyStructure: true },
          { uid: true },
        );
        const byUid = new Map(fetched.map((m) => [m.uid, m]));
        for (const uid of newestUids) {
          const msg = byUid.get(uid);
          if (!msg) continue;
          const summary = summariseMessageObject(msg);
          const readTag = summary.seen ? "read" : "UNREAD";
          const attachTag = summary.hasAttachments ? " [hasAttachment]" : "";
          console.log(
            `   - [UID ${summary.uid}] (${readTag})${attachTag} ${summary.date ?? ""} | ${summary.from} | ${summary.subject}`,
          );
        }
      }
      console.log("");

      console.log("3) Verifying BODY.PEEK behavior (unread message stays unread after get_email fetch)...");
      const unreadUids = await client.search({ seen: false }, { uid: true });
      if (!unreadUids || unreadUids.length === 0) {
        console.log("   ! No unread messages found in INBOX to test unread preservation.");
      } else {
        const targetUid = unreadUids[unreadUids.length - 1];
        const beforeMsg = await client.fetchOne(
          String(targetUid),
          { uid: true, flags: true },
          { uid: true },
        );
        const seenBefore = beforeMsg && beforeMsg.flags ? beforeMsg.flags.has("\\Seen") : false;

        // Fetch full email using the exact helper get_email uses
        const detail = await fetchEmailInLockedMailbox(client, "INBOX", targetUid);

        // Re-read flags from the server after fetching the body
        const afterMsg = await client.fetchOne(
          String(targetUid),
          { uid: true, flags: true },
          { uid: true },
        );
        const seenAfter = afterMsg && afterMsg.flags ? afterMsg.flags.has("\\Seen") : false;
        const afterFlags = afterMsg && afterMsg.flags ? Array.from(afterMsg.flags).join(", ") : "(none)";

        console.log(`   - Tested UID ${targetUid} ("${detail.subject}", body length: ${detail.body.length} chars)`);
        console.log(`   - \\Seen before fetch: ${seenBefore}`);
        console.log(`   - \\Seen after fetch:  ${seenAfter} (flags now: ${afterFlags || "none"})`);

        if (!seenBefore && !seenAfter) {
          console.log("   ✓ CONFIRMED: Message remained UNREAD (\\Seen is absent).");
        } else {
          throw new Error(`Unread preservation check failed for UID ${targetUid}: seenAfter=${seenAfter}`);
        }
      }
    } finally {
      lock.release();
    }
  });

  console.log("");
  console.log("4) Verifying SMTP login (no email sent)...");
  await verifySmtpLogin(config);
  console.log("   ✓ SMTP login verified successfully.");
  await closeImapConnection();
  console.log("\nAll checks passed!");
}

runCheck().catch(async (err) => {
  console.error("\nCheck failed:", sanitizeError(err));
  await closeImapConnection();
  process.exit(1);
});
