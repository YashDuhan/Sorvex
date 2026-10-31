# Modes and security mode

Sorvex, the coding and security agent, has three modes. One mode is on at a time:

| Mode | What the model does | Tools | Footer |
|---|---|---|---|
| `build` | Writes and changes code. This is the default. | Every active tool | Nothing |
| `plan` | Explores the code and writes a plan for you to approve. See [Plan mode](plan-mode.md). | Read-only tools and read-only shell commands | `plan` |
| `security` | Vulnerability triage, recon, code audit, red teaming, and hardening on code and systems you are authorized to test. | Every active tool | `security` |

The modes come from the built-in `modes` extension, and plan mode from the built-in `plan` extension. Disable the modes with `"extensions": ["-builtin:modes"]` in [settings](settings.md#resources). An extension that registers the `/mode` or `/security` command or the `--agent-mode` flag replaces it.

## Switch modes

- `/mode build`, `/mode plan`, and `/mode security` switch to that mode. `/mode` without an argument lets you pick one, and in print and JSON modes reports the current mode.
- `app.mode.cycle` (default `ctrl+alt+n`) switches to the next mode: build, plan, security, then build again. `shift+tab` is not used because it cycles the thinking level.
- `/security` turns security mode on, or switches back to build mode when it is on.
- `/plan` and `app.plan.toggle` (default `ctrl+alt+p`) still turn plan mode on or off. Turning plan mode on ends security mode.
- `--agent-mode <build|plan|security>` starts the session in that mode, in any case. Any other value stops Sorvex before the session starts, with exit code 1 and the error `Unknown --agent-mode "<value>". Use build, plan, security.` See [CLI](cli.md#prompts-and-process). `--mode` selects the output mode (text, JSON, or RPC) and is unrelated.
- `--plan` with a resumed security session, such as `sorvex -c --plan`, starts in plan mode and ends security mode.

Leaving plan mode by switching modes works like `/plan` off: the saved tools come back and no plan is approved. Switching from plan to security leaves plan mode first.

Rebind the key in [keybindings](keybindings.md). In RPC mode the footer arrives as a `setStatus` request with the key `mode` (`security`) or `plan` (`plan`).

Switching to plan mode needs the built-in plan extension. When it is not loaded, `/mode plan` reports an error and `app.mode.cycle` skips plan mode.

## What changes in security mode

Security mode does not change the active tools: it is a working mode, not a read-only one. While it is on, the system prompt has a `security_mode` section that tells the model:

- it works on authorized security tasks: vulnerability triage, recon of in-scope targets, code audit, red-team style testing of systems you own or are authorized to test, and hardening.
- before any active testing against a network target, such as scanning, fuzzing, or exploit traffic, it asks you for the scope and confirms you are authorized. Local code and services it starts on localhost need no confirmation.
- it starts with read-only analysis of code, configuration, and dependencies.
- it reports each finding as title, severity, evidence (`file:line`, or the request and response), impact, and fix, and says when a finding is unverified.

When the built-in `subagent` tool is active, the section also names the security subagents. In build and plan mode the section is absent, and the default system prompt is the same as without the modes extension.

The section text is the same on every turn and changes only when the mode changes, so ordinary turns keep the provider cache.

Security mode is an instruction to the model, not a sandbox or a penetration-testing tool. It does not stop a command from reaching any host or file the Sorvex process can reach. To limit what generated commands can affect, see [Run Sorvex safely](security.md).

## Security subagents

The built-in [subagents](subagents.md) include five security agents. They are available in every mode; security mode tells the model about them. In plan mode they run read-only like every other subagent.

| Agent | Tools | Purpose |
|---|---|---|
| `triage` | `read`, `grep`, `find`, `ls`, `bash` | Reproduces a reported issue and rates whether it is real, reachable, and how severe. |
| `recon` | `read`, `grep`, `find`, `ls`, `bash` | Maps the attack surface of the repository or of an in-scope target. |
| `auditor` | `read`, `grep`, `find`, `ls` | Audits code for vulnerability classes such as injection, broken access control, and unsafe deserialization. Thinking level `high`. |
| `redteam` | `read`, `grep`, `find`, `ls`, `bash`, `write` | Builds proofs of concept only for targets the task states are in scope and authorized, and refuses others. Writes new files and does not change application code. |
| `hardener` | `read`, `grep`, `find`, `ls`, `bash`, `edit`, `write` | Applies fixes for confirmed issues and tests them. |

The scope and file rules of `triage`, `recon`, and `redteam` are prompt rules: `bash` can still reach any host or file the Sorvex process can. A user or project agent with the same name replaces a built-in one.

## How modes are stored

Each time build or security mode turns on, Sorvex appends an `agent-mode` custom entry such as `{ "mode": "security" }` to the session. Plan mode keeps its own `plan-mode` entries. Sorvex reads the last entries on the current branch when a session starts or resumes and after `/tree`. A `plan-mode` entry that turns plan mode on ends the `agent-mode` entries before it, so the branch never has security and plan mode on together. Reading the entries does not write to the session.

Extensions can follow the mode on the event bus. The modes extension emits the mode, `"build"`, `"plan"`, or `"security"`, on `mode:change`: once when a session starts and when `/tree` moves to a branch in another mode, then once each time the mode changes, however it changes (`/mode`, `/security`, `/plan`, `app.mode.cycle`, `app.plan.toggle`, or `exit_plan_mode`). Switching to the current mode emits nothing. Plan mode emits `plan:transition` when it turns on or off and turns on or off on a `plan:set` request.
