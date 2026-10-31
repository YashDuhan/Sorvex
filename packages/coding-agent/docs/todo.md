# Todo list

Sorvex has a built-in task list. The model uses it to plan multi-step work and to show progress, and you see it above the editor.

The list comes from the `todo` tool, which the built-in `todo` extension registers. It is active by default. Disable it with `"extensions": ["-builtin:todo"]` in [settings](settings.md#resources). An extension that registers the `todo` tool or the `/todos` command replaces it.

## See the list

While a list exists, Sorvex shows a widget above the editor:

```text
Todos (1/3)
✓ #1 Write parser
◐ #2 Writing tests
○ #3 Update docs (blocked by #2)
```

The header counts completed tasks over all tasks that are not deleted. `✓` is completed, `◐` is in progress, and `○` is pending. A task in progress shows its `activeForm` label, such as "Writing tests", when the model set one. A task shows `blocked by` while a task it waits on is not completed.

- `app.todos.toggle` (default `alt+t`) collapses the widget to one line and expands it again. Rebind it in [keybindings](keybindings.md).
- `/todos` prints the list grouped by status.
- When every task is completed, the widget stays for the rest of that turn and disappears when the next turn starts. It comes back when the model adds or changes a task.
- When the list does not fit in `todo.widgetMaxLines` lines (see [settings](settings.md#todo-list)), completed tasks are dropped first, then later tasks, and the last line counts the tasks that are hidden.

In RPC mode the same lines arrive as a `setWidget` request with the key `todos`. See [RPC extension UI](rpc-extension-ui.md).

## What the model can do

The `todo` tool takes an `action`.

| Action | Fields | Effect |
|---|---|---|
| `create` | `subject` or `tasks`, plus `description`, `activeForm`, `blockedBy` | Adds one task, or every item of `tasks` at once. New tasks are `pending`. A task in `tasks` may be blocked by earlier items of the same call. |
| `update` | `id`, plus `status`, `subject`, `description`, `activeForm`, `addBlockedBy`, `removeBlockedBy` | Changes a task. An update that changes nothing answers `No change`. |
| `list` | `status`, `includeDeleted` | Lists tasks. Deleted tasks are hidden unless `includeDeleted` is `true`. |
| `get` | `id` | Shows one task with the tasks it blocks. |
| `delete` | `id` | Marks a task `deleted`. |
| `clear` | none | Removes every task and restarts ids at 1. |

Status moves follow this table. Setting a task to its current status is allowed and changes nothing.

| From | To |
|---|---|
| `pending` | `in_progress`, `completed`, `deleted` |
| `in_progress` | `pending`, `completed`, `deleted` |
| `completed` | `deleted` |
| `deleted` | none |

A `blockedBy` entry must name an existing task that is not deleted, or an earlier task of the same `create` call. A task cannot block itself, and `addBlockedBy` is rejected when it would close a cycle. The error names the cycle, for example `addBlockedBy would create a cycle: #2 -> #1 -> #2`. A rejected call is an error result and changes nothing.

### Dependencies within one `create` call

A task in a `tasks` batch may be blocked by earlier tasks of the same call. Ids are assigned in order, starting at the next free id (1 in a new list), so the model names an earlier task by the id it will get:

```json
{"action": "create", "tasks": [
  {"subject": "Write parser"},
  {"subject": "Write tests", "blockedBy": [1]},
  {"subject": "Update docs", "blockedBy": [1, 2]}
]}
```

A list that already holds tasks continues the numbering, so the first new task is `#4` after `#1` to `#3`. `blockedBy` can mix existing ids and ids of earlier tasks in the call. The result lists each new task with its blockers, such as `Created #2: Write tests (pending, blocked by #1)`.

A batch that names the task itself or a later task of the call is rejected, for example `task 1: blockedBy #2 comes later in this call; list prerequisites first`. Because a task can only wait on earlier ones, a batch cannot contain a cycle.

## How the list is stored

The list is stored only in the `details` of `todo` tool results. Each call that changes the list stores the full list there. Calls that read the list or change nothing store nothing.

Sorvex rebuilds the list from the current branch when a session starts or resumes, after `/tree`, and after compaction, using the last stored list on the branch. Branching with `/tree` or `/fork` therefore shows the list as it was at that point. Sorvex keeps no other copy of the list.

## What the model sees after compaction or resume

Compaction replaces old messages, including earlier `todo` results, with a summary. To keep the list in view, the extension adds a `todos` system prompt section, through the `before_agent_start` event described in [extensions](extensions.md), that lists the open tasks, at two moments only:

- when a session starts or resumes, and
- when compaction finishes. Compaction in the middle of a run, at the context threshold, updates the section through the `session_compact` event, so the run's next turn already has it.

The text of the section is fixed at that moment and stays the same on later turns, so ordinary turns do not change the prompt and do not invalidate the provider cache. Later `todo` results supersede it. With no open tasks there is no section. After `/tree`, the section is refreshed only if it was already set.
