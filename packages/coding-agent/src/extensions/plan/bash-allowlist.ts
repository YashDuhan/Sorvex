export type Shell = "bash" | "powershell";

/**
 * The arguments a read-only command accepts. A flag that is not listed, an unknown subcommand, or
 * too many positional arguments rejects the command.
 */
interface CommandRule {
	/** Single-letter flags. A cluster such as `-la` is allowed when each letter is. */
	readonly short?: string;
	/** `--name` flags, also allowed as `--name=value`. */
	readonly long?: readonly string[];
	/** Lowercase single-dash word flags, such as find's `-name` or PowerShell parameters (`-Path`, `-Path:x`). */
	readonly words?: readonly string[];
	/** Digits are allowed in short clusters, as in `-5` and `-n5`. */
	readonly numeric?: boolean;
	/** Single-letter flags followed in the same word by one of these values, as in git status `-uall`. */
	readonly shortValues?: Readonly<Record<string, readonly string[]>>;
	readonly maxPositionals?: number;
	/** The first positional argument must match, such as a sed script. */
	readonly script?: RegExp;
	/** The first positional argument must name one of these. */
	readonly subcommands?: Readonly<Record<string, CommandRule>>;
	/** The command reads expressions after `--`, as find does, so `--` rejects the command. */
	readonly parsesAfterEndOfOptions?: boolean;
	/**
	 * The meaning of an argument depends on its position, as in jq's filter or find's expression.
	 * A glob can expand to any number of arguments and shift the ones after it, so a glob rejects the
	 * command. Rules with `maxPositionals` are treated the same way.
	 */
	readonly positional?: boolean;
	/** A PowerShell cmdlet, which expands wildcards in its own parameters. The shell does not expand them. */
	readonly cmdlet?: boolean;
}

const POWERSHELL_COMMON = ["erroraction", "ea"];

const GIT_DIFF_LONG = [
	"stat",
	"numstat",
	"shortstat",
	"dirstat",
	"summary",
	"name-only",
	"name-status",
	"patch",
	"no-patch",
	"unified",
	"word-diff",
	"color",
	"no-color",
	"ignore-all-space",
	"ignore-space-change",
	"ignore-blank-lines",
	"minimal",
	"patience",
	"histogram",
	"find-renames",
	"no-renames",
	"diff-filter",
	"abbrev",
	"full-index",
	"binary",
	"text",
	"relative",
	"exit-code",
	"quiet",
	"check",
	"no-prefix",
];

const GIT_LOG: CommandRule = {
	short: "cimnpsuwzCGLMRS",
	numeric: true,
	long: [
		...GIT_DIFF_LONG,
		"oneline",
		"graph",
		"decorate",
		"no-decorate",
		"all",
		"branches",
		"tags",
		"remotes",
		"format",
		"pretty",
		"abbrev-commit",
		"no-abbrev-commit",
		"author",
		"committer",
		"grep",
		"invert-grep",
		"all-match",
		"regexp-ignore-case",
		"since",
		"until",
		"after",
		"before",
		"max-count",
		"skip",
		"reverse",
		"first-parent",
		"merges",
		"no-merges",
		"follow",
		"date",
		"relative-date",
		"full-history",
		"simplify-by-decoration",
		"topo-order",
		"date-order",
		"left-right",
		"source",
		"parents",
		"children",
	],
};

