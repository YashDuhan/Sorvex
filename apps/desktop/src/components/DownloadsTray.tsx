import { CheckCircle2, ChevronDown, ChevronUp, CircleAlert, Download, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, serverEvents } from "../api.ts";

interface DownloadTask {
	task: string;
	label: string;
	state: "running" | "done" | "failed";
	message: string;
	ratio?: number;
	done?: number;
	total?: number;
	error?: string;
	startedAt: number;
}

function bytes(value: number): string {
	return value >= 1e9 ? `${(value / 1e9).toFixed(2)} GB` : value >= 1e6 ? `${(value / 1e6).toFixed(1)} MB` : `${Math.round(value / 1e3)} KB`;
}

/**
 * Decimals for the percentage, so its last digit keeps moving: about 2 when the download is fast, up to 4 when slow.
 * `ratePerSecond` is the share of the file per second (0.01 = 1%/s); the display updates about 4 times a second.
 */
function decimals(ratePerSecond: number): number {
	const step = ratePerSecond * 100 * 0.25;
	if (!(step > 0)) return 2;
	return Math.min(4, Math.max(2, Math.ceil(-Math.log10(step))));
}

function duration(seconds: number): string {
	if (!Number.isFinite(seconds) || seconds < 0) return "";
	if (seconds < 60) return `${Math.ceil(seconds)}s left`;
	if (seconds < 3600) return `${Math.ceil(seconds / 60)} min left`;
	return `${Math.floor(seconds / 3600)} h ${Math.ceil((seconds % 3600) / 60)} min left`;
}

/**
 * Downloads in the bottom-right corner, on every page: the llama.cpp engine install and model downloads, with
 * percentage, size, speed and time left. Speed is a smoothed average of recent progress.
 */
