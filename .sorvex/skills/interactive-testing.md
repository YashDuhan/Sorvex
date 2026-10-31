---
name: interactive-testing
description: Test and debug Sorvex's interactive mode in a controlled tmux terminal, or drive the real CLI against a scripted model with scripts/drive-live.mjs and scripts/drive-tui.mjs. Use for TUI behavior checks, live-lane verification, and interactive release smoke tests.
---

# Testing Sorvex Interactive Mode with tmux

Run the TUI in a controlled terminal (from the repo root, two directories above this skill):

```bash
tmux new-session -d -s sorvex-test -x 80 -y 24
tmux send-keys -t sorvex-test "./sorvex-test.sh" Enter
sleep 3 && tmux capture-pane -t sorvex-test -p     # capture after startup
tmux send-keys -t sorvex-test "your prompt here" Enter
tmux send-keys -t sorvex-test Escape               # special keys (also C-o for ctrl+o, etc.)
tmux kill-session -t sorvex-test
```

For release smoke tests, start the tmux session with `-c /tmp` and replace `./sorvex-test.sh` with the absolute path to the release binary. Test both Node and Bun binaries separately, submit a prompt, and wait for the model reply; startup alone is not a passing smoke test.

# Driving the CLI against a scripted model

Live lanes run the real CLI from source with a scripted model, so they spend no tokens and give the same transcript every run. A scenario is one JSON file in `packages/coding-agent/test/live/scenarios/`. Its types (`Scenario` and `TuiScenario`) live in `packages/coding-agent/test/live/scripted-provider.ts`. The fields:

- `mode`: `json`, `rpc`, `print`, or `tui`.
- `turns`: the model replies in order. Each is `{ text?, thinking?, toolCalls?: [{ name, args, expectError? }], error? }`. A request after the last turn fails the run, and so does a turn that was never requested. A tool call that returns an error also fails the run. Set `expectError: true` on a call that tests an error path, and the run then fails if that call succeeds.
- `prompts` (headless) or `steps` (tui): what the user sends.
- `args`: extra CLI arguments. `ls` is not a default tool, so scenarios that use it pass `["--tools", "ls,read"]`.
- `files`, `homeFiles`, `env`: fixtures written into the working directory and the temporary HOME, and extra environment (`null` unsets a variable).
- `uiAnswers` (rpc): answers for extension dialogs, consumed in order by method.
- `expectFiles` (headless): files that must contain a string after the run, for example to prove an `edit`.

Every run gets a fresh temporary HOME, agent dir, and working directory, and drops inherited `SORVEX_*` variables. The agent dir is `<home>/.sorvex/agent`, passed as `SORVEX_CODING_AGENT_DIR`. Add `--keep` to keep the directory, for example to read the session JSONL under its agent dir.

## Headless: `scripts/drive-live.mjs`

```bash
node scripts/drive-live.mjs packages/coding-agent/test/live/scenarios/ls.json --out /tmp/ls.txt
```

The driver writes one timestamped line per event, then `# result: PASS` or `# result: FAIL <reasons>`. It exits 1 when the CLI exits non-zero, a provider error occurs, a tool call fails without `expectError`, the script runs out, a turn goes unused, or an `expectFiles` check fails. It exits 2 for a bad scenario or option. `--root <checkout>` runs another checkout's CLI source with the same scenario. `--timeout <ms>` bounds the run (default 60000). On timeout the driver kills the CLI and every process it started, still writes the transcript, and reports a temp directory it cannot remove as `# leftover temp dir`.

- `json` and `print` close the CLI's stdin. Without that, `-p` waits for end of input.
- `rpc` sends each prompt as `{"type":"prompt","message":...}` after the previous `agent_settled`, and closes stdin after the last.

## Terminal: `scripts/drive-tui.mjs`

On Windows there is no tmux, and plain pipes fail because the CLI falls back to print mode without a TTY. The driver runs the CLI under `scripts/conpty-host.py` (Python standard library only, a Windows pseudo console), feeds the output into `@xterm/headless`, and dumps the whole screen to the output file after every step.

```bash
node scripts/drive-tui.mjs packages/coding-agent/test/live/scenarios/tui.json --out /tmp/tui.txt
```

Steps: `text`, `key` (`enter`, `escape`, `tab`, arrows, `ctrl+<letter>`, `alt+<letter>`, `ctrl+alt+<letter>`), `raw` (`bytes` sent as is), `resize`, `wait_for` (screen text), `sleep`, `expect_exit`. The driver passes `--approve` to skip the trust dialog. Deliver keys only through the driver. On Linux and macOS use tmux as above.

## Performance: `scripts/perf-probe.mjs`

```bash
node scripts/perf-probe.mjs <checkout-a> <checkout-b> packages/coding-agent/test/live/scenarios/ls.json 20
```

Runs the scenario alternately in both checkouts and prints median and p90 wall time from spawn to the last `agent_end`, plus peak RSS. Pass the same path twice to measure the probe's own noise.

## Unit test

```bash
node --test scripts/drive-live.test.mjs
```
