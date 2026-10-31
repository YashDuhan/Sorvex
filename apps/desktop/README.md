# Sorvex Desktop (experimental)

A desktop GUI for Sorvex, built from three parts:

- a thin Tauri shell (`src-tauri`, about 100 lines of Rust),
- a Node server that does the work (`server/`),
- a React UI (`src/`).

```
Tauri window ──HTTP + SSE──▶ Node server (127.0.0.1:4517) ──JSONL──▶ sorvex --mode rpc
                                 │                                    └─ extension/gui-bridge.ts
                                 ├─ credentials (Sorvex's ModelRuntime → ~/.sorvex/agent/auth.json)
                                 ├─ speech-to-text / text-to-speech, guardrail reviews
                                 └─ Kokoro TTS child process (optional install)
```

The Tauri shell starts the server, unless one is already running on the port, and opens the window:

- **Development:** the window loads the Vite dev server, which proxies `/api` to the Node server.
- **Release:** the window navigates to the Node server, which also serves the built UI.

The Rust side also grants microphone access to the webview.

## Run

Requirements:

- Rust 1.90+ and Node 22.19+
- the Tauri Linux libraries (`webkit2gtk-4.1`, `gtk3`)
- from the repository root, run `npm install --ignore-scripts`, then `npm run hydrate:model-data`

```bash
cd apps/desktop
npm run desktop:dev
```

To work on the UI in a browser instead, run `npm run server:watch` and `npm run dev` in two terminals, then open http://localhost:1420.

`npm run check` typechecks the UI, the server and the extension.

## Features

**Chat**
- Streaming text, collapsible reasoning, and tool calls with status, arguments, results and nested subagent calls.
- Session list for the working folder.
- Model, thinking-level and mode (build / plan / security) pickers.
- Slash-command suggestions; while the agent runs, Enter steers it and Esc stops it.
- Message actions:
  - **Assistant replies:** copy, read aloud, and a stats tooltip.
  - **Your messages:** edit and retry, which branch the session at that message.

**Providers (no `/login` needed)**
- Add API keys, or sign in with a subscription through browser OAuth or a device code.
- These run Sorvex's own login flows and save to `~/.sorvex/agent/auth.json`, so the CLI uses the same credentials.

**Guardrails**
- **Tool permissions:** set each tool to Ask, Allow or Deny.
  - "Ask" shows an inline Allow once / Allow always / Deny box above the composer.
  - Defaults: read-only tools are allowed; `bash`, `edit`, `write` and unknown tools ask.
- **Safety rules:** regular expressions over bash commands and file paths that either ask or block.
  - They are checked before tool permissions, so they also stop allowed tools.
  - The defaults cover deleting the root or home directory, raw disk writes, `sudo`, piping a download into a shell, force-push, discarding git changes, `chmod 777`, `.env` files, `.git/`, and `~/.ssh`, `~/.aws` and `~/.gnupg` (through file tools and through the shell).
- **LLM reviewers**:
  - After each turn, a second model reviews it and lists violations and warnings under the reply.
  - Issues can be added to annotations.
  - Reviews are advisory and do not block anything.

**Voice**
- **Dictation:** the mic button records, transcribes, and inserts the text into the composer.
- **Hands-free voice chat:** an energy-based voice detector decides when you start and stop talking.
  - Talking over the agent stops its speech and the current run.
  - Replies can be read aloud automatically.
- **Speech-to-text:** Gemini (default), or any OpenAI-compatible `/audio/transcriptions` endpoint (OpenAI, Groq, or a local whisper.cpp server).
- **Text-to-speech:** Kokoro-82M locally, or any OpenAI-compatible `/audio/speech` endpoint.
  - Kokoro installs on demand from Settings → Voice into `~/.sorvex/agent/desktop/kokoro`, about 250MB plus a model of about 90MB.
- **Visuals:** a mic level meter while recording, and a flame waveform above the composer while replies are spoken.

