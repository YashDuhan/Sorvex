export function relativeTime(ms: number): string {
	const seconds = Math.max(0, (Date.now() - ms) / 1000);
	if (seconds < 60) return "now";
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
	if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
	if (seconds < 86400 * 7) return `${Math.floor(seconds / 86400)}d`;
	return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function compactNumber(value: number): string {
	if (value < 1000) return String(value);
	if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
	return `${(value / 1_000_000).toFixed(1)}M`;
}

export function duration(ms: number | undefined): string | undefined {
	if (ms === undefined) return undefined;
	return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

export function basename(path: string): string {
	const parts = path.split(/[/\\]/).filter(Boolean);
	return parts[parts.length - 1] ?? path;
}

export function stringify(value: unknown): string {
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

/** Text from a tool result payload: either `{ content: [{ type: "text", text }] }` or anything else as JSON. */
export function resultText(result: unknown): string {
	if (result && typeof result === "object" && "content" in result && Array.isArray(result.content)) {
		const text = result.content
			.filter((block: { type?: string }) => block?.type === "text")
			.map((block: { text?: string }) => block.text ?? "")
			.join("\n");
		if (text) return text;
	}
	return stringify(result);
}
