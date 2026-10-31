# Quickstart

Sorvex runs in your terminal and works with files on your machine. To use it, you need access to a model through a supported provider. This can be a subscription, an API key, or a local model.

For native Windows setup, read [Windows Setup](windows.md). For Android, read [Termux Setup](termux.md).

## 1. Install Sorvex

Install Sorvex from npm, which does not pin transitive dependencies. This requires Node.js 22.19 or newer:

```bash
npm install -g --ignore-scripts @sorvex/coding-agent
```

Sorvex does not require dependency lifecycle scripts for a normal npm installation.

With Nix on macOS or Linux, install Sorvex from its flake, which tracks `main` of [Aqua-123/Sorvex](https://github.com/Aqua-123/Sorvex). Nix builds Sorvex from source:

```bash
nix profile add github:Aqua-123/Sorvex#sorvex
```

Older Nix versions use `nix profile install` instead. Update with `nix profile upgrade sorvex`; `sorvex update` cannot update a Nix installation. To pin a version, use a commit such as `github:Aqua-123/Sorvex/<commit>#sorvex`.

Verify the installation:

```bash
sorvex --version
```

## 2. Start Sorvex

Change to the folder you want Sorvex to work with, then start it:

```bash
cd /path/to/folder
sorvex
```

The working folder helps Sorvex discover relevant files, instructions, and configuration. Sorvex also uses it to group saved sessions.

<p align="center"><img src="images/interactive-mode.png" alt="Sorvex running in a terminal with a conversation, input editor, and status footer" width="750"></p>

The interface shows your conversation, an editor for prompts and commands, and a footer with the current folder, model, and session status. See [Use Sorvex in the terminal](usage.md) to learn how to add files, run commands, direct ongoing work, and manage results.

## 3. Choose a model

A **model** generates Sorvex's responses. A **provider** is the service or account Sorvex uses to access that model.

In Sorvex, run:

```text
/login
```

Choose a provider, then follow the prompts to use a subscription or store an API key. Run `/model` afterward if you want to select a different available model.

See [Choose a model and provider](models.md) for supported providers, environment-variable authentication, local models, and custom endpoints.

## 4. Give Sorvex a task

Sorvex shows each file read, search, command, and edit it performs. It does not ask before every tool call.

Enter a task that matches your work, for example:

```text
Summarize @meeting-notes.md and save the action items to action-items.md.
```

```text
Explain how this repository is structured and how to run its checks.
```

```text
Compare @previous.csv with @current.csv and summarize the important changes.
```

Type `@` in the editor to search for a file instead of entering its full path. When Sorvex finishes, review its response and any changed files. Use version control or backups for important work. For untrusted or unattended work, use a container or another sandbox. See [Security](security.md).

## Continue later

Sorvex saves sessions automatically. Exit Sorvex, then resume the most recent session for the same working folder with:

```bash
sorvex --continue
```

Use `/resume` to choose another saved session. See [Continue or branch a session](sessions.md) for session naming, branching, compaction, export, and sharing.

## Next steps

- [Use Sorvex interactively](usage.md) to learn input, commands, shortcuts, and queued messages.
- [Add instructions](configuration.md#context-files) that Sorvex should follow whenever it works in a folder.
- [Choose a model and provider](models.md).

### Choose how to customize Sorvex

Start with the least powerful mechanism that meets your need:

| Need | Start with |
|---|---|
| Give Sorvex persistent instructions for a folder | [`AGENTS.md`](configuration.md#context-files) |
| Reuse a prompt from the `/` menu | [Prompt template](prompt-templates.md) |
| Add task-specific instructions and supporting files | [Skill](skills.md) |
| Add executable tools, commands, or event handlers | [Extension](extensions.md) |
| Build a custom terminal component | [Terminal UI](tui.md) |
| Connect an unsupported model service | [Custom provider](custom-provider.md) |
| Install or distribute several resources | [Sorvex package](packages.md) |

## Uninstall Sorvex

If you installed Sorvex with npm, run:

```bash
npm uninstall -g @sorvex/coding-agent
```

If you installed Sorvex with Nix, run:

```bash
nix profile remove sorvex
```

None of these methods removes configuration, credentials, sessions, or installed Sorvex packages from `~/.sorvex/agent/`.
