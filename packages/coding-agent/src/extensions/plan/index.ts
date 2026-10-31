import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/types.ts";
import { SUBAGENT_TOOL_NAME } from "../subagent/request.ts";
import { TODO_TOOL_NAME } from "../todo/state.ts";
import { planViolation, readOnlyToolNames, SHELL_TOOLS } from "./guard.ts";
import {
	BUILTIN_SUBAGENT_PATH,
	EXIT_PLAN_MODE_TOOL,
	isPlanSetRequest,
	isReadOnlyChild,
	PLAN_MODE_ENTRY,
	PLAN_MODE_EVENT,
	PLAN_OFF,
	PLAN_OFF_NOTICE,
	PLAN_ON_NOTICE,
	PLAN_SET_EVENT,
	PLAN_TRANSITION_EVENT,
	type PlanMode,
	type PlanTransition,
	planningTools,
	replayPlanMode,
} from "./state.ts";

const PLAN_SECTION = "plan_mode";
const STATUS_KEY = "plan";
const APPROVE = "Approve and start";
const KEEP_PLANNING = "Keep planning";
const EXIT = "Exit plan mode";

const PLAN_PROMPT = [
	"Plan mode is on. Explore the code and design a plan. Do not change anything yet.",
	"- Only read-only tools run. Tools that change files or other state, such as edit and write, are removed until the user approves a plan, and calls to them are blocked.",
	"- A shell command runs only when every command in it is read-only, such as ls, cat, rg, find, or git status, log, and diff.",
	"- When the plan is complete, call exit_plan_mode with the whole plan in Markdown: the goal, the steps in order, and the files each step changes. The user then approves it, asks for changes, or leaves plan mode.",
	"- Plan mode ends when exit_plan_mode reports that the user approved the plan or left plan mode. These rules do not apply after that.",
].join("\n");

const SUBAGENT_RULE =
	"- Agents started with the subagent tool follow the same rules: they get only read-only tools and read-only shell commands.";

const READ_ONLY_CHILD_PROMPT = [
	"Plan mode is on in the session that started you, so you are read-only. Do not change anything.",
	"- Only read-only tools run. Calls to other tools are blocked.",
	"- A shell command runs only when every command in it is read-only, such as ls, cat, rg, find, or git status, log, and diff.",
].join("\n");

function textResult(text: string, terminate = false) {
	return { content: [{ type: "text" as const, text }], details: undefined, terminate };
}

