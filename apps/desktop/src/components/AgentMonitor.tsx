import { Bot, Check, ChevronDown, ChevronRight, Clock, CornerDownLeft, Loader, Minus, Monitor, Square, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { compactNumber, duration } from "../format.ts";
import { collectRuns, type MonitorRun } from "../monitor.ts";
import type { SorvexActions, State } from "../store.ts";
import { Markdown } from "./Markdown.tsx";

export { collectRuns };

const STATUS_ICON = {
	pending: <Clock size={13} color="var(--text-muted)" />,
	running: <Loader size={13} className="spin" color="var(--accent-blue)" />,
	done: <Check size={13} color="var(--accent-green-icon)" />,
	failed: <X size={13} color="var(--accent-red)" />,
	aborted: <Minus size={13} color="var(--text-muted)" />,
};

function RunRow({ run, now, state, actions }: { run: MonitorRun; now: number; state: State; actions: SorvexActions }) {
	const [open, setOpen] = useState(false);
	const active = run.status === "running" || run.status === "pending";
	const elapsed = duration(Math.max(0, (active ? now : run.startedAt + 0) - run.startedAt));
	const stop = () => {
		if (run.foreground) {
			void actions.abort();
		} else if (run.backgroundId) {
			// Cancelling a background run is a subagent-tool action, so the agent is asked to do it.
			void actions.send(`Cancel background subagent run ${run.backgroundId} now: call the subagent tool with action "cancel" and id "${run.backgroundId}".`, state.isStreaming);
		}
	};
	return (
		<div className={`monitor-run ${run.status}`}>
			<div className="monitor-run-head">
				<button type="button" className="icon-btn sm" aria-label={open ? "Collapse" : "Expand"} onClick={() => setOpen(!open)}>
					{open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
				</button>
				{STATUS_ICON[run.status]}
				<Bot size={13} color="var(--text-tertiary)" />
				<span className="monitor-agent">{run.agent}</span>
				<span className="monitor-task" title={run.task}>
					{run.task}
				</span>
				{run.backgroundId && <span className="mcp-badge">bg {run.backgroundId}</span>}
				<span className="monitor-meta">
					{run.turns} turn{run.turns === 1 ? "" : "s"} · {compactNumber(run.usage?.totalTokens ?? 0)} tok{active ? ` · ${elapsed}` : ""}
				</span>
				{active && (run.foreground || run.backgroundId) && (
					<button
						type="button"
						className="icon-btn sm danger-icon"
						title={run.foreground ? "Stop (aborts the agent's current run)" : "Ask the agent to cancel this background run"}
						aria-label={`Stop ${run.agent}`}
						onClick={stop}
					>
						<Square size={11} />
					</button>
				)}
				{run.status === "done" && run.output && (
					<button
						type="button"
						className="icon-btn sm"
						title="Quote the result in the composer"
						aria-label={`Quote ${run.agent} result`}
						onClick={() => actions.setComposerText(`Result from the ${run.agent} subagent:\n${run.output}\n\n`, true)}
					>
						<CornerDownLeft size={12} />
					</button>
				)}
			</div>
			{open && (
				<div className="monitor-run-body">
					<div className="tool-section-label">Task</div>
					<div className="monitor-text">{run.task}</div>
					{run.toolCalls && run.toolCalls.length > 0 && (
						<>
							<div className="tool-section-label">Activity ({run.toolCalls.length} tool calls)</div>
							<div className="monitor-calls">
								{run.toolCalls.slice(-30).map((call, index) => (
									<div key={index} className="tool-child">
										<span className="tool-name">{call.name}</span>
										<span className="tool-summary">{call.summary}</span>
									</div>
								))}
							</div>
						</>
					)}
					{run.output && (
						<>
							<div className="tool-section-label">{run.status === "failed" ? "Error" : "Result"}</div>
							<div className="monitor-output">
								<Markdown text={run.output} />
							</div>
						</>
					)}
					{run.model && <div className="panel-note">Model: {run.model}</div>}
				</div>
			)}
		</div>
	);
}

/**
 * Live view of the session's subagents, like warpdrv's Agent Monitor: status, turns, tokens and elapsed time
 * per run, the child's tool activity, its result, and Stop.
 */
export function AgentMonitor({ state, actions, open, onClose }: { state: State; actions: SorvexActions; open: boolean; onClose: () => void }) {
	const runs = useMemo(() => collectRuns(state), [state]);
	const active = runs.filter((run) => run.status === "running" || run.status === "pending").length;
	const [now, setNow] = useState(Date.now());
	useEffect(() => {
		if (active === 0) return;
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [active]);

	if (!open) return null;
	const done = runs.filter((run) => run.status === "done").length;
	const failed = runs.filter((run) => run.status === "failed").length;
	return (
		<div className="monitor-box">
			<div className="monitor-head">
				<Monitor size={13} color="var(--text-tertiary)" />
				<span className="monitor-title">Agent Monitor</span>
				{runs.length > 0 && (
					<span className="monitor-counts">
						{active > 0 && <span className="running">{active} running</span>}
						{done > 0 && <span>{done} done</span>}
						{failed > 0 && <span className="failed">{failed} failed</span>}
					</span>
				)}
				<span className="grow" />
				<button type="button" className="icon-btn sm" aria-label="Close agent monitor" onClick={onClose}>
					<X size={12} />
				</button>
			</div>
			<div className="monitor-body">
				{runs.length === 0 ? (
					<div className="empty-note">No subagents in this session yet. They appear here when the agent delegates work.</div>
				) : (
					runs.map((run) => <RunRow key={run.id} run={run} now={now} state={state} actions={actions} />)
				)}
			</div>
		</div>
	);
}
