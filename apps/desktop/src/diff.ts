export interface DiffLine {
	kind: "add" | "del" | "ctx";
	text: string;
	/** Line number in the old file (context and deletions). */
	old?: number;
	/** Line number in the new file (context and additions). */
	new?: number;
}

export interface Hunk {
	oldStart: number;
	oldLines: number;
	newStart: number;
	newLines: number;
	lines: DiffLine[];
}

/** Parses `git diff` output for one file into hunks with old and new line numbers. */
export function parseDiff(text: string): { hunks: Hunk[]; binary: boolean } {
	const hunks: Hunk[] = [];
	let hunk: Hunk | undefined;
	let oldLine = 0;
	let newLine = 0;
	for (const line of text.split("\n")) {
		const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
		if (header) {
			hunk = { oldStart: Number(header[1]), oldLines: Number(header[2] ?? 1), newStart: Number(header[3]), newLines: Number(header[4] ?? 1), lines: [] };
			hunks.push(hunk);
			oldLine = hunk.oldStart;
			newLine = hunk.newStart;
			continue;
		}
		if (!hunk || line.startsWith("\\")) continue;
		if (line.startsWith("+")) hunk.lines.push({ kind: "add", text: line.slice(1), new: newLine++ });
		else if (line.startsWith("-")) hunk.lines.push({ kind: "del", text: line.slice(1), old: oldLine++ });
		else if (line.startsWith(" ")) hunk.lines.push({ kind: "ctx", text: line.slice(1), old: oldLine++, new: newLine++ });
	}
	return { hunks, binary: hunks.length === 0 && /^Binary files /m.test(text) };
}
