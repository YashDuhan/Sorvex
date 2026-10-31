import type { ServerResponse } from "node:http";

/** Fans server events out to every open `/api/events` stream (Server-Sent Events). */
export class Hub {
	private clients = new Set<ServerResponse>();
	/** Latest event per key, replayed to clients that connect later (e.g. extension status and tool lists). */
	private sticky = new Map<string, string>();

	attach(response: ServerResponse): void {
		response.writeHead(200, {
			"content-type": "text/event-stream",
			"cache-control": "no-cache",
			connection: "keep-alive",
		});
		response.write(": connected\n\n");
		for (const payload of this.sticky.values()) response.write(payload);
		this.clients.add(response);
		const keepAlive = setInterval(() => response.write(": ping\n\n"), 15000);
		response.on("close", () => {
			clearInterval(keepAlive);
			this.clients.delete(response);
		});
	}

	/** With `stickyKey`, the event is also kept and replayed to clients that connect later. */
	broadcast(event: string, data: unknown, stickyKey?: string): void {
		const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
		if (stickyKey) this.sticky.set(stickyKey, payload);
		for (const client of this.clients) client.write(payload);
	}

	clearSticky(): void {
		this.sticky.clear();
	}
}