**Right sidebar** (toggle with the panel button in the header, or collapse with the chevron)
- Search, Guardrails, Todos (from Sorvex's `todo` tool), Modes, Prompts (saved prompts plus Sorvex templates and skills), Agents (subagent runs), Permissions and Config.

**Attachments**
- Paperclip, drag-and-drop, or paste.
- Images go to the model as images, if the model accepts them.
- PDFs are converted to text with poppler's `pdftotext`; text and code files are inlined.

**Browser**
- A shared Chromium tab, like the built-in browsers in Claude Code and Cursor.
  - Open it with the globe button in the chat header. It also opens by itself when the AI starts browsing.
  - The pane streams the live tab, and you can click, scroll, type and use the address bar yourself.
- AI tools:
  - **Pages:** `browser_navigate`, `browser_back`, `browser_scroll`, `browser_wait`.
  - **Reading:** `browser_snapshot` (numbered interactive elements), `browser_read` (page text), `browser_screenshot` (image), `browser_console`.
  - **Acting:** `browser_click` and `browser_type` (by element number), `browser_press`.
- The browser uses its own profile in `~/.sorvex/agent/desktop/browser`, never your personal one. Downloads are off.
- Browser guardrails:
  - **Always blocked:** typing into password, payment and one-time-code fields, and non-http(s) URLs.
  - **Approval:** form submits ask first by default; new domains can be set to ask too.
  - **Domain lists:** blocked and allowed domains.
  - **Activity log:** every AI browser action.
- Page text and console output pass through the same secret masking as every other tool.

**SSH**
- Add servers on the SSH page with a password, a private key (plus passphrase) or your ssh-agent.
- The AI gets two tools: `ssh_hosts` and `ssh_exec`. It only ever sees server aliases.
- Each server has a policy:
  - **Read-only:** only inspection commands run.
  - **Ask:** you approve every command.
  - **Auto:** commands run, except that risky ones ask and dangerous ones are blocked.
- SSH guardrails are separate from the local ones:
  - **Always block:** wiping disks, `rm -rf` on system paths, shutdown and reboot, breaking SSH access, the firewall, user accounts, fork bombs, and pipe-to-shell.
  - **Always ask:** `sudo`, package installs, services, deleting files, containers and VMs, killing processes, writing to `/etc`, and `git push`.
- An Activity tab logs every remote command, including blocked ones.
- Credentials are stored in `~/.sorvex/agent/desktop/ssh` (directory 0700, files 0600). They are never returned to the UI or the model.
- Remote commands need a per-launch token, which the server hands to the bridge extension in memory, so a `curl` from the AI's local shell can't run them.

**MCP**
- Add, enable, disable, reconnect, sign in to, and delete MCP servers.
- Edit the raw `~/.sorvex/agent/mcp.json`.
- Set Ask / Allow / Deny on each server's tools.
- It uses Sorvex's own MCP config code and `sorvex mcp list`, and the agent reloads after each change.

**Annotations**
- Select text in a reply and comment on it.
- Annotations are prepended to your next message.

**Composer**
- **Top row:** mode tabs and the guardrail badge.
- **Bottom left:** attach, an Effort pill (thinking level) and a Tools pill (per-tool permissions).
- **Bottom right:** dictation, voice chat, the voice menu, the model select, and send.
- **Below:** a context bar showing tokens used against the context window.
- **Border:** sweeps in the mode colour while the agent runs, pulses red while dictating, and turns green in voice chat.

## Files

| Path | Role |
| --- | --- |
| `src-tauri/src/main.rs` | Starts the server, opens the window, grants microphone access. |
| `server/index.ts` | HTTP routes and the event stream (SSE). Accepts loopback Host headers only, and requires an `x-sorvex-desktop` header on mutating requests, so other websites cannot drive the agent. |
| `server/agent.ts` | The `sorvex --mode rpc` child process. |
| `server/credentials.ts` | Providers, logins, keys and reviewer completions through `ModelRuntime`. |
| `server/voice.ts`, `server/kokoro.ts` | Speech endpoints and the local Kokoro process. |
| `server/mcp.ts` | MCP server list, add, remove and enable, using Sorvex's MCP config functions. |
| `server/settings.ts` | `~/.sorvex/agent/desktop/settings.json` and its defaults. |
| `extension/gui-bridge.ts` | Loaded into Sorvex with `--extension`. Applies permissions and safety rules, sends approvals, and refreshes models after credential changes. |
