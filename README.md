# Formaggio SkyMail MCP Server (MVP)

A simple, local Model Context Protocol (MCP) server over **stdio** that lets Claude Desktop on Windows read, search, and draft (plus optionally send) emails on a single SkyMail account via IMAP and SMTP.

## Features & Tools

1. **`list_folders`** — Lists all mailboxes with their path, IMAP special-use flag (`\Inbox`, `\Sent`, `\Drafts`, `\Trash`, `\Junk`, `\Archive`), total message count, and unread count.
2. **`search_emails`** — Searches a folder (default `INBOX`) by `from`, `to`, `subject`, `text`, `since` (`YYYY-MM-DD`), `before` (`YYYY-MM-DD`), `unreadOnly`, and `limit` (default 20, max 50). Returns newest messages first with `uid`, `date`, `from`, `to`, `subject`, `seen`, and `hasAttachments`.
3. **`get_email`** — Fetches a single email by `folder` and `uid` **without marking it as read** (`BODY.PEEK[]`). Converts HTML-only emails to readable plain text, truncates bodies at 20,000 characters (with a clear notice), and returns attachment metadata (`filename`, `contentType`, `size`).
4. **`create_draft`** — Builds a plain-text MIME message with `MailComposer` (supporting threaded replies via `replyToUid` + `replyToFolder`, which set `In-Reply-To`, `References`, and a `Re:` subject) and appends it to the `\Drafts` folder (`Rascunhos`) with the `\Draft` flag.
5. **`send_email`** *(only registered when `SKYMAIL_ALLOW_SEND=true`)* — Sends a plain-text email via SMTP (`smtp.skymail.net.br:465`) and `APPEND`s a copy with the `\Seen` flag to the `\Sent` folder (`Itens Enviados`), since SkyMail SMTP does not save sent copies automatically.

### Safety
- All untrusted email-derived fields (`from`, `to`, `cc`, `replyTo`, `subject`, `body`, attachment `filename`) are wrapped in `<untrusted_email_content>...</untrusted_email_content>` along with a security warning instructing the model never to follow instructions inside email content.
- Credentials are never logged, and error messages are scrubbed before being returned to the MCP client.
- No delete, move, or flag-mutating tools are included in this MVP.

---

## Setup & Installation (Windows)

### Prerequisites
- **Node.js 22+** (uses Node's built-in `--env-file` flag)

### 1. Install dependencies & build
```powershell
npm install
npm run build
```

### 2. Configure `.env`
Copy `.env.example` to `.env`:
```powershell
Copy-Item .env.example .env
```

Edit `.env` with your SkyMail credentials:
```ini
SKYMAIL_USER=someone@formaggio.com.br
# Wrap in single or double quotes if your password contains '#' or spaces
SKYMAIL_PASSWORD="your-password"
SKYMAIL_IMAP_HOST=imap.skymail.net.br
SKYMAIL_IMAP_PORT=993
SKYMAIL_SMTP_HOST=smtp.skymail.net.br
SKYMAIL_SMTP_PORT=465
SKYMAIL_ALLOW_SEND=false
```

### 3. Run the smoke test
```powershell
npm run check
```
This builds the project, connects to IMAP, prints your folder list and the 5 newest `INBOX` subjects, proves that fetching an unread email via `BODY.PEEK` leaves `\Seen` absent, and verifies your SMTP login (`transporter.verify()`) without sending anything.

### 4. Test interactively in MCP Inspector (optional)
```powershell
npm run inspect
```

---

## Claude Desktop Setup (Windows)

1. Open your Claude Desktop config file:
   - **Standard installer:** `%APPDATA%\Claude\claude_desktop_config.json`
   - **Microsoft Store version:** `%LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming\Claude\claude_desktop_config.json`

2. Add the `skymail` server entry using **absolute paths with escaped backslashes**:

```json
{
  "mcpServers": {
    "skymail": {
      "command": "node",
      "args": [
        "--use-system-ca",
        "--env-file=C:\\Antigravity\\formaggio-mcp-imap\\.env",
        "C:\\Antigravity\\formaggio-mcp-imap\\dist\\index.js"
      ]
    }
  }
}
```

3. **Restart Claude Desktop completely:**
   - Closing the window is not enough — **right-click the Claude icon in the Windows system tray and click Quit**, then reopen Claude Desktop.

### Troubleshooting & Logs
- If the MCP server fails to start or a tool errors in Claude Desktop, check the log file at:
  - `%APPDATA%\Claude\logs\mcp-server-skymail.log`
  - *(Or under `%LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming\Claude\logs\mcp-server-skymail.log` for the Microsoft Store version.)*
- Whenever you change TypeScript files in `src/`, run `npm run build` and restart Claude Desktop.
