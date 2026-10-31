import { execFile } from "node:child_process";
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const MAX_FILE = 1024 * 1024;

/** Resolves a path inside the working directory; anything outside it (or reached through a symlink) is refused. */
function inside(root: string, path: string): string {
	const full = resolve(root, path || ".");
	const real = realpathSync(full);
	const rel = relative(realpathSync(root), real);
	if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("Path is outside the working directory");
	return real;
}

async function git(cwd: string, args: string[], maxBuffer = 64 * 1024 * 1024): Promise<string> {
	const { stdout } = await run("git", ["-c", "core.quotePath=false", ...args], { cwd, maxBuffer });
	return stdout;
}

export interface DirEntry {
	name: string;
	path: string;
	dir: boolean;
}

/** One folder level for the Files tree: folders first, then files, by name. `.git` is hidden. */
export function listDir(root: string, path: string): DirEntry[] {
	const dir = inside(root, path);
	return readdirSync(dir, { withFileTypes: true })
		.filter((entry) => entry.name !== ".git")
		.map((entry) => {
			let isDir = entry.isDirectory();
			if (entry.isSymbolicLink()) {
				try {
					isDir = statSync(join(dir, entry.name)).isDirectory();
				} catch {}
			}
			return { name: entry.name, path: relative(root, join(dir, entry.name)), dir: isDir };
		})
		.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
}

export function readWorkspaceFile(root: string, path: string): { path: string; content: string; size: number; binary: boolean; truncated: boolean } {
	const full = inside(root, path);
	const size = statSync(full).size;
	const buffer = readFileSync(full).subarray(0, MAX_FILE);
	const binary = buffer.subarray(0, 8000).includes(0);
	return { path, size, binary, truncated: size > MAX_FILE, content: binary ? "" : buffer.toString("utf8") };
}

/** Text search for the Files pane ("?" in the filter box), through git grep so ignored files are skipped. */
export async function searchFiles(root: string, query: string): Promise<{ path: string; line: number; text: string }[]> {
	if (!query.trim()) return [];
	try {
		const out = await git(root, ["grep", "-n", "-I", "-i", "--untracked", "--fixed-strings", "--max-count=20", "-e", query]);
		return out
			.split("\n")
			.filter(Boolean)
			.slice(0, 300)
			.map((line) => {
				const match = /^(.*?):(\d+):(.*)$/.exec(line);
				return match ? { path: match[1]!, line: Number(match[2]), text: match[3]!.trim().slice(0, 240) } : { path: line, line: 0, text: "" };
			});
	} catch {
		// git grep exits 1 when nothing matches.
		return [];
	}
}

export interface ChangedFile {
	path: string;
	oldPath?: string;
	status: string;
	additions: number;
	deletions: number;
	binary: boolean;
}

export interface ChangeSummary {
	branch: string;
	base: string;
	bases: string[];
	files: ChangedFile[];
}

async function branches(root: string): Promise<string[]> {
	const out = await git(root, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]).catch(() => "");
	return out.split("\n").filter(Boolean);
}

/** The commit a base is compared from: HEAD for uncommitted changes, else where the branch left the base. */
async function baseRef(root: string, base: string): Promise<string> {
	if (base === "HEAD") return "HEAD";
	return (await git(root, ["merge-base", base, "HEAD"])).trim();
}

/**
 * Changed files for the Changes pane: committed, staged, unstaged and untracked changes since `base` (default: the
 * main branch when on another branch, so a feature branch shows all its work; uncommitted changes otherwise).
 */
export async function changeSummary(root: string, requested?: string): Promise<ChangeSummary> {
	const branch = (await git(root, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
	const local = await branches(root);
	const main = ["main", "master", "trunk"].find((name) => local.includes(name));
	const base = requested && (requested === "HEAD" || local.includes(requested)) ? requested : main && main !== branch ? main : "HEAD";
	const ref = await baseRef(root, base);
	const [numstat, nameStatus, untracked] = await Promise.all([
		git(root, ["diff", "--numstat", "-M", ref]),
		git(root, ["diff", "--name-status", "-M", ref]),
		git(root, ["ls-files", "--others", "--exclude-standard"]),
	]);
	const statuses = new Map<string, string>();
	for (const line of nameStatus.split("\n").filter(Boolean)) {
		const parts = line.split("\t");
		statuses.set(parts.at(-1)!, parts[0]![0]!);
	}
	const files: ChangedFile[] = numstat
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const [added, deleted, ...rest] = line.split("\t");
			let path = rest.join("\t");
			let oldPath: string | undefined;
			// Renames are "old => new", or "dir/{old => new}/file" for a shared prefix.
			const braces = /^(.*)\{(.*) => (.*)\}(.*)$/.exec(path);
			const arrow = /^(.*) => (.*)$/.exec(path);
			if (braces) {
				oldPath = `${braces[1]}${braces[2]}${braces[4]}`.replace(/\/\//g, "/");
				path = `${braces[1]}${braces[3]}${braces[4]}`.replace(/\/\//g, "/");
			} else if (arrow) {
				oldPath = arrow[1];
				path = arrow[2]!;
			}
			const binary = added === "-";
			return { path, oldPath, status: statuses.get(path) ?? "M", additions: binary ? 0 : Number(added), deletions: binary ? 0 : Number(deleted), binary };
		});
	for (const path of untracked.split("\n").filter(Boolean).slice(0, 2000)) {
		let additions = 0;
		let binary = false;
		try {
			const file = readWorkspaceFile(root, path);
			binary = file.binary;
			additions = binary ? 0 : file.content.split("\n").length - (file.content.endsWith("\n") ? 1 : 0);
		} catch {}
		files.push({ path, status: "?", additions, deletions: 0, binary });
	}
	return { branch, base, bases: ["HEAD", ...local.filter((name) => name !== branch)], files };
}

/** Unified diff of one file against the base; `full` returns the whole file as context. */
export async function fileDiff(root: string, base: string, file: { path: string; oldPath?: string; status: string }, full: boolean): Promise<string> {
	const context = full ? "-U100000" : "-U3";
	if (file.status === "?") {
		inside(root, file.path);
		try {
			return await git(root, ["diff", "--no-index", context, "--", "/dev/null", file.path]);
		} catch (error) {
			// --no-index exits 1 when the files differ, which is always the case here.
			return (error as { stdout?: string }).stdout ?? "";
		}
	}
	const ref = await baseRef(root, base);
	const paths = file.oldPath ? [file.oldPath, file.path] : [file.path];
	return git(root, ["diff", "-M", context, ref, "--", ...paths]);
}

/** The branch shown under a new chat's composer; a detached HEAD shows its short commit. Undefined outside git. */
export async function currentBranch(root: string): Promise<string | undefined> {
	try {
		const branch = (await git(root, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
		return branch === "HEAD" ? (await git(root, ["rev-parse", "--short", "HEAD"])).trim() : branch;
	} catch {
		return undefined;
	}
}
