# Plan mode

In plan mode the model explores the code and writes a plan, but it cannot change anything. You read the plan, then approve it, ask for changes, or leave plan mode. After approval the model gets its tools back, records the plan's steps in the [todo list](todo.md), and starts.

Plan mode comes from the built-in `plan` extension. It is on by default. Disable it with `"extensions": ["-builtin:plan"]` in [settings](settings.md#resources). An extension that registers the `exit_plan_mode` tool, the `/plan` command, or the `--plan` flag replaces it.

## Turn plan mode on and off

- `/plan` turns plan mode on, or off when it is on.
- `app.plan.toggle` (default `ctrl+alt+p`) does the same. Rebind it in [keybindings](keybindings.md).
- `--plan` starts the session in plan mode, and ends security mode when it resumes a security session. See [CLI](cli.md#prompts-and-process).
- `/mode plan` and `app.mode.cycle` (default `ctrl+alt+n`) switch to plan mode from build or [security mode](security-mode.md). Turning plan mode on ends security mode.

While plan mode is on, the footer shows `plan`. In RPC mode this arrives as a `setStatus` request with the key `plan`. See [RPC extension UI](rpc-extension-ui.md).

Turning plan mode off with `/plan` or the key restores the tools without approving a plan.

## What the model can do while planning

When plan mode turns on, Sorvex saves the active tools and activates only these:

- the active tools that are marked read-only (`read`, `grep`, `find`, and `ls` among the built-in tools, and MCP tools whose server marks them read-only),
- `bash`, which runs only read-only commands,
- `powershell`, if it was active, which runs only read-only commands,
- `todo`,
- the built-in `subagent` tool, if it was active, which runs its agents read-only (see [Subagents while planning](#subagents-while-planning)), and
- `exit_plan_mode`.

Tools that change files, such as `edit` and `write`, are not declared to the model while planning. A call to a tool that is not read-only returns an error that starts with `Plan mode:` and does not run. This also covers tools that become active during planning, for example MCP tools of a server that finishes connecting. Such tools are added to the saved tools, so they come back when plan mode turns off. After a session resumes in plan mode, the tools of servers that are still connecting stay pending and activate when they register.

`tool_search` and `codemode` are not available while planning: `tool_search` changes the active tools and `codemode` runs other tools. MCP tools that the model reaches only through them are unavailable until plan mode turns off.

A shell command runs only when every command in it is on a read-only allowlist and uses only the flags and subcommands listed for it. Sorvex splits the command at `|`, `;`, `&&`, `||`, and line breaks. A command or flag that is not listed is blocked, so is anything Sorvex cannot parse. This includes `find -delete`, `git commit`, `git branch name`, `sed -i`, `npm`, `node`, `python`, `awk`, and `curl -o`.

- In `bash`, listed commands include `ls`, `cat`, `head`, `tail`, `wc`, `grep`, `rg`, `find`, `tree`, `sort`, `uniq`, `diff`, `jq`, `stat`, `file`, `du`, `pwd`, `echo`, and `env`; `git status`, `log`, `show`, `diff`, `blame`, `branch`, `ls-files`, `rev-parse`, and `remote`; `sed -n 'N,Mp'`; and `curl` with `-fIkLsS` and a few long flags. Names match exactly, so `GIT` and `LS` are blocked.
- In `powershell`, listed commands are `git`, `rg`, `jq`, `ls`, `cat`, `echo`, and `pwd` with the same rules, and `Get-ChildItem`, `Get-Content`, `Select-String`, `Select-Object`, `Measure-Object`, `Test-Path`, and similar cmdlets and their aliases. Names match in any case. PowerShell aliases such as `gci` and `sls` are blocked in `bash`.

Also blocked are command substitution and variables (`$`, backticks, `$(...)`), parentheses, braces, brackets, `<`, `#`, `@`, `&` and `|&`, backslashes in bash, and typographic quotes, dashes, and non-ASCII spaces anywhere in the command, even inside quotes. Only `2>&1`, `2>/dev/null` (bash), and `2>$null` (PowerShell) are allowed as redirects; any other `>` is blocked, and so is a line break between `2>` and its target.

bash, and PowerShell for programs on Linux and macOS, expand an unquoted `*` or `?` into file names. Such a glob is blocked at the start of a word, where it can expand to a file named like a flag. Anywhere in a word, it is blocked for commands whose arguments mean different things by position or that limit how many they take, because a glob can expand to any number of them: `uniq`, `jq`, `find`, `sed`'s script, `pwd`, `env`, `uname`, `git branch`, and `git remote`. `uniq -c a*` is blocked, and `cat src/*.ts` and `uniq -c 'a*'` run. PowerShell cmdlets such as `Get-ChildItem *.ts` and `Select-String -Path *.ts` expand wildcards themselves and allow globs anywhere.

Some commands read flags after `--`, so `find` with `--` is blocked, and for other commands an argument after `--` that starts with `-` is blocked, except `-` alone. In PowerShell, a word that starts with a quote ends at its closing quote, so `'HEAD'--output=x` is two arguments and is blocked. A `"` inside an argument and a `\` at the end of an argument with spaces are also blocked in PowerShell, because Windows PowerShell passes them to programs in a way that splits the argument. A carriage return blocks a command in bash, which reads it as part of a word. PowerShell reads it as a line break.

This check stops accidental changes. It is not a sandbox. Listed commands can still read anything the user can: `curl` sends GET requests to any URL, including `file://` URLs, and `env` and `jq` (through `env` and `$ENV`) print environment variables.

### Subagents while planning

The model can hand exploration to [subagents](subagents.md) while planning. Each subagent follows the same rules as the session:

- It gets only the tools in its agent's `tools` list (or the default tools) that are marked read-only, plus `bash` and `powershell` if the agent has them. A `worker` keeps `read`, `grep`, `find`, `ls`, and `bash`, and loses `edit` and `write`.
- Its shell commands go through the same read-only check. A blocked command returns an error to the subagent and does not run.
- Tools that become active during its run, such as tools of an MCP server that finishes connecting, are removed again before its next request. A call to any tool that is not read-only is blocked.
- It runs only in the session's working directory or a directory below it. A task with a `cwd` outside it fails and does not start.

Each subagent checks plan mode when it starts. When plan mode turns on while subagents run, including [background runs](subagents.md#background-runs), the running subagents are read-only from their next tool call, and so is every later one in the call. The subagents that a running subagent started are held read-only at their next model response. A running subagent that cannot be held to the rules is stopped. A [fork](subagents.md#fork-context) subagent keeps the session's tool declarations, and its plan extension blocks every call that is not read-only.

The tool result ends with a line that says the subagents ran read-only, and the terminal UI marks the result `read-only (plan mode)`. After plan mode ends, the same agents get their full tools again.

A subagent's read-only tools are the ones marked read-only, and an MCP tool is marked read-only when its server says so (`readOnlyHint`), as in the session. A server that marks a tool read-only although it changes something is trusted the same way. A subagent also starts the MCP servers configured for its working directory, so a subagent in a trusted project directory below the session's starts that project's servers while planning.

A `subagent` tool from another extension, such as `pi-subagents`, does not know these rules. Plan mode does not activate it and blocks calls to it.

The built-in `subagent` tool relies on the built-in plan extension. When plan mode is on in the session's transcript but the built-in plan extension is not loaded, for example because settings disable `builtin:plan` after a session was saved in plan mode, every subagent call fails with an error that names the cause. To run subagents again, enable `builtin:plan` and turn plan mode off with `/plan`, or start a new session. An extension that replaces plan mode must enforce its own rules on `subagent`: the built-in `subagent` tool knows only the built-in plan mode, so under a replacement that does not block it, its agents run with their full tools.

While planning, the system prompt has a `plan_mode` section that tells the model these rules and asks it to call `exit_plan_mode` with the finished plan. The section text is the same on every turn and changes only when plan mode turns on or off, so ordinary turns keep the provider cache.

## Approve the plan

The model calls `exit_plan_mode` with the plan in Markdown. In the terminal UI and in RPC mode, Sorvex shows the plan and asks what to do:

| Choice | Effect |
|---|---|
| Approve and start | Plan mode turns off and the saved tools come back. The model records the plan's steps with `todo` and starts the first step. |
| Keep planning | Sorvex asks what should change. The model receives your answer and revises the plan. Plan mode stays on. |
| Exit plan mode | Plan mode turns off and the saved tools come back. The model does not start the plan, and the run ends. |

Dismissing the prompt keeps plan mode on and ends the run, so you can say what to change.

In print and JSON modes there is no one to ask. `exit_plan_mode` ends the run, the plan is the tool result, and plan mode stays on. `sorvex --plan -p "plan the refactor"` writes the plan to stdout.

## How plan mode is stored

Each time plan mode turns on or off, Sorvex appends a `plan-mode` custom entry to the session with the new state and the tools to restore. Sorvex reads the last entry on the current branch when a session starts or resumes and after `/tree`, so resuming a session or moving to another branch shows plan mode as it was there. When plan mode turned off and no run has started since, the session's recorded tools are still the planning tools, so Sorvex restores the saved tools again. Reading the entries does not write to the session.
