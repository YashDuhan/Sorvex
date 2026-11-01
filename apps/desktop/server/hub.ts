import type { ServerResponse } from "node:http";

export type HubListener = (event: string, data: unknown) => void;

/** Fans server events out to every open `/api/events` stream (Server-Sent Events) and in-process subscribers. */
export class Hub {
	private clients = new Set<ServerResponse>();
	private listeners = new Set<HubListener>();
	/** Latest event per key, replayed to clients that connect later (e.g. extension status and tool lists). */
	private sticky = new Map<string, { event: string; data: unknown }>();

	attach(response: ServerResponse): void {
		response.writeHead(200, {
			"content-type": "text/event-stream",
			"cache-control": "no-cache",
			connection: "keep-alive",
		});
		response.write(": connected\n\n");
		for (const { event, data } of this.sticky.values()) response.write(format(event, data));
		this.clients.add(response);
		const keepAlive = setInterval(() => response.write(": ping\n\n"), 15000);
		response.on("close", () => {
			clearInterval(keepAlive);
			this.clients.delete(response);
		});
	}

	/** In-process subscribers such as remote access. Returns an unsubscribe function. */
	subscribe(listener: HubListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** The sticky events, for subscribers that join late. */
	stickyEvents(): { event: string; data: unknown }[] {
		return [...this.sticky.values()];
	}

	/** With `stickyKey`, the event is also kept and replayed to clients that connect later. */
	broadcast(event: string, data: unknown, stickyKey?: string): void {
		if (stickyKey) this.sticky.set(stickyKey, { event, data });
		const payload = format(event, data);
		for (const client of this.clients) client.write(payload);
		for (const listener of this.listeners) listener(event, data);
	}

	clearSticky(): void {
		this.sticky.clear();
	}
}

function format(event: string, data: unknown): string {
	return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}