const GIT: CommandRule = {
	long: ["no-pager"],
	subcommands: {
		status: {
			short: "sbvz",
			shortValues: { u: ["", "no", "normal", "all"] },
			long: [
				"short",
				"branch",
				"long",
				"porcelain",
				"verbose",
				"untracked-files",
				"ignored",
				"ignore-submodules",
				"ahead-behind",
				"no-ahead-behind",
				"renames",
				"no-renames",
				"show-stash",
			],
		},
		log: GIT_LOG,
		show: GIT_LOG,
		diff: {
			short: "abpuwzBCMRU",
			numeric: true,
			long: [...GIT_DIFF_LONG, "cached", "staged", "merge-base", "no-index"],
		},
		blame: {
			short: "bcefLlMnpstwC",
			long: ["porcelain", "line-porcelain", "incremental", "show-name", "show-number", "show-email", "root", "date"],
		},
		branch: {
			short: "alrv",
			long: [
				"all",
				"remotes",
				"list",
				"verbose",
				"show-current",
				"contains",
				"no-contains",
				"merged",
				"no-merged",
				"points-at",
				"sort",
				"format",
				"color",
				"no-color",
				"ignore-case",
				"abbrev",
			],
			maxPositionals: 0,
		},
		"ls-files": {
			short: "cdikmostuvxz",
			long: [
				"cached",
				"deleted",
				"modified",
				"others",
				"ignored",
				"stage",
				"unmerged",
				"killed",
				"directory",
				"no-empty-directory",
				"exclude",
				"exclude-standard",
				"full-name",
				"abbrev",
				"error-unmatch",
				"deduplicate",
			],
		},
		"rev-parse": {
			short: "q",
			long: [
				"show-toplevel",
				"show-prefix",
				"show-cdup",
				"git-dir",
				"git-common-dir",
				"absolute-git-dir",
				"is-inside-work-tree",
				"is-inside-git-dir",
				"is-bare-repository",
				"abbrev-ref",
				"symbolic-full-name",
				"short",
				"verify",
				"quiet",
			],
		},
		remote: { short: "v", long: ["verbose"], maxPositionals: 0 },
	},
};

const GET_CHILD_ITEM: CommandRule = {
	cmdlet: true,
	words: [
		...POWERSHELL_COMMON,
		"path",
		"literalpath",
		"filter",
		"include",
		"exclude",
		"recurse",
		"depth",
		"force",
		"name",
		"file",
		"directory",
		"hidden",
		"attributes",
	],
};
const GET_CONTENT: CommandRule = {
	cmdlet: true,
	words: [
		...POWERSHELL_COMMON,
		"path",
		"literalpath",
		"totalcount",
		"head",
		"first",
		"tail",
		"last",
		"raw",
		"encoding",
		"delimiter",
	],
};
const SELECT_STRING: CommandRule = {
	cmdlet: true,
	words: [
		...POWERSHELL_COMMON,
		"pattern",
		"path",
		"literalpath",
		"simplematch",
		"casesensitive",
		"context",
		"list",
		"notmatch",
		"allmatches",
		"quiet",
		"raw",
		"include",
		"exclude",
		"encoding",
		"noemphasis",
	],
};
const GET_ITEM: CommandRule = {
	cmdlet: true,
	words: [...POWERSHELL_COMMON, "path", "literalpath", "force", "filter", "include", "exclude"],
};
const SELECT_OBJECT: CommandRule = {
	cmdlet: true,
	words: [...POWERSHELL_COMMON, "first", "last", "skip", "skiplast", "unique", "index", "property", "expandproperty"],
};
const MEASURE_OBJECT: CommandRule = {
	cmdlet: true,
	words: [...POWERSHELL_COMMON, "line", "word", "character", "sum", "average", "maximum", "minimum", "property"],
};

const LS: CommandRule = {
	short: "1aAbBcCdfFgGhHiIklLmnNopqQrRsStTuUvwxXZ",
	long: [
		"all",
		"almost-all",
		"classify",
		"color",
		"directory",
		"dereference",
		"format",
		"full-time",
		"group-directories-first",
		"human-readable",
		"ignore",
		"ignore-backups",
		"inode",
		"literal",
		"numeric-uid-gid",
		"recursive",
		"reverse",
		"size",
		"sort",
		"time",
		"time-style",
		"width",
	],
};
const CAT: CommandRule = {
	short: "AbeEnstTuv",
	long: ["show-all", "number-nonblank", "show-ends", "number", "squeeze-blank", "show-tabs", "show-nonprinting"],
};
const RG: CommandRule = {
	short: "aAbBcCdeEfFgHhiIjlLmMnNopPqrsStTuUvwx.",
	numeric: true,
	long: [
		"after-context",
		"before-context",
		"context",
		"case-sensitive",
		"ignore-case",
		"smart-case",
		"color",
		"column",
		"count",
		"count-matches",
		"files",
		"files-with-matches",
		"files-without-match",
		"fixed-strings",
		"follow",
		"glob",
		"iglob",
		"heading",
		"no-heading",
		"hidden",
		"invert-match",
		"json",
		"line-number",
		"no-line-number",
		"line-regexp",
		"word-regexp",
		"max-columns",
		"max-count",
		"max-depth",
		"max-filesize",
		"multiline",
		"multiline-dotall",
		"no-ignore",
		"no-ignore-vcs",
		"no-messages",
		"null",
		"only-matching",
		"passthru",
		"pcre2",
		"pretty",
		"quiet",
		"regexp",
		"replace",
		"sort",
		"sortr",
		"stats",
		"text",
		"trim",
		"type",
		"type-not",
		"type-list",
		"unrestricted",
		"vimgrep",
		"with-filename",
		"no-filename",
		"encoding",
		"byte-offset",
	],
};
const JQ: CommandRule = {
	positional: true,
	short: "acCejMnrRsS",
	long: [
		"raw-output",
		"join-output",
		"ascii-output",
		"compact-output",
		"null-input",
		"raw-input",
		"slurp",
		"sort-keys",
		"exit-status",
		"color-output",
		"monochrome-output",
		"tab",
		"indent",
		"arg",
		"argjson",
		"seq",
		"stream",
	],
};
const ECHO: CommandRule = { short: "eEn" };
const PWD: CommandRule = { short: "LP", maxPositionals: 0 };

