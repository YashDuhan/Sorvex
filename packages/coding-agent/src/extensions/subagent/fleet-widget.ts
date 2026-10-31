import type { ExtensionUIContext } from "../../core/extensions/types.ts";
import { formatTokens } from "./render.ts";
import type { ChildRun } from "./run.ts";

export const FLEET_WIDGET_KEY = "subagent-fleet";
const REFRESH_MS = 1000;

function formatElapsed(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m${(seconds % 60).toString().padStart(2, "0")}s`;
	return `${Math.floor(minutes / 60)}h${(minutes % 60).toString().padStart(2, "0")}m`;
}

/** One line per running child: its run id, agent, time since it started, and tokens so far. */
export function fleetLines(runs: readonly ChildRun[], now: number): string[] {
	return runs
		.filter((run) => run.status === "running")
		.map((run) => {
			const tokens = run.usage.totalTokens > 0 ? ` · ${formatTokens(run.usage.totalTokens)} tokens` : "";
			const fork = run.context === "fork" ? " (fork)" : "";
			return `⏳ subagent ${run.id} ${run.agent}${fork} · ${formatElapsed(now - run.startedAt)}${tokens}`;
		});
}

/**
 * The widget below the editor that lists running background children. It redraws every second
 * while a child runs, so the elapsed times advance, and disappears when none runs.
 */
export class FleetWidget {
	private ui: ExtensionUIContext | undefined;
	private timer: ReturnType<typeof setInterval> | undefined;
	private readonly getRuns: () => ChildRun[];

	constructor(getRuns: () => ChildRun[]) {
		this.getRuns = getRuns;
	}

	/** Redraw with the current runs, on `ui` from now on. */
	update(ui: ExtensionUIContext): void {
		this.ui = ui;
		const lines = fleetLines(this.getRuns(), Date.now());
		ui.setWidget(FLEET_WIDGET_KEY, lines.length > 0 ? lines : undefined, { placement: "belowEditor" });
		if (lines.length > 0 && !this.timer) {
			this.timer = setInterval(() => {
				if (this.ui) this.update(this.ui);
			}, REFRESH_MS);
			this.timer.unref?.();
		} else if (lines.length === 0) {
			this.stop();
		}
	}

	/** Stop redrawing and remove the widget. */
	clear(): void {
		this.stop();
		this.ui?.setWidget(FLEET_WIDGET_KEY, undefined, { placement: "belowEditor" });
	}

	private stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
	}
}
