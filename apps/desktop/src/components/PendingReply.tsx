import { useEffect, useRef, useState } from "react";
import { api } from "../api.ts";
import { LOCAL_PROVIDER } from "../local.ts";

interface Activity {
	model: string;
	prompt: number;
	processed: number;
	cached: number;
	decoded: number;
}

function seconds(value: number): string {
	return value < 60 ? `${Math.round(value)}s` : `${Math.floor(value / 60)}m ${Math.round(value % 60)}s`;
}

/**
 * Shown while a reply is on its way but nothing is visible yet. A local model reads the whole agent prompt before
 * its first word (tens of seconds to minutes on a laptop), so for local models this polls the engine twice a second
 * and shows how many tokens it has read and how fast, then how fast it writes. Cloud models get a plain timer.
 */
export function PendingReply({ provider }: { provider?: string }) {
	const local = provider === LOCAL_PROVIDER;
	const [started] = useState(() => Date.now());
	const [now, setNow] = useState(() => Date.now());
	const [activity, setActivity] = useState<Activity | null>(null);
	// Read and write rates (tokens per second), smoothed, to move the count between polls and estimate time left.
	const rate = useRef<{ at: number; processed: number; decoded: number; read: number; write: number } | null>(null);

	useEffect(() => {
		const tick = setInterval(() => setNow(Date.now()), 250);
		return () => clearInterval(tick);
	}, []);

	useEffect(() => {
		if (!local) return;
		let stopped = false;
		const poll = async () => {
			const { requests } = await api<{ requests: Activity[] }>("GET", "/api/local/activity").catch(() => ({ requests: [] as Activity[] }));
			if (stopped) return;
			const current = requests.sort((a, b) => b.prompt - a.prompt)[0] ?? null;
			if (current) {
				const time = Date.now();
				const last = rate.current;
				if (!last || current.processed < last.processed) {
					rate.current = { at: time, processed: current.processed, decoded: current.decoded, read: last?.read ?? 0, write: 0 };
				} else if (time - last.at > 300) {
					const elapsed = (time - last.at) / 1000;
					const read = (current.processed - last.processed) / elapsed;
					const write = (current.decoded - last.decoded) / elapsed;
					rate.current = {
						at: time,
						processed: current.processed,
						decoded: current.decoded,
						read: read > 0 ? (last.read ? last.read * 0.6 + read * 0.4 : read) : last.read,
						write: write > 0 ? (last.write ? last.write * 0.6 + write * 0.4 : write) : last.write,
					};
				}
			}
			setActivity(current);
		};
		void poll();
		const timer = setInterval(() => void poll(), 500);
		return () => {
			stopped = true;
			clearInterval(timer);
		};
	}, [local]);

	const waited = (now - started) / 1000;
	let label = `Waiting for the model · ${seconds(waited)}`;
	let indeterminate = false;

	if (local && activity && activity.prompt > 0) {
		const tracked = rate.current;
		// The engine reports reading in batches and only knows the batches handed to it so far, not the whole prompt,
		// so show tokens read and the rate (counting up between reports) rather than a percentage.
		const ahead = tracked?.read ? tracked.read * Math.min(3, (now - tracked.at) / 1000) : 0;
		const read = Math.max(activity.processed, (tracked?.processed ?? 0) + ahead);
		if (activity.decoded === 0) {
			label = [
				"Reading the conversation",
				`${Math.round(read).toLocaleString()} tokens read`,
				tracked?.read ? `${tracked.read.toFixed(0)} tokens/s` : undefined,
				activity.cached > 0 ? `${activity.cached.toLocaleString()} reused from cache` : undefined,
				seconds(waited),
			]
				.filter(Boolean)
				.join(" · ");
			indeterminate = true;
		} else {
			label = [`Writing · ${activity.decoded.toLocaleString()} tokens`, tracked?.write ? `${tracked.write.toFixed(1)} tokens/s` : undefined].filter(Boolean).join(" · ");
		}
	} else if (local) {
		label = `Waiting for the local engine · ${seconds(waited)}`;
	}

	return (
		<div className="pending-reply" role="status" aria-live="polite">
			<span className="pending-dot" />
			<span>{label}</span>
			{indeterminate && (
				<div className="local-progress pending-bar">
					<div className="indeterminate" style={{ width: "35%" }} />
				</div>
			)}
		</div>
	);
}
