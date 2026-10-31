# MCP Servers

Sorvex connects to [Model Context Protocol](https://modelcontextprotocol.io) servers over stdio or streamable HTTP and makes their tools and resources available to the model.

## Quick setup

Add a local stdio server, check the connection, then start Sorvex:

```bash
sorvex mcp add filesystem -- npx -y @modelcontextprotocol/server-filesystem .
sorvex mcp list
sorvex
```

For a remote server:

```bash
sorvex mcp add docs --url https://example.com/mcp --bearer-token-env-var DOCS_TOKEN
sorvex mcp list
```

These commands add user-level servers by default. Add `--local` or `-l` to write the project configuration instead:

```bash
sorvex mcp add -l tools --env API_KEY='${TOOLS_KEY}' -- uvx tools-mcp
```

Use `/mcp` inside an interactive session to inspect connections, sign in, reconnect, change exposure, or enable and disable servers. Run `/reload` after adding, removing, or changing a server outside the session.

## Configure servers

Sorvex reads servers from four files, in this order:

1. `~/.config/mcp/mcp.json`, a user-level file that other MCP clients also read.
2. `~/.sorvex/agent/mcp.json`.
3. `.mcp.json` in the project, the project file Claude Code writes.
4. `.sorvex/mcp.json` in the project.

Project files are read only after [project trust](security.md#understand-project-trust) is granted. A project with a `.mcp.json` asks for trust even when it has nothing else Sorvex gates, because the servers in it run commands on your machine. Without trust, and in print, JSON, and RPC mode when no decision is saved and `defaultProjectTrust` is not `always`, Sorvex starts none of them. `sorvex mcp list` decides the same way.

An entry in a later file replaces an entry with the same name in an earlier file. When a project file replaces a user-level server, Sorvex reports it at session start, in `/mcp`, and in `sorvex mcp list`, since the project's command now runs where yours did. Sorvex never writes `~/.config/mcp/mcp.json` or `.mcp.json`, which other clients and your teammates read.

An entry without `command`, `url`, or `type` overrides only `enabled`, `exposure`, `toolExposure`, and `approve` of the server with the same name from an earlier file and keeps the rest, including `env`, `headers`, and `auth`. `~/.sorvex/agent/mcp.json` can override servers of `~/.config/mcp/mcp.json` this way, and `.sorvex/mcp.json` can override servers of any earlier file. For example, this turns off a user-level server in one project:

```json
{
  "mcpServers": {
    "internal-tools": { "enabled": false }
  }
}
```

The format matches other MCP clients:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
    },
    "docs": {
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer ${DOCS_TOKEN}" },
      "description": "Search and read the product documentation"
    }
  }
}
```

Stdio servers use `command`, `args`, `env`, and `cwd`. Relative `cwd` values resolve against the session directory. A leading `~/` in `command`, an argument, or `cwd` names the home directory.

HTTP servers use `url`, `headers`, and `oauth` (see [Authenticate with OAuth](#authenticate-with-oauth)). The legacy SSE transport is not supported.

Both server types support:

- `timeout`: per-request timeout in seconds (default 60). Progress notifications reset it.
- `lifecycle`: `lazy` (default) connects on the first call that needs the server; `eager` connects when the session starts and stays connected (see [Connect lazily](#connect-lazily)).
- `idleTimeoutMinutes`: minutes without a call before a `lazy` server disconnects (default 10). `0` keeps it connected.
- `enabled: false`: keep the entry without connecting to it.
- `approve`: `never`, `writes`, or `always`; which calls ask first (see [Approve tool calls](#approve-tool-calls)).
- `exposure` and `toolExposure`: control how tools reach the model (see [Control tool exposure](#control-tool-exposure)).
- `description`: what the server offers, in a sentence. It lists the server in the system prompt (see [Control tool exposure](#control-tool-exposure)), tool search ranks the server's tools by it, and codemode's `describeNamespace()` returns it. Without it, the first line of the server instructions is used once the server connects.

Keep personal servers and servers with credentials in the user-level file. Use the project file only for servers the project requires, and only in trusted projects.

### Configuration rules

- Server names may contain only letters, digits, `_`, and `-`, and cannot be `__proto__`, `constructor`, or `prototype`. Tools are named `mcp__<server>__<tool>`, with every character other than letters, digits, and `_` replaced by `_`; tools of a server whose names then collide all get a hash suffix. Server names that differ only in `-` and `_` count as the same server: a second one is rejected, and a `mcp.json` server overrides a registered one.
- `type` is optional. A `command` selects stdio and a `url` selects streamable HTTP. When present, `type` must be `stdio`, `http`, or `streamable-http`.
- `sse` is rejected. Servers that document an SSE endpoint often also provide streamable HTTP, commonly at `/mcp` instead of `/sse`.
- `command` is one executable and `args` contains its arguments. It is not a shell command string.
- `env` and `headers` values can use environment variables such as `${GITHUB_TOKEN}`. They can also run a command with `!command`, but the command must make up the whole value, for example `"Authorization": "!echo Bearer $(gh auth token)"`.
- Invalid entries are reported and skipped without preventing other servers from connecting.

`sorvex mcp add` and `sorvex mcp remove` cover common changes from a shell. See [MCP commands](cli.md#mcp-commands) for their options.

### Inspect or change a server

`/mcp` lists configured servers with their state, tool count, exposure, and configuration source. Servers that need attention appear first. Select a server to inspect its tools and connection details, reconnect, sign in or out, change exposure, or enable and disable it.

Exposure and enabled-state changes are saved to the file that defines the server without replacing unrelated content. For a server from a file other clients read (`~/.config/mcp/mcp.json` or `.mcp.json`), they are saved as an override in Sorvex's own file of the same scope instead: `~/.sorvex/agent/mcp.json` or `.sorvex/mcp.json`. In a trusted project, "Enable in this project" and "Disable in this project" add a project override for a user-level server; later changes to that server are saved to the override. Sorvex writes configuration files through a temporary file, keeps symlinks in place, and makes them readable by you only, since they can hold credentials. Disabled servers remain listed. Outside the interactive TUI, `/mcp` prints server status; `/mcp login <server>`, `/mcp logout <server>`, and `/mcp reconnect <server>` perform those actions directly.

Shell commands work without a session: `sorvex mcp add`, `sorvex mcp remove`, `sorvex mcp list`, `sorvex mcp login`, `sorvex mcp logout`, and `sorvex mcp import`. Shell commands do not load extensions.

### Diagnose connection problems

Run `sorvex mcp list` to connect to every enabled server and print its state, tools, and errors. It exits with status 1 when an entry is invalid or an enabled server is not connected. `/mcp` shows the full connection error and the tail of stderr from a failed stdio server.

Sorvex reports configuration errors, failed connections, and required sign-ins once after startup. A `lazy` server with a cache entry does not connect at startup, so a connection failure or required sign-in shows first as the error of the call that needed it, and in `/mcp`. Server logging notifications are appended to `~/.sorvex/agent/mcp.log` as `<time> [<server>] <level> <logger>: <message>`. The file moves to `mcp.log.1` after it grows past 5 MB.

HTTP network errors and transient statuses (408, 429, and 5xx) are retried twice. A dropped connection is shown as disconnected and reconnects on the next call. When a server announces a changed tool list, new tools are added and withdrawn tools become unreachable.

Stopping a stdio server closes its stdin, sends SIGTERM, then sends SIGKILL to its process group. This also stops servers launched through wrappers such as `npx` or `uvx`.

### Connect lazily

Sorvex saves the tools, instructions, and resource support of every server it connects to in `~/.sorvex/agent/mcp-cache.json`, keyed by server name. The entry also stores a hash of the server's `command`, `args`, `env`, `cwd`, `url`, `headers`, `oauth`, and `auth` as written, plus the project directory for a project server. Changing one of them makes the entry stale. The values of `${VAR}` and `!command` references are not part of the hash. Changing `exposure`, `toolExposure`, `description`, `timeout`, `lifecycle`, `idleTimeoutMinutes`, or `approve` keeps it. Sorvex rewrites the entry each time it lists the server's tools, including when the server announces a changed tool list.

When a session starts, a `lazy` server with a valid entry registers its tools from the entry and starts no process. It connects on the first call to one of its tools, from the model, a codemode script, or the resource tools. A codemode script that names the server (`mcp__<server>`) and a `tool_search` result that loads one of its tools also start the connection, so it is ready by the call. A server whose calls may ask first (`approve` other than `never`) connects only once a call is allowed, so a denied call starts nothing. After `idleTimeoutMinutes` without a call, Sorvex closes the connection and the server shows as idle. The next call connects again, so a stateful server, such as a browser or database session, starts over. Set `"lifecycle": "eager"` to keep it running. Sorvex never connects at startup only because an entry is old. The entry is refreshed the next time the server connects: on a call, at startup for an `eager` server, or with `/mcp reconnect`.

A global server's entry is shared by every project. If a global server's tools depend on the project directory, set `"lifecycle": "eager"`.

A `lazy` server without a valid entry, and every `eager` server, connects in the background when the session starts. The first prompt waits up to 10 seconds only for such servers with `direct` tools, which must be declared in its request. Other servers are waited for when they are needed: a codemode script waits for the servers it names (`mcp__<server>`) and, when it calls `searchTools()` or reads `ALL_TOOLS`, for all of them; `tool_search` and the resource tools also wait for all of them. A server's tools appear once it connects; the `codemode` description does not list them, so it does not change when servers connect.

`/mcp` shows each server as `idle`, `connecting`, `connected`, `failed`, `disconnected`, `needs sign-in`, or `disabled`. Select an idle server and "Connect" to connect it now.

## Migrate configuration from another client

`sorvex mcp import --from <client>` copies the servers of Claude Code, Claude Desktop, Cursor, or VS Code into `~/.sorvex/agent/mcp.json`. It reads the client's user-level file:

| Client | `--from` | macOS | Linux | Windows |
|---|---|---|---|---|
| Claude Code | `claude-code` | `~/.claude.json` | `~/.claude.json` | `%USERPROFILE%\.claude.json` |
| Claude Desktop | `claude-desktop` | `~/Library/Application Support/Claude/claude_desktop_config.json` | `~/.config/Claude/claude_desktop_config.json` | `%APPDATA%\Claude\claude_desktop_config.json` |
| Cursor | `cursor` | `~/.cursor/mcp.json` | `~/.cursor/mcp.json` | `%USERPROFILE%\.cursor\mcp.json` |
| VS Code | `vscode` | `~/Library/Application Support/Code/User/mcp.json` | `~/.config/Code/User/mcp.json` | `%APPDATA%\Code\User\mcp.json` |

The command keeps `command`, `args`, `env`, `cwd`, `url`, and `headers` of each entry, under `mcpServers` or, for VS Code, `servers`. An entry with `"disabled": true` is imported with `"enabled": false`. It prints the servers it added. It never replaces a server `mcp.json` already defines, so running it again adds only new servers. Run `sorvex mcp list` to check the result.

Sorvex reads `env` and `headers` values differently from these clients, so the command rewrites them to keep their meaning. `${env:NAME}` becomes `${NAME}`. Any other `$` becomes `$$`, since Sorvex would otherwise expand `$HOME` or `$5`, and a leading `!` becomes `$!`, since Sorvex would otherwise run the value as a command. Sorvex cannot expand other placeholders, such as `${workspaceFolder}` or `${NAME:-default}`, and does not expand `${...}` in `command`, `args`, `cwd`, or `url`. It skips a server that uses one and says why, along with SSE servers and VS Code servers with `${input:...}` prompts. When a server has an `envFile`, the command imports the server without it and prints a note, because Sorvex does not read env files. Set the variables the file defined in `env`.

Claude Code's project servers in `.mcp.json` need no import: Sorvex reads that file in trusted projects.

For other clients, move the converted entry under `mcpServers` in `mcp.json`, then run `sorvex mcp list` to validate it.

| Client | Conversion |
|---|---|
| Codex | Convert `[mcp_servers.<name>]` TOML fields such as `command`, `args`, `env`, and `url` to JSON. |
| OpenCode | Convert `"type": "local"` to a stdio entry, split its `command` array into `command` and `args`, rename `environment` to `env`, and replace `{env:NAME}` with `${NAME}`. Convert `"type": "remote"` to a URL entry. |

## Authenticate with OAuth

Remote servers that use OAuth, such as Sentry, need no credentials in `mcp.json`:

```json
{
  "mcpServers": {
    "sentry": { "url": "https://mcp.sentry.dev/mcp" }
  }
}
```

When the server rejects an unauthenticated connection, `/mcp` shows that it needs sign-in. Select "Sign in", run `/mcp login sentry`, or run `sorvex mcp login sentry`. Sorvex opens the authorization page and waits for approval. If the browser runs on another machine, such as over SSH, paste its redirected URL into the sign-in screen. A running session uses the new credentials on its next turn.

Sorvex registers itself with the authorization server, stores tokens in `~/.sorvex/agent/mcp-auth.json`, and refreshes access tokens when they expire or the server rejects them. If a server later requests additional scope, Sorvex asks for sign-in again. Signing out deletes the stored credentials.

Credentials belong to a server name and URL. Servers with the same URL under different names, such as one per account, sign in separately; servers with the same name and URL in different `mcp.json` files share one sign-in.

OAuth applies to HTTP servers without an `Authorization` header. For a server that does not support dynamic client registration, configure a registered client:

```json
{
  "mcpServers": {
    "example": {
      "url": "https://mcp.example.com/mcp",
      "oauth": { "clientId": "my-client", "clientSecret": "${EXAMPLE_SECRET}", "callbackPort": 8765 }
    }
  }
}
```

The redirect URI must match the registered URI. `callbackPort` uses `http://127.0.0.1:<port>/callback`. To use another URI, set `callbackUrl`; it must use HTTP on `localhost`, `127.0.0.1`, or `[::1]`. Sorvex sends it exactly as written. When `callbackUrl` omits a port, Sorvex uses `callbackPort` or a free port and adds it to the URI, as allowed for loopback redirects by RFC 8252. `clientSecret` is optional and can use an environment variable or command.