export function DownloadsTray() {
	const [tasks, setTasks] = useState<DownloadTask[]>([]);
	const [collapsed, setCollapsed] = useState(false);
	const speeds = useRef(new Map<string, { at: number; done: number; speed: number }>());
	// Progress rate per task (share of the file per second), to move the percentage smoothly between server updates.
	const rates = useRef(new Map<string, { at: number; ratio: number; rate: number }>());
	const [, setFrame] = useState(0);

	useEffect(() => {
		void api<{ downloads: DownloadTask[] }>("GET", "/api/local/downloads").then((result) => setTasks(result.downloads), () => undefined);
		return serverEvents.on<DownloadTask[]>("local-downloads", (next) => {
			const now = Date.now();
			for (const task of next) {
				if (task.done === undefined) continue;
				const last = speeds.current.get(task.task);
				if (!last) {
					speeds.current.set(task.task, { at: now, done: task.done, speed: 0 });
					continue;
				}
				const seconds = (now - last.at) / 1000;
				if (seconds < 0.2) continue;
				const instant = Math.max(0, (task.done - last.done) / seconds);
				speeds.current.set(task.task, { at: now, done: task.done, speed: last.speed ? last.speed * 0.7 + instant * 0.3 : instant });
			}
			for (const task of next) {
				if (task.ratio === undefined || task.state !== "running") continue;
				const last = rates.current.get(task.task);
				if (!last || task.ratio < last.ratio) {
					rates.current.set(task.task, { at: now, ratio: task.ratio, rate: last?.rate ?? 0 });
					continue;
				}
				const seconds = (now - last.at) / 1000;
				if (seconds < 0.2 || task.ratio === last.ratio) continue;
				const instant = (task.ratio - last.ratio) / seconds;
				rates.current.set(task.task, { at: now, ratio: task.ratio, rate: last.rate ? last.rate * 0.7 + instant * 0.3 : instant });
			}
			for (const key of speeds.current.keys()) if (!next.some((task) => task.task === key)) speeds.current.delete(key);
			for (const key of rates.current.keys()) if (!next.some((task) => task.task === key)) rates.current.delete(key);
			setTasks(next);
		});
	}, []);

	// Toasts sit above the tray; tell them how tall it is.
	const trayRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		document.body.classList.toggle("has-downloads", tasks.length > 0);
		const tray = trayRef.current;
		if (!tray) return;
		const observer = new ResizeObserver(() => document.documentElement.style.setProperty("--downloads-height", `${tray.offsetHeight + 12}px`));
		observer.observe(tray);
		return () => observer.disconnect();
	}, [tasks.length]);

	// While something downloads, redraw every animation frame so the percentage counts up smoothly.
	const anyRunning = tasks.some((task) => task.state === "running" && task.ratio !== undefined);
	useEffect(() => {
		if (!anyRunning) return;
		let frame = requestAnimationFrame(function tick() {
			setFrame((value) => value + 1);
			frame = requestAnimationFrame(tick);
		});
		return () => cancelAnimationFrame(frame);
	}, [anyRunning]);

	/** The last reported progress moved forward at the recent rate, never more than 2 s ahead or past 99.99%. */
	const estimate = (task: DownloadTask): number | undefined => {
		if (task.ratio === undefined) return undefined;
		const tracked = rates.current.get(task.task);
		if (task.state !== "running" || !tracked?.rate) return task.ratio;
		const ahead = tracked.rate * Math.min(2, (Date.now() - tracked.at) / 1000);
		return Math.min(Math.max(task.ratio, tracked.ratio + ahead), 0.9999);
	};

	if (tasks.length === 0) return null;
	const running = tasks.filter((task) => task.state === "running").length;

	return (
		<div ref={trayRef} className="downloads-tray" role="status" aria-label="Downloads">
			<button type="button" className="downloads-head" onClick={() => setCollapsed(!collapsed)} aria-expanded={!collapsed}>
				<Download size={14} />
				<span>{running > 0 ? `Downloading ${running} ${running === 1 ? "item" : "items"}` : "Downloads"}</span>
				{collapsed ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
			</button>
			{!collapsed &&
				tasks.map((task) => {
					const ratio = estimate(task);
					const percent = ratio !== undefined ? ratio * 100 : undefined;
					const places = decimals(rates.current.get(task.task)?.rate ?? 0);
					const speed = speeds.current.get(task.task)?.speed ?? 0;
					const left = speed > 0 && task.done !== undefined && task.total ? (task.total - task.done) / speed : Number.NaN;
					const name = task.label.includes("/") ? (task.label.split("/").pop() ?? task.label).replace(/-GGUF/i, "") : task.label;
					return (
						<div key={task.task} className={`download-item ${task.state}`} title={task.label}>
							<div className="download-row">
								{task.state === "done" ? <CheckCircle2 size={14} className="ok" /> : task.state === "failed" ? <CircleAlert size={14} className="bad" /> : null}
								<span className="download-name">{name}</span>
								{task.state === "running" && percent !== undefined && <span className="download-percent">{percent.toFixed(places)}%</span>}
								{task.state === "running" && task.task.startsWith("download:") && (
									<button type="button" className="icon-btn sm" aria-label={`Cancel ${task.label}`} title="Cancel" onClick={() => void api("POST", "/api/local/cancel", { task: task.task }).catch(() => undefined)}>
										<X size={13} />
									</button>
								)}
							</div>
							{task.state === "running" && (
								<div className="local-progress">
									<div style={{ width: percent === undefined ? "35%" : `${percent}%` }} className={percent === undefined ? "indeterminate" : undefined} />
								</div>
							)}
							<div className="download-meta">
								{task.state === "failed"
									? (task.error ?? task.message)
									: [
											task.state === "done" ? "Done" : task.message,
											task.done !== undefined && task.total ? `${bytes(task.done)} of ${bytes(task.total)}` : undefined,
											task.state === "running" && speed > 0 ? `${bytes(speed)}/s` : undefined,
											task.state === "running" ? duration(left) : undefined,
										]
											.filter(Boolean)
											.join(" · ")}
							</div>
						</div>
					);
				})}
		</div>
	);
}