/** Read-only commands bash runs, by exact name. A command that is not listed is rejected. */
const BASH_COMMANDS: Readonly<Record<string, CommandRule>> = {
	git: GIT,
	rg: RG,
	jq: JQ,
	ls: LS,
	cat: CAT,
	echo: ECHO,
	pwd: PWD,
	head: { short: "cnqvz", numeric: true, long: ["lines", "bytes", "quiet", "silent", "verbose", "zero-terminated"] },
	tail: { short: "cnqvz", numeric: true, long: ["lines", "bytes", "quiet", "silent", "verbose", "zero-terminated"] },
	wc: { short: "clmwL", long: ["bytes", "chars", "lines", "words", "max-line-length", "total"] },
	grep: {
		short: "aAbBcCdDeEfFGhHiIlLmnoPqrRsTuUvVwxyzZ",
		numeric: true,
		long: [
			"after-context",
			"before-context",
			"context",
			"color",
			"colour",
			"count",
			"extended-regexp",
			"fixed-strings",
			"basic-regexp",
			"perl-regexp",
			"ignore-case",
			"no-ignore-case",
			"invert-match",
			"word-regexp",
			"line-regexp",
			"files-with-matches",
			"files-without-match",
			"max-count",
			"only-matching",
			"quiet",
			"silent",
			"no-messages",
			"byte-offset",
			"with-filename",
			"no-filename",
			"line-number",
			"null",
			"text",
			"recursive",
			"dereference-recursive",
			"include",
			"exclude",
			"exclude-dir",
			"binary-files",
			"regexp",
		],
	},
	find: {
		short: "HLP",
		positional: true,
		parsesAfterEndOfOptions: true,
		numeric: true,
		words: [
			"name",
			"iname",
			"path",
			"ipath",
			"wholename",
			"iwholename",
			"regex",
			"iregex",
			"regextype",
			"type",
			"xtype",
			"maxdepth",
			"mindepth",
			"size",
			"mtime",
			"mmin",
			"atime",
			"amin",
			"ctime",
			"cmin",
			"newer",
			"newermt",
			"empty",
			"readable",
			"writable",
			"executable",
			"perm",
			"user",
			"group",
			"links",
			"samefile",
			"lname",
			"ilname",
			"print",
			"print0",
			"printf",
			"ls",
			"prune",
			"quit",
			"not",
			"o",
			"or",
			"a",
			"and",
			"true",
			"false",
			"depth",
			"mount",
			"xdev",
			"follow",
		],
	},
	tree: {
		short: "adfgilnpqrstuvxACDFIJLNPQSUX",
		long: [
			"dirsfirst",
			"noreport",
			"charset",
			"filelimit",
			"gitignore",
			"prune",
			"matchdirs",
			"ignore-case",
			"du",
			"si",
		],
	},
	sed: { short: "nE", long: ["quiet", "silent", "regexp-extended"], script: /^(\d+|\$)(,(\d+|\$))?p$/ },
	sort: {
		short: "bcdfghiMmnrsuVkt",
		long: [
			"ignore-leading-blanks",
			"dictionary-order",
			"ignore-case",
			"general-numeric-sort",
			"human-numeric-sort",
			"month-sort",
			"numeric-sort",
			"reverse",
			"stable",
			"unique",
			"version-sort",
			"key",
			"field-separator",
			"check",
			"merge",
		],
	},
	uniq: {
		short: "cdDiuz",
		long: ["count", "repeated", "all-repeated", "ignore-case", "unique", "zero-terminated"],
		maxPositionals: 1,
	},
	diff: {
		short: "abBdEiNpqrsStTuUwy",
		numeric: true,
		long: [
			"brief",
			"recursive",
			"unified",
			"context",
			"side-by-side",
			"ignore-case",
			"ignore-all-space",
			"ignore-space-change",
			"ignore-blank-lines",
			"new-file",
			"text",
			"color",
			"report-identical-files",
			"exclude",
		],
	},
	curl: {
		short: "fIkLsS",
		long: [
			"fail",
			"fail-with-body",
			"head",
			"insecure",
			"location",
			"silent",
			"show-error",
			"compressed",
			"max-time",
		],
	},
	env: { maxPositionals: 0 },
	which: { short: "a" },
	file: { short: "bhiLk", long: ["brief", "mime", "mime-type", "dereference", "no-dereference", "keep-going"] },
	stat: { short: "cfLt", long: ["dereference", "file-system", "terse", "format", "printf"] },
	du: {
		short: "abcdhHklLmsSx",
		numeric: true,
		long: [
			"all",
			"apparent-size",
			"bytes",
			"total",
			"max-depth",
			"human-readable",
			"si",
			"summarize",
			"separate-dirs",
			"one-file-system",
			"dereference",
			"exclude",
		],
	},
	uname: { short: "aimnoprsv", maxPositionals: 0 },
	whoami: { maxPositionals: 0 },
};

