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
  - The model picker has a provider rail (favorites first), search across every provider, a star to pin models to favorites, and Ctrl+1 to Ctrl+9 (Cmd on macOS) for the first nine rows.
- After a turn that edited or wrote files, a card under the reply lists the changed files as a folder tree with added and removed lines; it opens the file, or the Changes pane with **Open diff**.
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

**Remote access**
- Drive Sorvex from a phone through the Sorvex-Browser relay (github.com/YashDuhan/Sorvex-Browser).
- Set it up in Settings → Remote access: a toggle, the relay URL, and **Confirm new phones** (on by default).
- The server dials out to the relay, so no inbound port is opened.
- **Pairing:** **Pair a phone** shows a one-time code and its QR code.
  - A code pairs exactly one phone and is used up by the first phone that proves it holds it.
  - A code changes every minute; the window closes after 5 minutes.
  - With confirmation on, you click Allow or Deny for the phone that scanned it.
- **Device keys:** each paired phone gets its own device key.
  - **Remove** revokes that key.
  - A phone unused for 30 days is removed automatically.
  - Keys and the host's room id are in `~/.sorvex/agent/desktop/remote.json` (mode 0600). Codes are never stored.
- **Encryption:** every connection runs an ephemeral X25519 exchange authenticated by the code or the device key, then AES-256-GCM. The relay sees only room ids and ciphertext.
- **What phones can call:** only the chat, session and approval routes (allowlist in `server/remote.ts`). Credentials, SSH, MCP, the browser and settings writes stay local.
- **Open dialogs and approvals** are tracked on the server:
  - a window or phone that connects mid-run still sees them;
  - answering in one place closes them everywhere.

**Device (Android emulators)**
- Open it with the phone button in the chat header. It also opens by itself when the AI starts using a device tool.
- Setup: finds the Android SDK (`ANDROID_HOME`, `ANDROID_SDK_ROOT`, or the Android Studio default). When parts are missing, it installs them after you accept the Android SDK License Agreement in the pane: a Temurin 21 JDK if there is no Java 17+, the SDK command-line tools, platform-tools, the emulator, the newest Google APIs system image, and a `Sorvex_Pixel` virtual device. A fresh install is about 2 GB.
- On first use it installs [Expo Device Hub](https://github.com/expo/expo-device-hub) (`expo-device-hub`, pinned, lifecycle scripts off) into `~/.sorvex/agent/desktop/tools` and runs it on 127.0.0.1 with a session token.
- With no emulator running, the pane lists the virtual devices on this machine with Start and Stop. The **+** button starts one, or creates a new one from an installed system image and device profile, and can download the newest Google APIs image (about 1.5 GB) after you accept the license.
- With one running, the pane shows its live screen (the hub's H.264 stream, decoded with WebCodecs; screenshots four times a second where WebCodecs is missing). Click and drag to touch, scroll to swipe, and type or paste when the screen is focused; Escape is Back.
  - **Above the screen:** the foreground app with CPU, memory and network graphs.
  - **Beside it:** Home, Back, Recent apps, Rotate, dark or light theme, text size, device settings (on-screen keyboard, bold text, high-contrast text, animations, Wi-Fi and mobile data), screenshot, volume, power and shut down, a 3D view, the device frame, and fill the window.
  - **Annotate** (the pen on the rail toggles the bar under the phone), the same tools as the Browser pane:
    - **Select element:** hover to highlight what is under the pointer; click to attach it to your next message with its class, text, content description, resource id, bounds, app package, nearby text and a cropped screenshot. It comes from the screen's accessibility tree.
    - **Draw:** pen, rectangle, ellipse and arrow in several colors and widths, with undo and redo, on a frozen copy of the screen; **Add to chat** attaches it as an image.
    - While a tool is active the phone shows flat, so picks and strokes line up with the screen; it returns to 3D afterwards.
  - **3D view:** t3code's WebGL phone (three.js, ported into `src/device3d` under its MIT license) with the live screen as its display. Drag the screen to touch it; drag around the phone or scroll with two fingers to spin it, with momentum, and it settles back toward the front. Double-click beside the phone to face it again.
- AI tools, over `adb`:
  - **Devices:** `device_list`, `device_boot`.
  - **Reading:** `device_ui` (numbered elements with their centers), `device_screenshot`, `device_apps`, `device_logcat`, and `device_wait` (until some text appears, until the screen has labelled elements again, or a plain pause).
  - **Acting:** `device_tap` and `device_type` (by element number or coordinates), `device_swipe`, `device_key`, `device_launch`, `device_open_url`, `device_install` (APK).

**Skills**
- **Installed:** the skills the agent loaded for this folder, with their SKILL.md; skills in the user or project skills folder can be removed.
- **Registry:** the Hermes skills index (Hermes, Anthropic, OpenAI, HuggingFace, NVIDIA, GitHub collections, skills.sh, ClawHub). Installing downloads the entry's SKILL.md into `~/.sorvex/agent/skills/<name>/`, or the project's `.sorvex/skills/`.

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
- **Border:** a hairline tinted by plan or security mode; while the agent runs, a short segment travels along its top edge. It pulses red while dictating and turns green in voice chat.

## Files

| Path | Role |
| --- | --- |
| `src-tauri/src/main.rs` | Starts the server, opens the window, grants microphone access. |
| `server/index.ts` | HTTP routes and the event stream (SSE). Accepts loopback Host headers only, and requires an `x-sorvex-desktop` header on mutating requests, so other websites cannot drive the agent. |
| `server/agent.ts` | The `sorvex --mode rpc` child process. |
| `server/credentials.ts` | Providers, logins, keys and reviewer completions through `ModelRuntime`. |
| `server/voice.ts`, `server/kokoro.ts` | Speech endpoints and the local Kokoro process. |
| `server/mcp.ts` | MCP server list, add, remove and enable, using Sorvex's MCP config functions. |
| `server/devices.ts` | Android SDK detection and setup, emulators (list, create, start, stop, rotate), the Expo Device Hub process with its API and metrics relay, and the `device_*` tool actions over adb. |
| `server/skills.ts` | Installed skills, and the skill registry index, search and install. |
| `server/settings.ts` | `~/.sorvex/agent/desktop/settings.json` and its defaults. |
| `server/remote.ts`, `server/remote-crypto.ts` | Remote access: relay connection, one-time pairing codes, per-phone device keys, end-to-end encryption, and the route allowlist for phones. |
| `extension/gui-bridge.ts` | Loaded into Sorvex with `--extension`. Applies permissions and safety rules, sends approvals, and refreshes models after credential changes. |
