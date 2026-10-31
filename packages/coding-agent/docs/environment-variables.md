# Environment Variables

Sorvex uses environment variables in three ways:

- Variables such as `SORVEX_OFFLINE` configure the Sorvex process.
- Sorvex sets process markers so child processes can identify Sorvex as the launching agent.
- Commands run by the LLM-callable shell tools receive `SORVEX_*` variables describing the current session.

Provider API-key variables are documented separately in [Providers](providers.md#use-an-api-key-from-the-environment).

## Process Marker

The CLI and RPC entry points set two process markers:

- `AI_AGENT=sorvex` is a generic marker that lets tooling identify Sorvex as the agent that launched the process.
- `SORVEX_CODING_AGENT=true` is Pi-specific and lets child processes detect that they run inside Sorvex.

Child processes inherit both markers. They are not session-specific and are not set automatically when Sorvex is embedded through the SDK.

## Shell Tool Session Environment

Commands run by the `bash` and `powershell` tools receive the current Sorvex session state:

| Variable | Description |
|----------|-------------|
| `SORVEX_SESSION_ID` | Current session ID |
| `SORVEX_SESSION_FILE` | Absolute path to the current session JSONL file; unset for ephemeral sessions |
| `SORVEX_PROVIDER` | Currently selected model provider |
| `SORVEX_MODEL` | Currently selected model ID |
| `SORVEX_REASONING_LEVEL` | Current effective reasoning level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max` |

The values are resolved when each command starts. Switching models or changing the reasoning level therefore affects the next shell command without restarting Sorvex. `SORVEX_PROVIDER` and `SORVEX_MODEL` identify the selected Sorvex model, not a different upstream model that a router may choose internally.

When asked which model or provider is running, inspect these variables instead of inferring the answer from the system prompt:

```bash
printf '%s/%s\n' "$SORVEX_PROVIDER" "$SORVEX_MODEL"
printf 'reasoning=%s session=%s\n' "$SORVEX_REASONING_LEVEL" "$SORVEX_SESSION_ID"
```

The session file can be inspected directly when the session is persistent:

```bash
if [ -n "$SORVEX_SESSION_FILE" ]; then
  tail -n 1 "$SORVEX_SESSION_FILE"
fi
```

These variables are injected into the LLM-callable `bash` and `powershell` tools. They are not injected into user-entered `!` or `!!` commands.

### Custom Shell Tools

Tools created with `createBashTool()` or `createPowerShellTool()` expose the session environment by default when registered with Sorvex. Injection happens before `spawnHook`, so a hook receives the variables in `ctx.env`:

```typescript
const bashTool = createBashTool(cwd, {
  spawnHook: (ctx) => ({
    ...ctx,
    env: { ...ctx.env, CI: "1" },
  }),
});
```

Disable session metadata independently of the spawn hook:

```typescript
const powershellTool = createPowerShellTool(cwd, {
  exposeSessionEnvironment: false,
  spawnHook: (ctx) => ctx,
});
```

When disabled, Sorvex removes inherited values for these variables so nested Sorvex processes do not expose stale parent-session metadata.

## Sorvex Process Configuration

These variables are read by Sorvex itself:

| Variable | Description |
|----------|-------------|
| `SORVEX_CODING_AGENT_DIR` | Override the config directory; default is `~/.sorvex/agent` |
| `SORVEX_CODING_AGENT_SESSION_DIR` | Override session storage; overridden by `--session-dir` |
| `SORVEX_PACKAGE_DIR` | Override the package directory, useful for Nix/Guix store paths |
| `SORVEX_OFFLINE` | Disable automatic network activity, including model catalog refreshes, the version check, the install report, and the `fd`/`rg` download. Also turns off `/share` and `/bug` uploads even when their URLs are set |
| `SORVEX_SKIP_VERSION_CHECK` | Disable the startup latest-version request. The request is already off unless `SORVEX_VERSION_CHECK_URL` is set |
| `SORVEX_VERSION_CHECK_URL` | Turn on the latest-version check and `update --self` by naming the API URL. Off by default until Sorvex hosts one |
| `SORVEX_INSTALLER_API_BASE` | Name the release artifacts base URL that `update --self` uses on a managed installation. Has no effect unless `SORVEX_VERSION_CHECK_URL` is also set. Off by default |
| `SORVEX_INSTALL_REPORT_URL` | Turn on the install report by naming its URL; Sorvex adds `?version=<version>`. Off by default, and still subject to `SORVEX_TELEMETRY` and `enableInstallTelemetry` |
| `SORVEX_BUG_REPORT_URL` | Turn on `/bug` uploads by naming the upload URL. Off by default, so `/bug` only exports a local zip archive |
| `SORVEX_TELEMETRY` | Override install/update telemetry and provider attribution headers: `1`/`true`/`yes` or `0`/`false`/`no` |
| `SORVEX_CODEMODE_MAX_WORKERS` | Maximum codemode workers alive at once across all sessions in the process; default `2`. Each worker's script may use up to 256 MB. Raise it when one process runs several sessions, such as in-process subagents. Further scripts wait for a free worker. See [Codemode](codemode.md) |
| `SORVEX_CACHE_RETENTION` | Set to `long` for extended provider prompt caching where supported |
| `SORVEX_SHARE_VIEWER_URL` | Turn on `/share` by naming the session viewer base URL. Off by default, so `/share` reports that sharing is off and uploads nothing |
| `SORVEX_CLEAR_ON_SHRINK` | Set to `1` to clear empty rows when rendered content shrinks; the `terminal.clearOnShrink` setting takes precedence. See [Settings](settings.md) |
| `SORVEX_HARDWARE_CURSOR` | Set to `1` to show the hardware cursor; see [Terminal setup](terminal-setup.md) |
| `SORVEX_CLIPBOARD_OSC52` | Set to `1` to also send copied text to the terminal with OSC 52 after the local clipboard write, as Sorvex does over SSH. Use it when a remote client reaches Sorvex without SSH variables, such as a multiplexer attached from another machine or a remote IDE daemon |
| `SORVEX_HYPERLINKS` | Override OSC 8 hyperlink detection with `1`, `0`, or `auto` |
| `SORVEX_PROGRAM_STATUS` | Override OSC 7501 program status detection: `1` always reports, `0` never reports; otherwise Sorvex reports only after the terminal confirms support. See [Terminal setup](terminal-setup.md#program-status) |
| `SORVEX_IMAGE_PROTOCOL` | Override inline image detection with `kitty`, `iterm2`, `none`, or `auto` |
| `SORVEX_TRUE_COLOR` | Override truecolor detection with `1`, `0`, or `auto` |
| `SORVEX_TUI_ESC_TIMEOUT` | How long to wait after a lone ESC before treating it as Escape, in milliseconds; defaults to `100` over SSH and `10` otherwise. Increase if Alt-key input is misread as Escape |
| `VISUAL`, `EDITOR` | External editor fallback when `externalEditor` is unset |
| `HTTP_PROXY`, `HTTPS_PROXY` | Proxy outbound HTTP requests |

`SORVEX_VERSION_CHECK_URL`, `SORVEX_INSTALLER_API_BASE`, `SORVEX_INSTALL_REPORT_URL`, `SORVEX_BUG_REPORT_URL`, and `SORVEX_SHARE_VIEWER_URL` accept only `http` or `https` URLs. Sorvex ignores any other value, warns once, and leaves the feature off.

When `fd` or `rg` is missing, interactive mode downloads it from its GitHub releases page (`github.com/sharkdp/fd`, `github.com/BurntSushi/ripgrep`) at startup. This is a tool install, not a Sorvex service, so it is not in the endpoint table. Install both tools yourself or set `SORVEX_OFFLINE` to prevent the download.

Provider credentials such as `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, and provider-specific configuration are listed in [Providers](providers.md#use-an-api-key-from-the-environment).