/**
 * Read-only commands PowerShell runs, by lowercase name. Windows PowerShell maps ls, cat, echo,
 * and pwd to cmdlets, so their rules must be safe for both the cmdlet and the native command.
 */
const POWERSHELL_COMMANDS: Readonly<Record<string, CommandRule>> = {
	git: GIT,
	rg: RG,
	jq: JQ,
	ls: LS,
	cat: CAT,
	echo: ECHO,
	pwd: PWD,
	"get-childitem": GET_CHILD_ITEM,
	gci: GET_CHILD_ITEM,
	"get-content": GET_CONTENT,
	gc: GET_CONTENT,
	"select-string": SELECT_STRING,
	sls: SELECT_STRING,
	"get-item": GET_ITEM,
	gi: GET_ITEM,
	"select-object": SELECT_OBJECT,
	select: SELECT_OBJECT,
	"measure-object": MEASURE_OBJECT,
	measure: MEASURE_OBJECT,
	"sort-object": {
		cmdlet: true,
		words: [...POWERSHELL_COMMON, "property", "descending", "unique", "casesensitive", "top", "bottom"],
	},
	"get-location": { cmdlet: true, words: POWERSHELL_COMMON, maxPositionals: 0 },
	"test-path": {
		cmdlet: true,
		words: [...POWERSHELL_COMMON, "path", "literalpath", "pathtype", "filter", "include", "exclude"],
	},
	"resolve-path": { cmdlet: true, words: [...POWERSHELL_COMMON, "path", "literalpath", "relative"] },
	"out-null": { cmdlet: true, maxPositionals: 0 },
};

/** A word with quotes removed, and where it has an unquoted `*` or `?` that the shell expands. */
interface Word {
	readonly text: string;
	readonly glob: "none" | "inside" | "start";
}

function lookup(table: Readonly<Record<string, CommandRule>>, name: string): CommandRule | undefined {
	return Object.hasOwn(table, name) ? table[name] : undefined;
}

