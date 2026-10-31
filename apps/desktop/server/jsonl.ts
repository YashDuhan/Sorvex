import type { ChildProcessWithoutNullStreams } from "node:child_process";

/**
 * Calls `onLine` for each LF-terminated record on a child's stdout. Sorvex's RPC framing splits on `\n` only,
 * so `readline` (which also splits on U+2028/U+2029) must not be used.
 */
export function readLines(stream: NodeJS.ReadableStream, onLine: (line: string) => void): void {
	let buffer = "";
	stream.setEncoding("utf8");
	stream.on("data", (chunk: string) => {
		buffer += chunk;
		let newline = buffer.indexOf("\n");
		while (newline !== -1) {
			const line = buffer.slice(0, newline).replace(/\r$/, "");
			buffer = buffer.slice(newline + 1);
			if (line.trim()) onLine(line);
			newline = buffer.indexOf("\n");
		}
	});
}

export function writeLine(child: ChildProcessWithoutNullStreams, record: unknown): void {
	child.stdin.write(`${JSON.stringify(record)}\n`);
}
