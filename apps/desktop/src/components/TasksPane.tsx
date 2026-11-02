import { ChevronRight, Play, Square, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, serverEvents } from "../api.ts";
import { PaneFrame, PaneHeader } from "./PaneFrame.tsx";

/** From server/tasks.ts. */
export interface TaskSummary {
	id: string;
	name: string;
	command: string;
	cwd: string;
	by: "agent" | "user";
	status: "running" | "exited" | "failed" | "stopped";
	exitCode: number | null;
	startedAt: number;
	endedAt: number | null;
	written: number;
}

/** Output kept per open task in the pane; older text is dropped. */
const OUTPUT_KEEP = 200_000;

/** The background task list, live: started by the agent's task_start, ended by exit or stop. */
export function useTasks(): TaskSummary[] {
	const [tasks, setTasks] = useState<TaskSummary[]>([]);
	useEffect(() => {
		const load = () => void api<TaskSummary[]>("GET", "/api/tasks").then(setTasks, () => undefined);
		load();
		const offOpen = serverEvents.onOpen(load);
		const offTasks = serverEvents.on<TaskSummary[]>("tasks", setTasks);
		return () => {
			offOpen();
			offTasks();
		};
	}, []);
	return tasks;
}

function elapsed(task: TaskSummary, now: number): string {
	const seconds = Math.max(0, Math.round(((task.endedAt ?? now) - task.startedAt) / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	return minutes < 60 ? `${minutes}m ${seconds % 60}s` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function TaskRow({ task, now, open, output, onToggle }: { task: TaskSummary; now: number; open: boolean; output: string | undefined; onToggle: () => void }) {
	const outputRef = useRef<HTMLPreElement>(null);
	const pinned = useRef(true);
	// Follow new output while scrolled to the bottom; leave the view alone once the user scrolls up.
	useEffect(() => {
		const element = outputRef.current;
		if (element && pinned.current) element.scrollTop = element.scrollHeight;
	}, [output]);
	const act = (path: string) => void api("POST", path, { id: task.id }).catch(() => undefined);
	return (
		<div className={`task-row ${task.status}${open ? " open" : ""}`}>
			<div className="task-head">
				<button type="button" className="task-toggle" aria-expanded={open} onClick={onToggle} title={task.command}>
					<ChevronRight size={13} className="chev" />
					<span className={`task-dot ${task.status}`} aria-hidden="true" />
					<span className="task-name">{task.name}</span>
					{task.status === "failed" && <span className="task-exit">exit {task.exitCode ?? "?"}</span>}
					{task.status === "stopped" && <span className="task-exit muted">stopped</span>}
					<span className="task-time">{elapsed(task, now)}</span>
				</button>
				{task.status === "running" ? (
					<button type="button" className="icon-btn sm" aria-label={`Stop ${task.name}`} title="Stop" onClick={() => act("/api/tasks/stop")}>
						<Square size={12} />
					</button>
				) : (
					<>
						<button type="button" className="icon-btn sm" aria-label={`Run ${task.name} again`} title="Run again" onClick={() => act("/api/tasks/restart")}>
							<Play size={13} />
						</button>
						<button type="button" className="icon-btn sm" aria-label={`Remove ${task.name}`} title="Remove" onClick={() => act("/api/tasks/remove")}>
							<X size={13} />
						</button>
					</>
				)}
			</div>
			{open && (
				<div className="task-body">
					<div className="task-command mono">
						<span className="task-prompt">$</span> {task.command}
					</div>
					<div className="task-cwd mono">{task.cwd}</div>
					<pre
						ref={outputRef}
						className="task-output"
						onScroll={(event) => {
							const element = event.currentTarget;
							pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
						}}
					>
						{output === undefined ? "Loading" : output || "No output yet."}
					</pre>
				</div>
			)}
		</div>
	);
}

/**
 * Background tasks, like Claude Code's: long-running commands the agent started with task_start (dev servers, app
 * builds). Running ones first, with live elapsed time and Stop; finished ones can run again or be removed. Opening a
 * task shows its command and live output.
 */
export function TasksPane({
	tasks,
	hidden,
	expanded,
	onToggleExpand,
	width,
	onResize,
	onClose,
}: {
	tasks: TaskSummary[];
	hidden: boolean;
	expanded: boolean;
	onToggleExpand: () => void;
	width: number;
	onResize: (width: number) => void;
	onClose: () => void;
}) {
	const [open, setOpen] = useState<Set<string>>(new Set());
	// undefined while an opened task's output is loading.
	const [outputs, setOutputs] = useState<Record<string, string | undefined>>({});
	const [finishedOpen, setFinishedOpen] = useState(true);
	const [now, setNow] = useState(Date.now());
	const openRef = useRef(open);
	openRef.current = open;

	const running = tasks.filter((task) => task.status === "running");
	const finished = tasks.filter((task) => task.status !== "running");

	useEffect(() => {
		if (hidden || running.length === 0) return;
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [hidden, running.length]);

	// Live output for the tasks that are open.
	useEffect(
		() =>
			serverEvents.on<{ id: string; text: string }>("task-output", ({ id, text }) => {
				if (!openRef.current.has(id)) return;
				setOutputs((current) => {
					const kept = current[id];
					return kept === undefined ? current : { ...current, [id]: (kept + text).slice(-OUTPUT_KEEP) };
				});
			}),
		[],
	);

	const toggle = (id: string) => {
		const next = new Set(open);
		if (next.has(id)) {
			next.delete(id);
		} else {
			next.add(id);
			setOutputs((current) => ({ ...current, [id]: undefined }));
			void api<{ text: string }>("POST", "/api/tasks/output", { id, since: 0 }).then(
				(result) => setOutputs((current) => ({ ...current, [id]: result.text.slice(-OUTPUT_KEEP) })),
				() => setOutputs((current) => ({ ...current, [id]: "" })),
			);
		}
		setOpen(next);
	};

	const row = (task: TaskSummary) => <TaskRow key={task.id} task={task} now={now} open={open.has(task.id)} output={outputs[task.id]} onToggle={() => toggle(task.id)} />;

	return (
		<PaneFrame expanded={expanded} width={width} onResize={onResize} hidden={hidden} className="tasks-pane">
			<PaneHeader
				expanded={expanded}
				onToggleExpand={onToggleExpand}
				onClose={onClose}
				actions={
					<button
						type="button"
						className="icon-btn sm"
						aria-label="Clear finished tasks"
						title="Clear finished"
						disabled={finished.length === 0}
						onClick={() => void api("POST", "/api/tasks/clear").catch(() => undefined)}
					>
						<Trash2 size={14} />
					</button>
				}
			>
				<span className="pane-title">Background tasks</span>
			</PaneHeader>
			<div className="pane-body tasks-body">
				{tasks.length === 0 && (
					<div className="tasks-empty">
						<p>No background tasks.</p>
						<small>When the agent starts a dev server, an app build or anything else that keeps running, it runs here instead of blocking the chat.</small>
					</div>
				)}
				{running.length > 0 && (
					<section className="tasks-group">
						<div className="tasks-group-head">Running {running.length}</div>
						{running.map(row)}
					</section>
				)}
				{finished.length > 0 && (
					<section className="tasks-group">
						<button type="button" className="tasks-group-head toggle" aria-expanded={finishedOpen} onClick={() => setFinishedOpen(!finishedOpen)}>
							<ChevronRight size={12} className={`chev${finishedOpen ? " open" : ""}`} />
							Finished {finished.length}
						</button>
						{finishedOpen && finished.map(row)}
					</section>
				)}
			</div>
		</PaneFrame>
	);
}
