import { homedir } from "node:os";
import { sep } from "node:path";
import type { Usage } from "@sorvex/ai";
import { type Component, Container, Markdown, Spacer, Text } from "@sorvex/tui";
import { combineUsage } from "../../core/usage-totals.ts";
import { getMarkdownTheme, type Theme } from "../../modes/interactive/theme/theme.ts";
import type { AgentDiscovery, AgentSource } from "./agents.ts";
import { PREVIOUS_PLACEHOLDER, type SubagentParamsInput, type TaskSpec } from "./request.ts";
import { type ChildRun, EMPTY_USAGE, type SubagentDetails } from "./run.ts";

/** How much of a run the collapsed view shows: a single run gets more room than each run of several. */
interface CollapsedLimits {
	toolCalls: number;
	outputLines: number;
}

const SINGLE_COLLAPSED: CollapsedLimits = { toolCalls: 10, outputLines: 3 };
const MULTI_COLLAPSED: CollapsedLimits = { toolCalls: 3, outputLines: 1 };
const CALL_PREVIEW_ITEMS = 3;
const READ_ONLY_MARKER = "read-only (plan mode)";

export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

export function formatUsage(usage: Usage, turns: number, model: string | undefined): string {
	const parts: string[] = [];
	if (turns) parts.push(`${turns} turn${turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost.total) parts.push(`$${usage.cost.total.toFixed(4)}`);
	if (model) parts.push(model);
	return parts.join(" ");
}

function preview(task: string | undefined, limit: number): string {
	if (!task) return "...";
	return task.length > limit ? `${task.slice(0, limit)}...` : task;
}

function contextMarker(context: TaskSpec["context"], theme: Theme): string {
	return context === "fork" ? theme.fg("muted", " (fork)") : "";
}

function renderItems(
	label: string,
	items: Partial<TaskSpec>[],
	numbered: boolean,
	background: boolean,
	theme: Theme,
): Component {
	let text = theme.fg("toolTitle", theme.bold("subagent ")) + theme.fg("muted", label);
	if (background) text += theme.fg("muted", " in background");
	for (const [index, item] of items.slice(0, CALL_PREVIEW_ITEMS).entries()) {
		const task = numbered ? item.task?.replaceAll(PREVIOUS_PLACEHOLDER, "").trim() : item.task;
		const number = numbered ? `${theme.fg("muted", `${index + 1}.`)} ` : "";
		const agent = theme.fg("toolTitle", theme.bold(item.agent || "...")) + contextMarker(item.context, theme);
		text += `\n  ${number}${agent}${theme.fg("muted", ` ${preview(task, 40)}`)}`;
	}
	if (items.length > CALL_PREVIEW_ITEMS) {
		text += `\n  ${theme.fg("muted", `... +${items.length - CALL_PREVIEW_ITEMS} more`)}`;
	}
	return new Text(text, 0, 0);
}

/** Arguments may be partial while the call streams in. */
export function renderSubagentCall(args: Partial<SubagentParamsInput>, theme: Theme): Component {
	if (args.action) {
		const id = args.id ? ` ${args.id}` : "";
		return new Text(theme.fg("toolTitle", theme.bold("subagent ")) + theme.fg("muted", `${args.action}${id}`), 0, 0);
	}
	const background = args.background === true;
	if (args.chain) return renderItems(`chain (${args.chain.length} steps)`, args.chain, true, background, theme);
	if (args.tasks) return renderItems(`parallel (${args.tasks.length} tasks)`, args.tasks, false, background, theme);
	let text = theme.fg("toolTitle", theme.bold("subagent ")) + theme.fg("toolTitle", theme.bold(args.agent || "..."));
	text += contextMarker(args.context, theme);
	if (args.cwd) text += theme.fg("muted", ` in ${args.cwd}`);
	if (background) text += theme.fg("muted", " in background");
	text += `\n  ${theme.fg("muted", preview(args.task, 60))}`;
	return new Text(text, 0, 0);
}

function statusIcon(run: ChildRun, theme: Theme): string {
	switch (run.status) {
		case "pending":
			return theme.fg("muted", "·");
		case "running":
			return theme.fg("warning", "⏳");
		case "done":
			return theme.fg("success", "✓");
		case "failed":
		case "aborted":
			return theme.fg("error", "✗");
	}
}

function toolCallLine(call: ChildRun["toolCalls"][number], theme: Theme): string {
	return `${theme.fg("muted", "→ ")}${theme.fg("toolTitle", theme.bold(call.name))} ${theme.fg("muted", call.summary)}`;
}

function emptyOutput(run: ChildRun): string {
	return run.status === "pending" ? "(not started)" : "(running...)";
}

function renderRun(run: ChildRun, expanded: boolean, limits: CollapsedLimits, theme: Theme): Component {
	const failed = run.status === "failed" || run.status === "aborted";
	const source = run.context === "fork" ? `${run.source}, fork` : run.source;
	let header = `${statusIcon(run, theme)} ${theme.fg("toolTitle", theme.bold(run.agent))}${theme.fg("muted", ` (${source})`)}`;
	if (failed) header += ` ${theme.fg("error", `[${run.status}]`)}`;
	const usage = formatUsage(run.usage, run.turns, run.model);

	if (expanded) {
		const container = new Container();
		container.addChild(new Text(header, 0, 0));
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
		container.addChild(new Text(theme.fg("muted", run.task), 0, 0));
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
		for (const call of run.toolCalls) container.addChild(new Text(toolCallLine(call, theme), 0, 0));
		if (failed) container.addChild(new Text(theme.fg("error", run.output), 0, 0));
		else if (run.output) {
			container.addChild(new Spacer(1));
			container.addChild(new Markdown(run.output.trim(), 0, 0, getMarkdownTheme()));
		} else container.addChild(new Text(theme.fg("muted", emptyOutput(run)), 0, 0));
		if (usage) {
			container.addChild(new Spacer(1));
			container.addChild(new Text(theme.fg("dim", usage), 0, 0));
		}
		return container;
	}

	let text = header;
	const calls = run.toolCalls.slice(-limits.toolCalls);
	const skipped = run.toolCalls.length - calls.length;
	if (skipped > 0) text += `\n${theme.fg("muted", `... ${skipped} earlier tool calls`)}`;
	for (const call of calls) text += `\n${toolCallLine(call, theme)}`;
	if (failed) text += `\n${theme.fg("error", run.output)}`;
	else if (run.output) {
		text += `\n${theme.fg("toolOutput", run.output.split("\n").slice(0, limits.outputLines).join("\n"))}`;
	} else text += `\n${theme.fg("muted", emptyOutput(run))}`;
	if (usage) text += `\n${theme.fg("dim", usage)}`;
	return new Text(text, 0, 0);
}

export function renderSubagentResult(
	details: SubagentDetails | undefined,
	fallbackText: string,
	expanded: boolean,
	theme: Theme,
): Component {
	if (!details || details.runs.length === 0) return new Text(fallbackText, 0, 0);
	const container = new Container();
	const { background } = details;
	if (background) {
		// The call that starts a run has nothing to show but the run id. A follow-up has no action.
		const started = !background.action && background.status === "running";
		const label = background.action
			? `${background.action}: ${background.status}`
			: started
				? "started"
				: background.status;
		container.addChild(new Text(theme.fg("muted", `background run ${background.id} ${label}`), 0, 0));
		if (started) return container;
	}
	if (details.readOnly) container.addChild(new Text(theme.fg("warning", READ_ONLY_MARKER), 0, 0));
	if (details.kind === "single") {
		container.addChild(renderRun(details.runs[0], expanded, SINGLE_COLLAPSED, theme));
		return container;
	}

	const { runs } = details;
	const done = runs.filter((run) => run.status === "done").length;
	const failed = runs.filter((run) => run.status === "failed" || run.status === "aborted").length;
	let summary = theme.fg("muted", `${details.kind}: ${done}/${runs.length} done`);
	if (failed) summary += theme.fg("error", `, ${failed} failed`);
	container.addChild(new Text(summary, 0, 0));
	for (const [index, run] of runs.entries()) {
		container.addChild(new Spacer(1));
		if (details.kind === "chain") container.addChild(new Text(theme.fg("muted", `Step ${index + 1}`), 0, 0));
		container.addChild(renderRun(run, expanded, MULTI_COLLAPSED, theme));
	}
	const turns = runs.reduce((total, run) => total + run.turns, 0);
	const usage = formatUsage(
		runs.reduce((total, run) => combineUsage(total, run.usage), EMPTY_USAGE),
		turns,
		undefined,
	);
	if (usage) {
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("dim", `Total: ${usage}`), 0, 0));
	}
	return container;
}

const SOURCE_TITLES: Record<AgentSource, string> = {
	builtin: "Built-in agents",
	user: "User agents",
	project: "Project agents",
};

function tildify(filePath: string): string {
	const home = homedir();
	if (filePath === home) return "~";
	return filePath.startsWith(home + sep) ? `~${filePath.slice(home.length)}` : filePath;
}

/** The `/agents` listing: the agents the tool resolves, grouped by where each comes from. */
export function formatAgentList(discovery: AgentDiscovery, projectTrusted: boolean): string {
	const dirs: Record<AgentSource, string | undefined> = {
		builtin: undefined,
		user: discovery.userAgentsDir,
		project: discovery.projectAgentsDir,
	};
	const sections: string[] = [];
	for (const source of ["builtin", "user", "project"] as const) {
		const agents = discovery.agents.filter((agent) => agent.source === source);
		const dir = dirs[source];
		if (source === "project" && !dir) {
			if (!projectTrusted) sections.push(`${SOURCE_TITLES.project}: not read, because the project is not trusted.`);
			continue;
		}
		let title = SOURCE_TITLES[source];
		if (dir) title += ` (${tildify(dir)})`;
		const lines = agents.map((agent) => {
			const file = agent.filePath ? `\n    ${tildify(agent.filePath)}` : "";
			return `  ${agent.name}: ${agent.description}${file}`;
		});
		sections.push([title, ...(lines.length > 0 ? lines : ["  (none)"])].join("\n"));
	}
	if (discovery.diagnostics.length > 0) {
		const lines = discovery.diagnostics.map((diagnostic) => `  ${tildify(diagnostic.path)}: ${diagnostic.message}`);
		sections.push(["Skipped agent files", ...lines].join("\n"));
	}
	return sections.join("\n\n");
}
