# Sorvex

Sorvex, the coding and security agent. It has built-in subagents, plan mode, a todo list, and MCP support, and it is an extensible agent harness that you can make your own.

Sorvex has three modes: build (the default) writes and changes code, [plan](docs/plan-mode.md) explores read-only and writes a plan for your approval, and [security](docs/security-mode.md) finds, verifies, and fixes vulnerabilities with built-in security subagents. Switch with `/mode`, `--agent-mode`, or `ctrl+alt+n`.

Adapt Sorvex to your workflows, not the other way around. Customize Sorvex with [extensions](docs/extensions.md), [skills](docs/skills.md), [prompt templates](docs/prompt-templates.md), and [themes](docs/themes.md). Bundle them as [Sorvex packages](docs/packages.md) and share via npm or git.

Ask Sorvex to build what you want, or install a package that does it your way.

Use Sorvex [interactively](docs/usage.md), automate it in [print or JSON mode](docs/cli.md), control it over [RPC](docs/rpc.md), or build apps with the [Sorvex TypeScript SDK](docs/sdk.md). See [OpenClaw](https://github.com/OpenClaw/OpenClaw) for a real-world integration.

## Getting started

Install the command-line interface with npm, which does not pin transitive dependencies:

```bash
npm install -g --ignore-scripts @sorvex/coding-agent
```

Sorvex requires Node.js 22.19 or newer. Sorvex does not require dependency lifecycle scripts for a normal npm installation.

On macOS and Linux, Nix users can install Sorvex with `nix profile add github:Aqua-123/Sorvex#sorvex`. See the [quickstart](docs/quickstart.md#1-install-sorvex) for updating and pinning a version.

Start Sorvex in the directory where you want it to work:

```bash
cd /path/to/project
sorvex
```

For a built-in AI provider, run `/login` inside Sorvex to connect a subscription or API key. Then give Sorvex a task.

See the [documentation](docs/index.md) for full setup and usage instructions.

## Development

Clone the repository, install its dependencies, and run Sorvex from source:

```bash
git clone https://github.com/Aqua-123/Sorvex sorvex
cd sorvex
npm install --ignore-scripts
./sorvex-test.sh
```

`sorvex-test.sh` can be called from any directory and preserves the caller's working directory.

Before submitting changes, run:

```bash
npm run check
./test.sh
```

Read [AGENTS.md](https://github.com/Aqua-123/Sorvex/blob/main/AGENTS.md) for repository-specific implementation, testing, dependency, and release rules.

## License

MIT