function allowsFlag(rule: CommandRule, flag: string): boolean {
	if (flag.startsWith("--")) return rule.long?.includes(flag.slice(2).split("=", 1)[0]) ?? false;
	const body = flag.slice(1);
	if (rule.words?.includes(body.split(":", 1)[0].toLowerCase())) return true;
	if (rule.shortValues && Object.hasOwn(rule.shortValues, body[0]))
		return rule.shortValues[body[0]].includes(body.slice(1));
	return [...body].every((char) => rule.short?.includes(char) || (rule.numeric === true && /\d/.test(char)));
}

function allowsArgs(rule: CommandRule, words: readonly Word[]): boolean {
	if (!rule.cmdlet) {
		// A glob at the start of a word can expand to a file name that starts with "-" and act as a flag.
		// Any glob can expand to several arguments, which changes what a positional argument means.
		const positional = rule.positional === true || rule.maxPositionals !== undefined;
		if (words.some(({ glob }) => glob === "start" || (glob === "inside" && positional))) return false;
	}
	const args = words.map(({ text }) => text);
	const positionals: string[] = [];
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--") {
			// A command that does not end its options at `--` would read a later `-x` as a flag.
			const rest = args.slice(index + 1);
			if (
				rule.parsesAfterEndOfOptions ||
				rule.subcommands ||
				rest.some((value) => value.length > 1 && value.startsWith("-"))
			) {
				return false;
			}
			positionals.push(...rest);
			break;
		}
		if (arg.length > 1 && arg.startsWith("-")) {
			if (!allowsFlag(rule, arg)) return false;
			continue;
		}
		if (rule.subcommands && positionals.length === 0) {
			const subcommand = lookup(rule.subcommands, arg);
			return subcommand !== undefined && allowsArgs(subcommand, words.slice(index + 1));
		}
		positionals.push(arg);
	}
	if (rule.maxPositionals !== undefined && positionals.length > rule.maxPositionals) return false;
	return rule.script === undefined || (positionals.length > 0 && rule.script.test(positionals[0]));
}

/**
 * PowerShell reads typographic quotes and dashes as quotes and parameter prefixes, and Unicode
 * spaces as word breaks.
 */
const AMBIGUOUS = /[–-―‘-‟\u0085]|[^\S \t\r\n]/;

/**
 * Characters that start substitutions, subshells, script blocks, type literals, splats, comments,
 * input redirects, or escapes in bash or PowerShell. They reject the command outside single quotes.
 */
const SPECIAL = new Set(["$", "`", "(", ")", "{", "}", "[", "]", "<", "#", "@"]);

/**
 * Windows PowerShell, and pwsh for some programs, pass an argument with spaces to a program in
 * added quotes without escaping it, so a `"` in it or a `\` at its end splits it into other arguments.
 */
function isUnsafeNativeArgument(value: string): boolean {
	return value.includes('"') || (value.endsWith("\\") && /\s/.test(value));
}

function isBlank(char: string): boolean {
	return char === " " || char === "\t";
}

/** bash reads a carriage return as part of a word; PowerShell reads it as a line break. */
function isLineBreak(char: string, shell: Shell): boolean {
	return char === "\n" || (shell === "powershell" && char === "\r");
}

function isWordEnd(char: string | undefined, shell: Shell): boolean {
	return char === undefined || isBlank(char) || isLineBreak(char, shell) || ";|&".includes(char);
}

/** The index of the quote that closes the one at `open`. PowerShell reads a doubled quote inside quotes as one quote. */
function closingQuote(line: string, open: number, shell: Shell): number {
	const quote = line[open];
	let close = line.indexOf(quote, open + 1);
	while (shell === "powershell" && close !== -1 && line[close + 1] === quote) close = line.indexOf(quote, close + 2);
	return close;
}

/**
 * Split a command line into commands and their words with quotes removed. Returns undefined when
 * the line has anything but plain words, quotes, the separators `|`, `||`, `&&`, `;`, and line
 * breaks, and the stderr redirects `2>&1` and `2>/dev/null` (bash) or `2>$null` (PowerShell).
 */