Set `scope` to a space-separated list for servers that do not advertise their required scopes. Otherwise, Sorvex requests the advertised scopes. Later scope requests are added to the configured value.

Sorvex registers as `sorvex`. Some servers only accept registrations from known clients. Set `clientName` to send another name:

```json
{
  "mcpServers": {
    "figma": { "url": "https://mcp.figma.com/mcp", "oauth": { "clientName": "Claude Code" } }
  }
}
```

The name is only sent when Sorvex registers a client. To register again under a new name, sign out first.

Some authorization servers allow clients by their Client ID Metadata Document URL instead of registering them. Set `clientRegistration` to `cimd` to identify as Sorvex's document on pi.dev instead of registering:

```json
{
  "mcpServers": {
    "example": { "url": "https://mcp.example.com/mcp", "oauth": { "clientRegistration": "cimd" } }
  }
}
```

The client ID is `https://pi.dev/oauth/client.json` with the redirect URI `http://127.0.0.1:<port>/callback`. If the authorization server does not send the `iss` parameter in authorization responses (RFC 9207), Sorvex uses a document and redirect path specific to the MCP server instead: `https://pi.dev/oauth/<id>/client.json` with `http://127.0.0.1:<port>/callback/<id>`. The authorization server must advertise Client ID Metadata Document support and public clients, or sign-in fails. `cimd` cannot be combined with `clientId` or `clientName`, and a `callbackUrl` must use `localhost` or `127.0.0.1` with the path `/callback`.

