# Sorvex

Sorvex is a coding and security agent. It has built-in subagents, plan mode, a todo list, and MCP support, and it is an extensible agent harness that you can make your own. Use it from the terminal or from the desktop app.

Sorvex has three modes: build (the default) writes and changes code, [plan](packages/coding-agent/docs/plan-mode.md) explores read-only and writes a plan for your approval, and [security](packages/coding-agent/docs/security-mode.md) finds, verifies, and fixes vulnerabilities with built-in security subagents. Switch with `/mode`, `--agent-mode`, or `ctrl+alt+n`.

Customize Sorvex with [extensions](packages/coding-agent/docs/extensions.md), [skills](packages/coding-agent/docs/skills.md), [prompt templates](packages/coding-agent/docs/prompt-templates.md), and [themes](packages/coding-agent/docs/themes.md), and bundle them as [Sorvex packages](packages/coding-agent/docs/packages.md) to share via npm or git.

Use Sorvex [interactively](packages/coding-agent/docs/usage.md), automate it in [print or JSON mode](packages/coding-agent/docs/cli.md), control it over [RPC](packages/coding-agent/docs/rpc.md), or build apps with the [Sorvex TypeScript SDK](packages/coding-agent/docs/sdk.md).

## Features

**Agent**
- Three modes: build, [plan](packages/coding-agent/docs/plan-mode.md), and [security](packages/coding-agent/docs/security-mode.md).
- Built-in [subagents](packages/coding-agent/docs/subagents.md) and a [todo list](packages/coding-agent/docs/todo.md).
- [Code mode](packages/coding-agent/docs/codemode.md): the model writes code that calls tools.
- [Sessions](packages/coding-agent/docs/sessions.md) you can resume and branch, with automatic [compaction](packages/coding-agent/docs/compaction.md) of long contexts.

**Models**
- Many [providers](packages/coding-agent/docs/providers.md) through one API, signed in with a subscription or an API key.
- [Local models](packages/coding-agent/docs/llama-cpp.md) through llama.cpp, plus [custom providers](packages/coding-agent/docs/custom-provider.md) and [virtual models](packages/coding-agent/docs/virtual-models.md).

**Customization**
- [Extensions](packages/coding-agent/docs/extensions.md), [skills](packages/coding-agent/docs/skills.md), [prompt templates](packages/coding-agent/docs/prompt-templates.md), [themes](packages/coding-agent/docs/themes.md), and [keybindings](packages/coding-agent/docs/keybindings.md).
- [MCP](packages/coding-agent/docs/mcp.md) server support.
- [Sorvex packages](packages/coding-agent/docs/packages.md) to share all of the above via npm or git.

**Integration**
- Interactive TUI, print and [JSON](packages/coding-agent/docs/json.md) modes, [RPC](packages/coding-agent/docs/rpc.md), and the [TypeScript SDK](packages/coding-agent/docs/sdk.md).
- Standalone binaries for macOS, Linux, and [Windows](packages/coding-agent/docs/windows.md).

