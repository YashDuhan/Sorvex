import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/types.ts";
import {
	BUILTIN_PLAN_PATH,
	BUILTIN_SUBAGENT_PATH,
	isPlanTransition,
	PLAN_ON_NOTICE,
	PLAN_SET_EVENT,
	PLAN_TRANSITION_EVENT,
	type PlanSetRequest,
	replayPlanMode,
} from "../plan/state.ts";
import { SUBAGENT_TOOL_NAME } from "../subagent/request.ts";
import {
	AGENT_MODE_FLAG,
	isPrimaryMode,
	MODE_ENTRY,
	MODE_EVENT,
	MODE_STATUS_KEY,
	MODES,
	modeDescription,
	nextPrimaryMode,
	type OwnedMode,
	PRIMARY_MODES,
	type PrimaryMode,
	parseAgentMode,
	replayOwnedMode,
	SECURITY_MODE,
	sectionName,
	unknownAgentModeMessage,
} from "./state.ts";

/**
 * Switches between the primary modes. This extension records build and security mode; plan mode
 * stays with the plan extension, which this one asks to turn on or off over the event bus. Plan
 * mode turning on ends the owned mode, so the current mode is `plan` when planning and the owned
 * mode otherwise.
 */
export default function modesExtension(pi: ExtensionAPI): void {
	let owned: OwnedMode = "build";
	// Mirrors plan mode. Stays false when the built-in plan extension is not loaded.
	let planning = false;
	// The mode last emitted on MODE_EVENT. Undefined until the session starts.
	let announced: PrimaryMode | undefined;

	const current = (): PrimaryMode => (planning ? "plan" : owned);

	// Only the built-in plan extension answers requests to turn plan mode on or off.
	const planAvailable = (): boolean =>
		pi.getCommands().some((command) => command.name === "plan" && command.sourceInfo.path === BUILTIN_PLAN_PATH);

	const hasBuiltinSubagent = (): boolean =>
		pi.getActiveTools().includes(SUBAGENT_TOOL_NAME) &&
		pi
			.getAllTools()
			.some((tool) => tool.name === SUBAGENT_TOOL_NAME && tool.sourceInfo.path === BUILTIN_SUBAGENT_PATH);

	// Every change to the mode ends here, so MODE_EVENT carries each new mode exactly once.
	const sync = (ctx: ExtensionContext): void => {
		ctx.ui.setStatus(MODE_STATUS_KEY, planning ? undefined : MODES[owned].label);
		const mode = current();
		if (mode === announced) return;
		announced = mode;
		pi.events.emit(MODE_EVENT, mode);
	};

	// Both modes come from the branch, so the order in which this and the plan extension replay does not matter.
	// Replaying does not write to the session.
	const replay = (ctx: ExtensionContext): void => {
		const branch = ctx.sessionManager.getBranch();
		owned = replayOwnedMode(branch);
		planning = planAvailable() && replayPlanMode(branch).kind === "planning";
	};

	const setOwned = (next: OwnedMode): void => {
		if (next === owned) return;
		owned = next;
		pi.appendEntry(MODE_ENTRY, { mode: owned });
	};

	const setPlanning = (next: boolean, ctx: ExtensionContext): void => {
		if (next !== planning) pi.events.emit(PLAN_SET_EVENT, { planning: next, ctx } satisfies PlanSetRequest);
	};

	// The owned mode changes before plan mode, so the plan transition announces the final mode.
	const switchTo = (target: PrimaryMode, ctx: ExtensionContext, notify = true): void => {
		if (target === "plan") {
			if (!planAvailable()) {
				ctx.ui.notify("Plan mode is not available: the built-in plan extension is not loaded.", "error");
				return;
			}
			setOwned("build");
			setPlanning(true, ctx);
		} else {
			setOwned(target);
			// Leaving plan mode this way is the same as /plan off: the saved tools come back.
			setPlanning(false, ctx);
		}
		sync(ctx);
		if (notify) ctx.ui.notify(planning ? PLAN_ON_NOTICE : MODES[owned].notice, "info");
	};

	// Plan mode turning on or off, through /plan, its key, exit_plan_mode, or a plan:set request.
	// Replaying does not emit this event. Plan mode turning on ends the owned mode.
	pi.events.on(PLAN_TRANSITION_EVENT, (transition) => {
		if (!isPlanTransition(transition)) return;
		planning = transition.mode.kind === "planning";
		if (planning) setOwned("build");
		sync(transition.ctx);
	});

	pi.registerFlag(AGENT_MODE_FLAG, {
		description: `Start in a mode: ${PRIMARY_MODES.join(", ")}`,
		type: "string",
	});

	pi.registerCommand("mode", {
		description: `Switch mode: ${PRIMARY_MODES.join(", ")}`,
		getArgumentCompletions: (prefix) =>
			PRIMARY_MODES.filter((name) => name.startsWith(prefix.trim())).map((name) => ({
				value: name,
				label: name,
				description: modeDescription(name),
			})),
		handler: async (args, ctx) => {
			const requested = args.trim().toLowerCase();
			if (requested) {
				if (isPrimaryMode(requested)) switchTo(requested, ctx);
				else ctx.ui.notify(`Unknown mode "${requested}". Use ${PRIMARY_MODES.join(", ")}.`, "error");
				return;
			}
			const mode = current();
			if (!ctx.hasUI) {
				ctx.ui.notify(`Mode: ${mode}`, "info");
				return;
			}
			const labels = PRIMARY_MODES.map(
				(name) => `${name}${name === mode ? " (current)" : ""}: ${modeDescription(name)}`,
			);
			const target = PRIMARY_MODES[labels.indexOf((await ctx.ui.select("Mode", labels)) ?? "")];
			if (target && target !== mode) switchTo(target, ctx);
		},
	});

	pi.registerCommand(SECURITY_MODE, {
		description: `Turn ${SECURITY_MODE} mode on or off`,
		handler: async (_args, ctx) => switchTo(current() === SECURITY_MODE ? "build" : SECURITY_MODE, ctx),
	});

	pi.registerShortcut(
		{ keybinding: "app.mode.cycle" },
		{
			description: `Switch to the next mode: ${PRIMARY_MODES.join(", ")}`,
			handler: (ctx) => {
				const next = nextPrimaryMode(current());
				// Without the built-in plan extension, cycling skips plan mode.
				switchTo(next === "plan" && !planAvailable() ? nextPrimaryMode(next) : next, ctx);
			},
		},
	);

	pi.on("before_agent_start", async (event) => {
		if (planning) return;
		const spec = MODES[owned];
		if (!spec.prompt) return;
		event.systemPromptOptions.sections[sectionName(owned)] =
			spec.subagentPrompt && hasBuiltinSubagent() ? `${spec.prompt}\n${spec.subagentPrompt}` : spec.prompt;
	});

	pi.on("session_start", async (event, ctx) => {
		replay(ctx);
		const flag = pi.getFlag(AGENT_MODE_FLAG);
		if (event.reason === "startup" && typeof flag === "string" && flag) {
			const requested = parseAgentMode(flag);
			if (requested) switchTo(requested, ctx, false);
			else ctx.ui.notify(unknownAgentModeMessage(flag), "error");
		}
		sync(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		replay(ctx);
		sync(ctx);
	});
}