Sorvex finds the authorization server through the server's protected resource metadata (RFC 9728) and checks that the authorization server's metadata names the expected issuer (RFC 8414). Some servers advertise the wrong authorization server or none, so sign-in opens a page that does not exist. Set `authServerMetadataUrl` to the metadata document of the right authorization server:

```json
{
  "mcpServers": {
    "example": {
      "url": "https://mcp.example.com/mcp",
      "oauth": { "authServerMetadataUrl": "https://example.okta.com/.well-known/openid-configuration" }
    }
  }
}
```

Sorvex uses that document instead of discovery and trusts it as configured, so only point it at a document you trust. The URL must use HTTPS, except on `localhost`, `127.0.0.1`, or `[::1]`.

## Control tool exposure

Each server tool is registered as `mcp__<server>__<tool>`. The server's `exposure` determines how the model reaches it:

| Exposure | Behavior | Typical use |
|---|---|---|
| `codemode` (default) | Callable from [`codemode`](cli.md#tools) scripts, but neither declared to the model nor listed in the codemode description. Scripts find tools with `searchTools()`, `describeTool()`, or `ALL_TOOLS`. | General MCP servers, especially when scripts should combine or filter calls. |
| `deferred` | Not declared until [`tool_search`](cli.md#tools) loads a match for the next model call. | Large servers whose tools should be called directly after discovery. |
| `direct` | Declared to the model like a built-in tool and also callable from codemode. | Small, frequently used tool sets. |
| `hidden` | Registered but unreachable. | Servers or tools that should remain unavailable. |

`codemode-deferred` is accepted as an alias for `codemode`.

Servers with `codemode` or `deferred` tools are listed in the `mcp_servers` section of the system prompt, with how their tools are reached and one line from the configured `description` or, once connected, from the server instructions. Sorvex updates the section when a prompt starts, after waiting for servers with `direct` tools. When it changed, for example because a server connected and its summary became available, Sorvex appends the new section to the conversation instead of changing tool declarations, so earlier messages stay cached. `describeNamespace()` and the `namespace` option of `searchTools()` accept `mcp__dev-radius`, `mcp__dev_radius`, `dev-radius`, or `dev_radius`.

Sorvex activates `codemode` when a server with `codemode` exposure connects. It activates `tool_search` for a server with `deferred` exposure. To make the model see a tool without searching, give it `direct` exposure with `toolExposure`.

`toolExposure` overrides the server exposure for individual tools. Keys are exact server tool names or patterns where `*` matches any characters. Exact names win over patterns; among patterns, the first match wins. A server with `hidden` exposure can expose only selected tools:

```json
{
  "mcpServers": {
    "github": {
      "url": "https://api.githubcopilot.com/mcp/",
      "exposure": "deferred",
      "toolExposure": {
        "search_code": "direct",
        "get_*": "codemode",
        "delete_*": "hidden"
      }
    }
  }
}
```

`sorvex mcp list` marks tools whose exposure differs from their server. The Tools view in `/mcp` also shows the effective exposure.

Tools with `codemode` or `deferred` exposure can be reached through either indirect mechanism: codemode scripts can call them, and `tool_search` can load them. Codemode calls do not depend on the active tool set, so they remain available after `/tree`, resume, and fork. Tools loaded by `tool_search` are recorded in the transcript and remain declared on that branch.

`--tools` does not remove MCP tools unless one of its entries starts with `mcp__`; `sorvex --tools read,codemode,'mcp__radius__*'` keeps only the tools of `radius`. `--exclude-tools` accepts the same patterns, and `--no-mcp` disables MCP for one run (see [Tools](cli.md#mcp-tools)).

To keep `codemode` active without MCP servers, add `"defaultTools": ["+codemode"]` to [settings](settings.md#tools). To prevent automatic codemode activation, set `"autoEnableCodemode": false` beside `mcpServers`. A project value overrides the user-level value. Sorvex warns once when neither `codemode` nor `tool_search` is active and non-direct tools cannot be called.

Text results over 20 KB reach the model with their middle removed around a `…N chars truncated…` marker. The full text is saved to a temporary file named in the result. Codemode scripts receive the complete result and can reduce it before returning output to the model.

Codemode scripts receive the complete MCP `CallToolResult`, including `content`, `structuredContent`, and `isError`. A result with `isError` resolves inside scripts but is reported as an error for direct calls. `image(result.content[0])` forwards an image block. Server instructions are not part of any tool description; scripts read them with `describeNamespace("mcp__<server>")`, which also returns the server's tool names.

## Use resources

When a connected server offers [resources](https://modelcontextprotocol.io/specification/2025-11-25/server/resources), Sorvex adds the resource tools used by Codex and OpenCode:

- `list_mcp_resources` lists resources as JSON: `{ server?, resources: [{ server, uri, name, ... }], nextCursor? }`. With `server`, it lists one page; `cursor` continues with the next page. Without `server`, it lists every resource from every server.
- `list_mcp_resource_templates` lists URI templates for resources the servers do not list directly.
- `read_mcp_resource` reads a resource by `server` and `uri`. Text reaches the model as text and images as images. Other binary resources are saved to temporary files, and the model receives the path. Scripts receive `{ server, uri, contents }`.

These tools reach every enabled, non-hidden server with resources. Their exposure is the widest exposure among those servers: `direct`, then `codemode` or `deferred`. Resource links in tool results identify `read_mcp_resource` and the server.

Resources for MCP Apps, identified by `ui://` URIs or `text/html;profile=mcp-app`, are omitted because Sorvex does not render them. Resource icons are also omitted.

Reading and listing resources is retried once after a transient HTTP error (408, 429, or 5xx). Tool calls are not retried because the server may already have performed them.

## Run prompts

Each [prompt](https://modelcontextprotocol.io/specification/2025-11-25/server/prompts) a server offers becomes the slash command `/mcp__<server>__<prompt>`, named like the server's tools. Type `/mcp__` to list them. Pass arguments as `key=value` pairs and quote values with spaces:

```
/mcp__github__review_pr number=42 focus="error handling"
```

Sorvex asks for each missing required argument. The messages the server returns are sent as your next message; when they are more than one message or include assistant messages, each is labelled with its role. Text beyond 100,000 characters, and images beyond 10 or 20 MB in total, are left out with a note in the message.

In print and JSON modes the command's message is the run's prompt: `sorvex -p "/mcp__github__review_pr number=42"` prints the answer to it, and `--mode json` streams its events. These modes cannot ask, so a command that cannot run (a missing argument, a server that needs approval to start, a failing server, no model or credentials, or an `input` handler that consumes the message) prints `Extension error (command:<name>): <reason>` to stderr and the process exits with code 1.

A lazy server's prompts are cached with its tools, so its commands exist before it connects. Running one connects the server. A prompt command follows the same trust and `enabled` rules as the server's tools: a project server that is not trusted never connects, so it offers no commands, and a command of a server you disable reports that the prompt is gone.

A prompt is not a tool call, so `approve` does not ask before the prompt itself runs: you chose to run the command, and the server only returns text. It does decide whether the command may start the server. A server whose calls ask first (`approve` other than `never`, unless you always allow it) stays idle until a call is allowed, and a prompt command keeps that promise. When such a server is not connected (idle, disconnected, or failed), the command asks "Allow once", "Allow for this session", "Always allow this server", or "Deny" before it connects, and a denied command starts nothing. "Allow for this session" covers that prompt of that server until its definition changes. In print and JSON modes nothing can ask, so the command fails and names the server's `approve` setting. A server that is already running, or whose calls never ask, runs its prompts without asking. The text a prompt returns is sent as your own message, so read prompts from servers you do not control as you would any pasted text. When a server reports that its prompts changed, new commands appear without a restart. A server whose prompts cannot be listed still serves its tools, and `/mcp` shows the error. A command whose prompt the server no longer offers stays registered until the next reload but reports that the prompt is gone.

## Answer server questions

A server can ask you for input while it handles a call ([elicitation](https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation)). Sorvex shows one dialog per field: a text input for text, numbers, and multiple choices (comma-separated), and a selection for yes/no and single choices. A selection lists the default first and marks it; a text input names its default, or its choices, and an empty input takes the default. Optional fields can be skipped. A field whose name looks like a secret (a password, token, or API key) carries a warning that the server receives what you enter. Sorvex then shows your answers and asks whether to accept, which sends them, or decline. Dismissing any dialog cancels the request, and so does aborting the turn the request arrived in. Requests are answered one at a time.

Each dialog starts with a line naming the server that asks. Everything the server wrote follows on indented lines that keep their indent when they wrap, with escape sequences (including the payload of terminal control strings) and control characters removed and long text shortened (the message to 500 characters, field names and options to 100, descriptions to 300), so a server cannot restyle the dialog or pose as another server. A form may have at most 50 fields and each choice at most 200 options; Sorvex rejects larger forms, unknown string formats, and the field names `__proto__`, `constructor`, and `prototype` as invalid.

In print and JSON modes Sorvex declines every request. Sorvex supports form requests only, not requests to open a URL. Only servers that Sorvex connected can ask, so an untrusted project server never does. While you answer, the server's pending calls do not time out. A request the server cancels gets no answer.

## Approve tool calls

A server's `approve` setting decides which calls to its tools ask you first:

| `approve` | Asks before |
|---|---|
| `never` | No call. The default. |
| `writes` | Calls to tools the server does not mark with `readOnlyHint`. |
| `always` | Every call. |

A server decides for itself which of its tools carry `readOnlyHint`. A server you do not trust can mark a destructive tool read-only, so `writes` limits mistakes by honest servers but is no protection against a hostile one. Use `always` for those.

Project files can make `approve` stricter than your own setting but never looser. A server from `.mcp.json` asks at least as `writes`, even when the file says `never`. This floor applies only to servers that `.mcp.json` defines: a server that `.sorvex/mcp.json` defines in full uses the `approve` it sets, since that file is also part of the repository and you trusted the project. When `.mcp.json` or `.sorvex/mcp.json` redefines a server you configured yourself, the stricter of the two settings applies, and so for an override in `.sorvex/mcp.json`. Only your own files, `~/.config/mcp/mcp.json` and `~/.sorvex/agent/mcp.json`, can loosen it.

`approve` applies to the server's own tools. The resource tools `list_mcp_resources`, `list_mcp_resource_templates`, and `read_mcp_resource` never ask, whatever `approve` says, since they only list and read resources.

The prompt shows the tool and its arguments and offers four choices:

- "Allow once" runs this call. The next call asks again.
- "Allow for this session" runs this call and later calls to the same tool in the session, also after a resume. The choice is recorded on the current branch of the session with a hash of the server's definition: it does not apply after you navigate to a point before it with `/tree`, or after the server's `command`, `args`, `env`, `cwd`, `url`, `headers`, `oauth`, or `auth` changed.
- "Always allow this server" saves your choice in `~/.sorvex/agent/mcp-approvals.json`, keyed by project directory and server name, so no call to that server asks again in that project. The entry also stores a hash of the server's definition (the one used for the [cache](#connect-lazily)). Changing its `command`, `args`, `env`, `cwd`, `url`, `headers`, `oauth`, or `auth` revokes the choice, and the next call asks again. No config file changes, so a teammate who pulls your repository is not affected. Sessions running at the same time update the file under a lock. When the file cannot be read, for example after a manual edit broke it or a newer version wrote it, Sorvex reports it at session start, asks for every gated call, and leaves the file as it is; saving "Always allow this server" then fails with an error.
- "Deny" blocks the call. The model receives an error that says you denied it.

Calls from codemode scripts ask the same way. A call asks before its server connects, so a denied call never reaches the server. Prompts appear one at a time. In print and JSON modes nothing can ask, so a call that would ask fails with a message that names the server's `approve` setting. For a server defined by one of your own files, the message tells you to set `"approve": "never"` there. For a project server, it tells you to choose "Always allow this server" in an interactive session, since a project file cannot lower `approve`.

## Permissions

Every MCP call passes through Sorvex's tool pipeline. Extension `tool_call` and `tool_result` handlers, including permission gates, therefore apply to MCP tools. Calls made from codemode scripts carry the codemode call ID as `parentToolCallId`.

`pi.getAllTools()` reports the annotations declared by each server: `readOnlyHint`, `destructiveHint`, `idempotentHint`, and `openWorldHint`. Permission extensions can use these hints to decide which calls require confirmation (see [Tool exposure](extensions.md#tool-exposure)). Resource tools are marked read-only.

## Extensions and SDK

### Add servers from extensions

Extensions can add servers for the current session with `pi.registerMcpServer(name, config)`, using the same shape as an `mcpServers` entry (see [MCP servers in extensions](extensions.md#mcp-servers)). Registered servers connect like configured servers and appear in `/mcp` with the extension as their source.

Changes to enabled state or exposure apply only to the current session. A file-configured server with the same name takes precedence, and `/mcp` lists the overridden registration. `sorvex mcp` shell commands do not load extensions and only see file-configured servers.

### Replace the built-in MCP support

An installed extension that registers `/mcp`, such as `pi-mcp-adapter`, replaces the built-in MCP support for sessions. Sorvex then does not read `mcp.json` or connect its servers in a session, and `/mcp` belongs to the extension. Remove the extension to restore the built-in behavior. To disable built-in MCP support without a replacement, disable `mcp` under Built-in in `sorvex config`, or set `"extensions": ["-builtin:mcp"]` in [settings](settings.md#resources). `--no-mcp` disables it for one run.

An extension that registers `codemode` or `tool_search` similarly replaces the built-in tool with that name. Sorvex activates the replacement for MCP servers and waits for the servers its calls need only when it declares [`reachesTools`](extensions.md#tool-exposure). Shell-level `sorvex mcp` commands always use the built-in implementation.

### Use MCP from the SDK

SDK sessions do not load built-in extensions. Add the MCP extension, the codemode extension for `codemode` servers, and the tool-search extension for `deferred` servers to the resource loader. See [Codemode and MCP](sdk.md#codemode-mcp).