export default function planExtension(pi: ExtensionAPI): void {
	let mode: PlanMode = PLAN_OFF;

	const readOnlyTools = (): Set<string> => readOnlyToolNames(pi.getAllTools());

	// Only the built-in subagent tool knows to run its agents read-only. A replacement, such as
	// pi-subagents, stays blocked like any other tool that is not read-only.
	const hasBuiltinSubagent = (): boolean =>
		pi
			.getAllTools()
			.some((tool) => tool.name === SUBAGENT_TOOL_NAME && tool.sourceInfo.path === BUILTIN_SUBAGENT_PATH);

	// The saved tools plus the tools activated since planning narrowed them, such as tools registered
	// while planning.
	const loadout = (restoreTools: readonly string[]): string[] => {
		const planning = new Set(planningTools(restoreTools, readOnlyTools(), hasBuiltinSubagent()));
		return [...new Set([...restoreTools, ...pi.getActiveTools().filter((name) => !planning.has(name))])];
	};

	// A read-only child keeps only its read-only tools and shells. Registering a tool, such as an MCP
	// tool of a server that connects, reapplies the child's tool allowlist and activates its other tools
	// again, so the tools are narrowed before the first request and after every turn. The built-in MCP
	// extension loads before this one, so its before_agent_start handler, which waits for direct
	// servers and registers their tools, runs before the narrowing.
	const narrowReadOnlyChild = (): void => {
		const allowed = readOnlyTools();
		const active = pi.getActiveTools();
		const narrowed = active.filter((name) => allowed.has(name) || SHELL_TOOLS.has(name));
		if (narrowed.length !== active.length) pi.setActiveTools(narrowed);
	};

	// Narrowing the tools keeps the restored session's tools that have not registered yet, so they
	// activate when they register and are restored with the rest.
	const setTools = (toolNames: string[]): void => pi.setActiveTools(toolNames, { keepPendingTools: true });

	// Replaying a session entry only sets the tools; it does not write to the session.
	const apply = (ctx: ExtensionContext): void => {
		if (mode.kind === "planning") {
			mode = { kind: "planning", restoreTools: loadout(mode.restoreTools) };
			setTools(planningTools(mode.restoreTools, readOnlyTools(), hasBuiltinSubagent()));
		} else if (mode.kind === "ended") {
			setTools(loadout(mode.restoreTools));
		}
		ctx.ui.setStatus(STATUS_KEY, mode.kind === "planning" ? "plan" : undefined);
		pi.events.emit(PLAN_MODE_EVENT, mode);
	};

	const transition = (next: PlanMode, ctx: ExtensionContext): void => {
		mode = next;
		pi.appendEntry(PLAN_MODE_ENTRY, mode);
		apply(ctx);
		pi.events.emit(PLAN_TRANSITION_EVENT, { mode, ctx } satisfies PlanTransition);
	};

	const enter = (ctx: ExtensionContext): void => {
		if (mode.kind !== "planning") transition({ kind: "planning", restoreTools: pi.getActiveTools() }, ctx);
	};

	const leave = (ctx: ExtensionContext): void => {
		if (mode.kind === "planning") transition({ kind: "ended", restoreTools: loadout(mode.restoreTools) }, ctx);
	};

	const toggle = (ctx: ExtensionContext): void => {
		if (mode.kind !== "planning") {
			enter(ctx);
			ctx.ui.notify(PLAN_ON_NOTICE, "info");
		} else {
			leave(ctx);
			ctx.ui.notify(PLAN_OFF_NOTICE, "info");
		}
	};

	pi.events.on(PLAN_SET_EVENT, (request) => {
		if (!isPlanSetRequest(request)) return;
		if (request.planning) enter(request.ctx);
		else leave(request.ctx);
	});

	pi.registerFlag("plan", {
		description: "Start in plan mode: only read-only tools run until you approve a plan",
		type: "boolean",
		default: false,
	});

	pi.registerCommand("plan", {
		description: "Turn plan mode on or off",
		handler: async (_args, ctx) => toggle(ctx),
	});

	pi.registerShortcut(
		{ keybinding: "app.plan.toggle" },
		{
			description: "Turn plan mode on or off",
			handler: (ctx) => toggle(ctx),
		},
	);

	pi.registerTool({
		name: EXIT_PLAN_MODE_TOOL,
		label: "Exit plan mode",
		description:
			"Present the finished plan to the user. The user approves it, asks for changes, or leaves plan mode. Call it only in plan mode, once the plan is complete.",
		promptSnippet: "Present the finished plan to the user for approval",
		parameters: Type.Object({
			plan: Type.String({
				description: "The whole plan in Markdown: the goal, the steps in order, and the files each step changes",
			}),
		}),
		defaultActive: false,
		executionMode: "sequential",

		async execute(_toolCallId, { plan }, signal, _onUpdate, ctx) {
			if (mode.kind !== "planning") throw new Error("Plan mode is off.");
			if (!ctx.hasUI) return textResult(plan, true);

			const choice = await ctx.ui.select("Plan ready", [APPROVE, KEEP_PLANNING, EXIT], { message: plan, signal });
			if (choice === APPROVE) {
				const recordSteps = mode.restoreTools.includes(TODO_TOOL_NAME)
					? "Record the plan's steps with todo, then start the first step."
					: "Start the first step.";
				leave(ctx);
				return textResult(`The user approved the plan. Plan mode is off. ${recordSteps}`);
			}
			if (choice === EXIT) {
				leave(ctx);
				return textResult("The user left plan mode without approving the plan. Do not start it.", true);
			}
			if (choice === KEEP_PLANNING) {
				const feedback = (await ctx.ui.input("What should change in the plan?", undefined, { signal }))?.trim();
				if (feedback) {
					return textResult(
						`The user wants changes before approving. Plan mode stays on.\n\nFeedback: ${feedback}\n\nRevise the plan and call exit_plan_mode again.`,
					);
				}
			}
			return textResult("The user did not approve the plan. Plan mode stays on. Ask what to change.", true);
		},
	});

	pi.on("tool_call", async (event, ctx) => {
		// A subagent of a planning session. Its own plan mode, on or off, does not lift these rules.
		if (isReadOnlyChild(ctx.sessionManager.getBranch())) {
			const violation = planViolation(event, readOnlyTools());
			if (!violation) return;
			const blocked =
				violation.kind === "command"
					? `This command is not read-only, so it did not run: ${violation.command}`
					: `${violation.toolName} is not read-only, so it did not run.`;
			return {
				block: true,
				reason: `Plan mode is on in the parent session, so this agent is read-only. ${blocked}`,
			};
		}
		if (mode.kind !== "planning") return;
		if (event.toolName === TODO_TOOL_NAME || event.toolName === EXIT_PLAN_MODE_TOOL) return;
		if (event.toolName === SUBAGENT_TOOL_NAME && hasBuiltinSubagent()) return;
		const violation = planViolation(event, readOnlyTools());
		if (!violation) return;
		return {
			block: true,
			reason:
				violation.kind === "command"
					? `Plan mode: this command is not read-only, so it did not run: ${violation.command}\nUse read-only commands, or call exit_plan_mode with your plan.`
					: `Plan mode: ${violation.toolName} is not read-only, so it did not run. Explore with read-only tools, then call exit_plan_mode with your plan.`,
		};
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const sections = event.systemPromptOptions.sections;
		if (isReadOnlyChild(ctx.sessionManager.getBranch())) {
			narrowReadOnlyChild();
			sections[PLAN_SECTION] = READ_ONLY_CHILD_PROMPT;
		} else if (mode.kind === "planning") {
			sections[PLAN_SECTION] = hasBuiltinSubagent() ? `${PLAN_PROMPT}\n${SUBAGENT_RULE}` : PLAN_PROMPT;
		}
	});

	pi.on("turn_end", async (_event, ctx) => {
		if (isReadOnlyChild(ctx.sessionManager.getBranch())) narrowReadOnlyChild();
	});

	pi.on("session_start", async (event, ctx) => {
		mode = replayPlanMode(ctx.sessionManager.getBranch());
		apply(ctx);
		if (event.reason === "startup" && pi.getFlag("plan") === true) enter(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		mode = replayPlanMode(ctx.sessionManager.getBranch());
		apply(ctx);
	});
}
