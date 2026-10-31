/**
 * Calls to the desktop Node server (apps/desktop/server). The header marks requests as coming from this UI;
 * the server rejects mutating requests without it, which keeps other websites from driving the agent.
 */
export async function api<T = unknown>(method: "GET" | "POST" | "PUT", path: string, body?: unknown): Promise<T> {
	const response = await fetch(path, {
		method,
		headers: method === "GET" ? undefined : { "content-type": "application/json", "x-sorvex-desktop": "1" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const data = (await response.json().catch(() => ({}))) as T & { error?: string };
	if (!response.ok) throw new Error(data.error ?? `${method} ${path} failed (${response.status})`);
	return data;
}

type Listener = (data: unknown) => void;

/**
 * One shared /api/events stream. EventSource retries on its own after a dropped connection, but gives up for good
 * when a connection attempt gets an error response (the dev proxy answers 500 while the server is starting), so this
 * opens a new one then.
 */
class ServerEvents {
	private source: EventSource | undefined;
	private listeners = new Map<string, Set<Listener>>();
	private openListeners = new Set<() => void>();

	on<T>(event: string, listener: (data: T) => void): () => void {
		this.connect();
		let set = this.listeners.get(event);
		if (!set) {
			set = new Set();
			this.listeners.set(event, set);
			this.listen(event);
		}
		set.add(listener as Listener);
		return () => set.delete(listener as Listener);
	}

	/** Called on every (re)connection, so state can be re-synced after the server restarts. */
	onOpen(listener: () => void): () => void {
		this.connect();
		this.openListeners.add(listener);
		return () => this.openListeners.delete(listener);
	}

	private connect(): void {
		if (this.source) return;
		const source = new EventSource("/api/events");
		this.source = source;
		for (const event of this.listeners.keys()) this.listen(event);
		source.onopen = () => {
			for (const listener of this.openListeners) listener();
		};
		source.onerror = () => {
			if (source.readyState !== EventSource.CLOSED) return;
			this.source = undefined;
			setTimeout(() => this.connect(), 1000);
		};
	}

	private listen(event: string): void {
		this.source?.addEventListener(event, (message) => this.dispatch(event, (message as MessageEvent).data));
	}

	private dispatch(event: string, raw: string): void {
		let data: unknown;
		try {
			data = JSON.parse(raw);
		} catch {
			return;
		}
		for (const listener of this.listeners.get(event) ?? []) listener(data);
	}
}

export const serverEvents = new ServerEvents();
