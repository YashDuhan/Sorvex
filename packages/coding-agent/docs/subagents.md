# Subagents

Sorvex can hand a task to a subagent: a separate agent with its own context window. The subagent works on the task with its own system prompt and tools, and only its final answer comes back into your conversation. Use it for work whose intermediate output would crowd the main context, such as a broad search of a codebase.

The `subagent` tool comes from the built-in `subagent` extension. It is active by default. Disable it with `"extensions": ["-builtin:subagent"]` in [settings](settings.md#resources), or under Built-in in `sorvex config`. An installed extension that registers a `subagent` tool or an `/agents` command, such as `pi-subagents`, replaces it.

## What the model can do

The tool has three modes. Each call gives exactly one of them. A call that gives none, or more than one, is an error.

| Mode | Fields | What runs |
|---|---|---|
| Single | `agent`, `task`, optional `cwd` and `context` | One agent. |
| Parallel | `tasks`: a list of `{ agent, task, cwd?, context? }` | Up to 8 agents, at most 4 at a time. |
| Chain | `chain`: a list of `{ agent, task, cwd?, context? }` | Up to 8 steps, in order. `{previous}` in a step's task is replaced with the previous step's final answer. |

By default a subagent does not see your conversation, so each task must say everything the agent needs. A task with `context: "fork"` starts from a copy of the conversation instead; see [Fork context](#fork-context). `cwd` is a working directory relative to the current one. Default: the current directory.

Any of the modes can run in the background with `background: true`; see [Background runs](#background-runs).

Sorvex checks the whole call before any subagent starts. An unknown agent name is an error that lists every available agent. A missing working directory or a model that does not resolve is also an error.

The tool returns:

- **Single.** The subagent's last answer.
- **Parallel.** A line with the number of tasks that succeeded, then each agent's status and last answer, in the order of `tasks`.
- **Chain.** The last step's answer. A chain stops at the first step that fails or is aborted, and the result names that step.

The result is an error if any subagent failed or was aborted. In parallel mode this holds even when the other tasks succeeded, and their answers are still in the result. It also carries the token usage and cost of every subagent, so the session totals include them.

### Chain example

This call has a scout collect context and a planner write a plan from it:

```json
{
  "chain": [
    { "agent": "scout", "task": "Find the code that handles session compaction." },
    { "agent": "planner", "task": "Plan how to add a compaction size limit. Context from the scout:\n\n{previous}" }
  ]
}
```

To reuse a chain, write it as a [prompt template](prompt-templates.md). Save this as `~/.sorvex/agent/prompts/scout-and-plan.md` and run `/scout-and-plan <request>`:

```markdown
---
description: Scout gathers context, planner writes an implementation plan
argument-hint: "<request>"
---
Use the subagent tool with the chain parameter:

1. The "scout" agent finds all code relevant to: $@
2. The "planner" agent writes an implementation plan for "$@" from the scout's findings (use the {previous} placeholder).

Do not implement anything. Return the plan.
```

The same shape works for an implement-and-review loop: `worker` implements, `reviewer` reviews `{previous}`, and `worker` applies the review in `{previous}`.

### Fork context

`context` is `fresh` or `fork`. Default: `fresh`.

- **`fresh`.** The subagent starts with an empty conversation, its own system prompt (Sorvex's default prompt with the agent's body appended), and only its own tools. It sees only `task`.
- **`fork`.** The subagent starts from a copy of your conversation: the messages the model saw before the reply that called `subagent`. Its requests keep your session's system prompt and tool declarations byte for byte, so the provider's prompt cache covers the whole copied conversation and the subagent pays full price only for its new messages. The task message starts with a `<subagent_instructions>` block that holds the agent's body and names its tools, followed by `task`. The subagent still sees every tool your session declares, but a call to a tool that is not in the agent's `tools` list is blocked with an error that lists the agent's tools. A tool that calls other tools, such as a `codemode` script, can call only the tools a `fresh` subagent of the same agent could call.

Use `fork` when the task depends on what the conversation already established, such as "review the change we just made", and `fresh` for self-contained work, which keeps the subagent's context small.

A fork subagent copies messages only. It does not inherit your session's extension state, such as the todo list, plan mode, or MCP approvals you gave for the session. Its requests carry your session's id as the provider's session id, which providers such as OpenAI use to route a request to its cache. For a cache hit, use an agent without its own `model` or `thinking`, so the subagent uses your session's model and thinking level; either one changes the request, so the cache misses. An agent with its own `model` sends the whole copied conversation to that model's provider. The tool declarations are fixed for the whole run, so `tool_search` in a fork subagent cannot declare tools that your session did not declare. With OpenAI Codex WebSockets, the subagent shares your session's connection cache: a connection it opens stays in that cache for your session to reuse and closes when it is idle for 5 minutes or your session ends, and a WebSocket failure in the subagent makes your session fall back to SSE too. Messages that an installed extension changes for each request with a `context` handler are copied as the session stores them, so such an extension can make the copy differ from what the model last saw.

```json
{ "agent": "reviewer", "task": "Review the change we just made to the session loader.", "context": "fork" }
```

### Background runs

With `background: true`, the call returns at once with a run id such as `sub_3f2a1c`, and the model keeps working. The subagents run as usual. When they end, their result arrives in your conversation as a follow-up message: after the current turn when the session is busy, or at once when it is idle, which starts a new turn. Child ids are the run id, with `.1`, `.2`, and so on for the tasks of a parallel or chain run.

The same tool acts on a background run by id:

| Call | What it does |
|---|---|
| `{ "action": "status", "id": "sub_3f2a1c" }` | The run's state, elapsed time, and tokens, and each child's state and latest answer. Without `id`, one line for each background run of the session. |
| `{ "action": "wait", "id": "sub_3f2a1c" }` | Waits until the run ends and returns its result. The result then does not arrive again as a follow-up. Pressing Escape stops the wait, not the run. |
| `{ "action": "cancel", "id": "sub_3f2a1c" }` | Aborts the run. It ends as aborted and sends no follow-up. |

A background run is not part of your session's turn, so Escape does not abort it. Sorvex cancels every background run when the session ends: when you quit, start a new session, or switch to another one. In print and JSON mode, Sorvex exits after the last prompt, so the last prompt waits for the background runs before it ends and continues with their results; aborting the prompt stops the wait. A background run that a subagent starts ends with that subagent: the subagent does not wait for it, and it is cancelled when the subagent gives its answer or is aborted, so a subagent that needs the result gets it with `wait`. Background runs add their token usage to the session totals as they run.

In the terminal UI, a line below the editor lists each running background subagent with its id, agent, elapsed time, and tokens. A line goes away when its run ends.

## How a subagent runs

A subagent runs inside the same Sorvex process, in an in-memory session that is not saved. It loads the built-in extensions your session loaded, such as MCP, codemode, tool search, todo, and `subagent`, but no user or project extensions, skills, prompt templates, or context files such as `AGENTS.md`. Its system prompt is Sorvex's default system prompt with the body of its agent file appended. A `SYSTEM.md` or `APPEND_SYSTEM.md` does not apply to it. When it ends, its extensions get `session_shutdown`, so MCP servers it started are stopped.

Subagents nest at most two levels deep. A subagent can start subagents of its own when its tools include `subagent`, and those get no `subagent` tool. Their token usage counts toward the subagent's, and so toward your session's totals.

A subagent's working directory gets its own [project trust](security.md#understand-project-trust): the trust that starting `sorvex` in that directory would give without asking. Your session's directory has your session's trust, including a trust answer for this session only and `--approve`. Any other directory, nested or not, that has trust-requiring resources such as `.sorvex/settings.json` is trusted only by a trust decision you saved for it or a parent directory, or by `"defaultProjectTrust": "always"`. So a `cwd` the model picks cannot load a project's settings, such as `shellCommandPrefix`, that you never trusted.

- **Model.** The agent's `model`, or else the model of your session. A bare model id prefers the provider of your session's model.
- **Thinking level.** A `:<level>` suffix on the agent's `model`, or else its `thinking`, or else the level of your session. Sorvex clamps the level to what the model supports.
- **Tools.** Only the tools in the agent's `tools` list. Name an MCP tool as `mcp__<server>__<tool>`, or use `*` as a wildcard, such as `mcp__docs__*`. Without a list, `read`, `grep`, `find`, and `ls`.
- **MCP approvals.** A subagent cannot ask you, so an MCP call that its server's [`approve`](mcp.md#approve-tool-calls) setting gates fails with the reason, even when you chose "Allow once" or "Allow for this session" for that tool in your session. "Always allow this server" applies to a subagent whose working directory is the directory you chose it in.

Parallel subagents share the working tree. Two agents that edit the same files at the same time can overwrite each other's changes, so give parallel agents separate files or read-only work.

Press Escape to abort your session's current turn. This also aborts every running subagent, and parallel tasks that have not started do not start.

While subagents run, their tool calls and latest answers show under the `subagent` tool call. A parallel or chain call shows each run with its status: `·` not started, `⏳` running, `✓` done, `✗` failed or aborted. Expand the tool output (`ctrl+o` by default) to see each task, every tool call, and the full answers.

### In plan mode

While [plan mode](plan-mode.md) is on, every subagent is read-only. Sorvex checks plan mode when each subagent starts, from the session's `plan-mode` entries. When plan mode turns on while subagents run, including background runs, each running subagent is read-only from its next tool call, and in a parallel or chain call the subagents that start after that are read-only too. A running subagent that cannot be held to the rules, because it cannot load the plan extension or runs outside the session's directory, is stopped and fails with the reason. A subagent started by a read-only subagent is read-only too, and when plan mode holds a running subagent, the subagents that it is running are held read-only at their next model response. A read-only subagent runs only in the session's working directory or below it. A subagent then keeps only the tools from its list that are marked read-only, plus `bash` and `powershell`, and its shell commands must pass the plan-mode read-only check. A `worker` can read files and run read-only commands, but it has no `edit` or `write`, and a command such as `rm` does not run. The subagent cannot start subagents of its own or use `todo`, `tool_search`, or `codemode`.

A fork subagent keeps the tool declarations it copied: started while planning, it has your session's planning tools, and started before planning, it keeps its tools, and its plan extension blocks each call that is not read-only.

The subagent's own copy of the built-in plan extension enforces these rules on every tool call, including tools that become active during the run. The subagent cannot turn them off. Tools that become active during the run, such as tools of an MCP server that finishes connecting, are removed again before the subagent's next request. When the session or the subagent cannot load the built-in plan extension, for example because settings disable `builtin:plan`, the run fails instead of running without the rules, and the error says how to turn plan mode off. An extension that replaces plan mode must enforce its own rules on `subagent`; under a replacement that does not, the built-in `subagent` tool runs its agents with their full tools. The result text ends with a line that says the subagents ran read-only, the result details have `readOnly: true`, and the terminal UI marks the result `read-only (plan mode)`.

## Agents

Sorvex ships eleven agents:

| Agent | Tools | Purpose |
|---|---|---|
| `scout` | `read`, `grep`, `find`, `ls`, `bash` | Fast codebase recon that returns compressed context for another agent. |
| `planner` | `read`, `grep`, `find`, `ls` | Turns context and requirements into an implementation plan. |
| `reviewer` | `read`, `grep`, `find`, `ls`, `bash` | Reviews code for quality and security. |
| `worker` | `read`, `grep`, `find`, `ls`, `bash`, `edit`, `write` | General-purpose work, including edits and commands, in an isolated context. |
| `oracle` | `read`, `grep`, `find`, `ls`, `bash` | Checks a plan or decision against the decisions and constraints given in its task, and reports drift. Does not edit files. Thinking level `high`. |
| `delegate` | `read`, `grep`, `find`, `ls`, `bash`, `edit`, `write` | Does the task with a short, neutral prompt. |
| `triage` | `read`, `grep`, `find`, `ls`, `bash` | Reproduces a reported security issue and rates it. |
| `recon` | `read`, `grep`, `find`, `ls`, `bash` | Maps the attack surface of the repository or of an in-scope target. |
| `auditor` | `read`, `grep`, `find`, `ls` | Audits code for vulnerability classes. Thinking level `high`. |
| `redteam` | `read`, `grep`, `find`, `ls`, `bash`, `write` | Builds proofs of concept for authorized targets only. |
| `hardener` | `read`, `grep`, `find`, `ls`, `bash`, `edit`, `write` | Applies and tests fixes for confirmed issues. |

The security agents are the ones [security mode](security-mode.md#security-subagents) tells the model to use. The built-in agents use the model of your session. The `oracle` and `delegate` prompts are adapted from [pi-subagents](https://github.com/nicobailon/pi-subagents) (MIT).

Run `/agents` to list the agents the tool can run, grouped by source, with each agent's description and file, followed by any agent files that were skipped and why. In an untrusted project, `/agents` says that project agents were not read and lists none.

### Add an agent

An agent is a Markdown file with YAML frontmatter. The body is the system prompt:

```markdown
---
name: docs-checker
description: Checks that docs match the code
tools: read, grep, find, ls
model: anthropic/claude-haiku-4-5
thinking: low
---

You check documentation against the code it describes. Report each mismatch with file and line.
```

| Field | Required | Description |
|---|---|---|
| `name` | yes | Name the tool uses to select the agent. |
| `description` | yes | One line that tells the model what the agent is for. |
| `tools` | no | Tool allowlist, as `read, grep` or `[read, grep]`. Default: `read`, `grep`, `find`, `ls`. |
| `model` | no | `provider/id` or a bare id, optionally with a `:<thinking>` suffix. |
| `thinking` | no | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. |

Sorvex ignores other fields, so agent files written for `pi-subagents` load too. A file without `name` or `description`, or with invalid YAML, is skipped. In interactive mode, Sorvex shows a warning for each skipped file at startup, and an unknown agent name lists the skipped files with the reason.

Sorvex reads agents from these places. When two agents have the same name, the later place wins:

1. The built-in agents.
2. User agents: `~/.sorvex/agent/agents/*.md`.
3. Project agents: `.sorvex/agents/*.md` in the current directory. Like other project resources, a parent directory's `.sorvex/agents` is not read.

Sorvex reads agent files each time the tool runs, so a new or changed file needs no `/reload`.

### Project agents and trust

Project agents come from the repository, so they are covered by [project trust](security.md#understand-project-trust). A `.sorvex/agents` directory makes Sorvex ask for a trust decision at startup.

- In a trusted project, project agents run without a prompt.
- In an untrusted project, Sorvex does not read the project's agents directory. Its agents are not listed, and their names and descriptions never reach the model. Trust the project with `/trust` and restart to use them.