**Desktop app**
- Chat, a browser the agent can drive, files, git changes, terminals, and background tasks.
- Guardrails, SSH hosts, Android devices, local models, and voice.
- Windows x64 installer built from Linux (see [Desktop app](#desktop-app)).

## Getting started

Sorvex is not published to npm yet; run it from this repository. It needs Node.js 22.19 or newer.

```bash
npm install --ignore-scripts   # install dependencies without running lifecycle scripts
npm run hydrate:model-data     # download the model catalog (once)
./sorvex-test.sh               # start the CLI from source; works from any directory
```

Start it in the directory you want it to work in. Run `/login` inside Sorvex to connect a provider subscription or API key, then give it a task. See the [documentation](packages/coding-agent/docs/index.md) for full setup and usage.

## Desktop app

[`apps/desktop`](apps/desktop) is a desktop app for Sorvex: a thin Tauri window around a local Node server that runs Sorvex in RPC mode. On top of everything the CLI does, it adds:

- **Chat** with sessions from every folder, attachments, `@file` completion, `!` shell commands, and a `/btw` side chat that can read the project without interrupting the main task.
- **Panes** for a built-in browser the agent can drive (with an element picker and screenshot annotations), files, git changes, and terminals.
- **Local models**: installs llama.cpp for your hardware, downloads GGUF models from Hugging Face, and runs them entirely on your machine.
- **Guardrails**: per-tool permissions (allow, ask, deny), safety rules, approval prompts, secret redaction in tool output, and optional reviewer models.
- **SSH hosts** the agent can run commands on, with their own guardrails, plus MCP server management, provider sign-in, voice input and output, and desktop notifications.

It needs Rust 1.90+ and the Tauri system libraries. Start it with:

```bash
cd apps/desktop && npm run desktop:dev
```

To build a Windows x64 installer (`Sorvex_<version>_x64-setup.exe`) from Linux, run `npm run desktop:build:windows` in `apps/desktop`. See [apps/desktop/README.md](apps/desktop/README.md) for details and requirements.

## Packages

| Package | Description |
|---------|-------------|
| **[@sorvex/coding-agent](packages/coding-agent)** | The Sorvex agent and CLI |
| **[@sorvex/desktop](apps/desktop)** | Desktop app (Tauri + React) |
| **[@sorvex/agent-core](packages/agent)** | Agent runtime with tool calling and state management |
| **[@sorvex/ai](packages/ai)** | Unified multi-provider LLM API (OpenAI, Anthropic, Google, and more) |
| **[@sorvex/tui](packages/tui)** | Terminal UI library with differential rendering |
| **[@sorvex/durable](packages/durable)** | Durable conversation, task, and document runtime |
| **[@sorvex/chord](packages/chord)** | Typed host runtime for hot-reloadable plugins, contracts, replicated state, and RPC over JSON links |
| **[@sorvex/codemode](packages/codemode)** | Runs model-written code that calls tools |
| **[@sorvex/mcp](packages/mcp)** | Model Context Protocol client |
| **[@sorvex/env](packages/env)** | Execution environments for the agent's tools |
| **[@sorvex/telemetry](packages/telemetry)** | Vendor-neutral telemetry contracts, reference adapter, conformance tests, and typed schemas |
| **[@sorvex/evals](packages/evals)** | Evaluation harness |

## Safety

The CLI runs with the permissions of the user who starts it and has no built-in sandbox for files, processes, network, or credentials. The desktop app's guardrails ask before risky tool calls and block known-dangerous patterns, but the agent's shell still runs as you, so treat them as a safety net, not a sandbox. Its SSH and browser checks are enforced by the app's server rather than by the agent.

For stronger boundaries, containerize or sandbox Sorvex. See [containerization](packages/coding-agent/docs/containerization.md) for three patterns:

- **Gondolin extension**: keep `sorvex` and provider auth on the host while routing built-in tools and `!` commands into a local Linux micro-VM.
- **Plain Docker**: run the whole `sorvex` process in a local container for simple isolation.
- **OpenShell**: run the whole `sorvex` process in a policy-controlled sandbox.

## Development

```bash
npm install --ignore-scripts  # install all dependencies without running lifecycle scripts
npm run prepare               # once: enable the git pre-commit hook (skipped by --ignore-scripts)
npm run build                 # refresh model data, then build all packages
npm run build:offline         # rebuild using existing model data without network access
npm run check                 # lint, format, and type check
./test.sh                     # run tests (skips LLM-dependent tests without API keys)
```

See [AGENTS.md](AGENTS.md) for project rules, for both humans and agents.

### Using local packages outside the monorepo

Build every public package into one coherent local artifact set:

```bash
npm run pack:packages -- --out .artifacts/sorvex-packages
```

This refreshes model data before building `@sorvex/ai`. To avoid network access when model data is already hydrated, pass `--offline-model-data`.

Then configure an external project to consume one package and resolve all of its Sorvex dependencies from the same artifact set. npm is the default:

```bash
node scripts/use-local-packages.mjs \
  --manifest .artifacts/sorvex-packages/manifest.json \
  --consumer ../my-project \
  --package @sorvex/durable \
  --package @sorvex/agent-core
cd ../my-project
npm install --ignore-scripts
```

For a pnpm project, point `--consumer` at the workspace root:

```bash
node scripts/use-local-packages.mjs \
  --manifest .artifacts/sorvex-packages/manifest.json \
  --consumer ../my-project \
  --package @sorvex/agent-core \
  --package-manager pnpm
cd ../my-project
pnpm install --ignore-scripts
```

Repeat `--package` for each direct dependency. The command updates the consumer's `package.json` with content-addressed local `file:` references. It writes transitive overrides to `package.json` for npm or `pnpm-workspace.yaml` for pnpm. Keep the artifact directory available while installing or updating the consumer. Re-run both commands after changing Sorvex source.

## Supply-chain hardening

Dependency changes are treated as reviewed code changes.

- Direct external dependencies are pinned to exact versions. Internal workspace packages remain version-ranged.
- `.npmrc` sets `save-exact=true` and `min-release-age=2` to avoid same-day dependency releases during npm resolution.
- `package-lock.json` is the dependency ground truth. The pre-commit hook blocks accidental lockfile commits unless `SORVEX_ALLOW_LOCKFILE_CHANGE=1` is set.
- `npm run check` verifies pinned direct deps, native TypeScript import compatibility, and the generated coding-agent install lock.
- `packages/coding-agent/install-lock/`, generated from the root lockfile, pins transitive deps for release installs.
- Install lock generation has an explicit allowlist for dependency lifecycle scripts; new lifecycle-script deps fail checks until reviewed.

## License

MIT. Sorvex is based on [pi](https://github.com/badlogic/pi-mono); see [LICENSE](LICENSE).