function parseCommands(line: string, shell: Shell): Word[][] | undefined {
	const commands: Word[][] = [];
	let words: Word[] = [];
	let word = "";
	let inWord = false;
	let quoted = false;
	let glob: Word["glob"] = "none";
	const endWord = () => {
		if (inWord) words.push({ text: word, glob });
		word = "";
		inWord = false;
		quoted = false;
		glob = "none";
	};
	const endCommand = (): boolean => {
		endWord();
		if (words.length === 0) return false;
		commands.push(words);
		words = [];
		return true;
	};
	const nullDevice = shell === "bash" ? "/dev/null" : "$null";

	let index = 0;
	while (index < line.length) {
		const char = line[index];
		const next = line[index + 1];
		if (isBlank(char)) {
			endWord();
			index++;
		} else if (isLineBreak(char, shell) || char === ";") {
			if (!endCommand()) return undefined;
			index++;
		} else if (char === "|" || char === "&") {
			const double = next === char;
			if ((char === "&" && !double) || (char === "|" && next === "&")) return undefined;
			if (!endCommand()) return undefined;
			index += double ? 2 : 1;
		} else if (char === "'" || char === '"') {
			const close = closingQuote(line, index, shell);
			if (close === -1) return undefined;
			let content = line.slice(index + 1, close);
			if (char === '"' && (/[$`]/.test(content) || (shell === "bash" && content.includes("\\")))) return undefined;
			if (shell === "powershell") {
				// PowerShell splits words at quotes in ways that depend on the characters around them:
				// `'a'-b`, `.'a'-b`, and `a,'b'-c` are each more than one argument. Only whole words are quoted.
				if (inWord || !isWordEnd(line[close + 1], shell)) return undefined;
				content = content.replaceAll(char + char, char);
			}
			word += content;
			inWord = true;
			quoted = true;
			index = close + 1;
		} else if (char === ">") {
			if (word !== "2" || quoted) return undefined;
			const rest = line.slice(index + 1);
			// bash reads a line break after `2>` as the end of the command, not as a space before the target.
			const target = rest.startsWith("&1") ? "&1" : (/^[ \t]*/.exec(rest)?.[0] ?? "") + nullDevice;
			if (!rest.startsWith(target) || !isWordEnd(rest[target.length], shell)) return undefined;
			word = "";
			inWord = false;
			index += 1 + target.length;
		} else if (
			SPECIAL.has(char) ||
			(char === ":" && next === ":") ||
			(shell === "bash" && char === "\\") ||
			// PowerShell reads `a,b` as an array, which it passes to a program as separate arguments.
			(shell === "powershell" && char === ",")
		) {
			return undefined;
		} else if (char === "*" || char === "?") {
			// bash, and pwsh for programs on Linux and macOS, expand globs. allowsArgs decides whether the command allows it.
			if (glob === "none") glob = word === "" ? "start" : "inside";
			word += char;
			inWord = true;
			index++;
		} else {
			word += char;
			inWord = true;
			index++;
		}
	}
	if (!endCommand()) return undefined;
	if (shell === "powershell" && commands.some((words) => words.some(({ text }) => isUnsafeNativeArgument(text)))) {
		return undefined;
	}
	return commands;
}

/** Remove leading and trailing blanks and line breaks in linear time, unlike a `\s+$` regex. */
function trim(command: string, shell: Shell): string {
	const isSpace = (char: string) => isBlank(char) || isLineBreak(char, shell);
	let start = 0;
	let end = command.length;
	while (start < end && isSpace(command[start])) start++;
	while (end > start && isSpace(command[end - 1])) end--;
	return command.slice(start, end);
}

/**
 * Whether a shell command only reads. Every command in it must be listed in {@link BASH_COMMANDS}
 * or {@link POWERSHELL_COMMANDS} and use only the flags and subcommands listed there. Anything the
 * parser does not understand rejects the command. This stops accidental changes. It is not a sandbox.
 */
export function isReadOnlyShellCommand(command: string, shell: Shell): boolean {
	// bash reads a carriage return as part of a word, as in a file named "/dev/null\r".
	if (AMBIGUOUS.test(command) || (shell === "bash" && command.includes("\r"))) return false;
	const table = shell === "bash" ? BASH_COMMANDS : POWERSHELL_COMMANDS;
	const commands = parseCommands(trim(command, shell), shell);
	return (
		commands?.every(([{ text: name }, ...args]) => {
			const rule = lookup(table, shell === "bash" ? name : name.toLowerCase());
			return rule !== undefined && allowsArgs(rule, args);
		}) ?? false
	);
}
