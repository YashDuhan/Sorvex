import { describe, expect, it } from "vitest";
import { isReadOnlyShellCommand } from "../src/extensions/plan/bash-allowlist.ts";

const allowedInBash = [
	"git status",
	"git log --oneline -5",
	"git --no-pager log -3 --format='%h %s'",
	"git diff HEAD~1 -- src",
	"git diff --stat --cached",
	"git show HEAD:src/a.ts",
	"git blame -L 1,10 a.ts",
	"git branch",
	"git branch --list -a",
	"git ls-files | wc -l",
	"git rev-parse --show-toplevel",
	"git remote -v",
	"ls -la",
	"ls src/*.ts",
	"cat package.json",
	"head -n 5 a.txt",
	"tail -5 a.txt",
	"wc -l src/a.ts",
	"rg -n 'TODO' src",
	"rg --type ts -g '*.test.ts' plan",
	"find . -name '*.ts'",
	"find src -type f -mtime -7 -print",
	"grep -rn foo src | head -20",
	"cat a.txt | sort | uniq -c",
	"git status && git log -1",
	"git status; git log -1",
	"ls 2>/dev/null",
	"ls 2> /dev/null || echo missing",
	"git log 2>&1 | head",
	"sed -n '1,20p' file.ts",
	"sed -n 1p a.txt | grep -i plan",
	"curl -s https://example.com/docs",
	"curl -s https://example.com | grep -o 'href'",
	"tree -L 2 src",
	"jq -r .name package.json",
	"echo done",
	"pwd",
	"env",
	"git status\n",
	"git status -uall",
	"git status -uno --short",
	"git show -s HEAD",
	"git log -- -",
	"cat src/a*.ts",
	"grep -n foo src/*.ts",
	"sed -n 1p src/*.ts",
	"uniq -c 'a*'",
];

const allowedInPowerShell = [
	"Get-ChildItem -Recurse",
	"Get-ChildItem -Path src -Filter '*.ts' -Recurse | Select-Object -First 5",
	"gci src\\extensions",
	"Get-Content README.md | Select-String plan",
	"Get-Content -Path 'C:\\repo\\a.ts' -TotalCount 20",
	"Get-Content -Path:README.md -Raw | Measure-Object -Line",
	"Get-ChildItem | Out-Null",
	"ls 2> $null",
	"ls 2>$null",
	"git status 2>&1",
	"git log '--format=%h %s' -5",
	"git log '--format=it''s' -1",
	"Get-ChildItem src/*.ts",
	"Get-ChildItem *.ts",
	"Get-ChildItem -Filter *.ts",
	"Get-ChildItem -Path src -Include *.ts -Recurse",
	"Select-String -Pattern foo -Path *.ts",
	"Get-Content ?.txt",
	"git status -uall",
	"git show -s HEAD",
	"git log -- -",
];

const rejected = [
	// Writes or runs code through a redirect, flag, or subcommand.
	"echo x > $null.txt",
	'echo pwned >$null"o1.txt"',
	"printf pwned 1<>README.md",
	"echo x 1<>o2.txt",
	"cat notes.txt 1<>out.txt",
	"sed -n '1w out.txt' README.md",
	"sed -n 'w o3.txt' target.txt",
	"sed -n --in-place '1p' t5.txt",
	`sed -n "1e node -e \\"require('fs').writeFileSync('o12.txt','x')\\"" target.txt`,
	"sed -n '1e touch x' notes.txt",
	"sort -o README.md /dev/null",
	"uniq /dev/null README.md",
	`awk -i inplace '{print ""}' README.md`,
	"awk --dump-variables=o6.txt 'BEGIN{}'",
	"tree -o out.txt",
	"git diff --output=README.md",
	"git log --output=x",
	"git branch -f main HEAD~3",
	"git branch newbranch",
	"git branch -m a b",
	"git -c core.pager=touch log",
	"curl -D out.txt https://example.com",
	"curl -s -D o9.txt file:///C:/Windows/win.ini",
	"curl --trace f https://example.com",
	"curl --json '{}' https://example.com",
	"curl -c out.txt file:///etc/hosts",
	"wget -O - -o log.txt https://example.com",
	"npm audit fix",
	`fd -1 -x node -e "require('fs').writeFileSync('p','x')"`,
	"rg --pre node x script.js",
	"tail -f log.txt",
	"Measure-Command { ri README.md }",
	"gci *.ts | Where-Object { [IO.File]::Delete($_.FullName) }",
	"Get-Item ([IO.File]::WriteAllText('p','x'))",
	"ls ([IO.File]::WriteAllText('out.txt','x'))",
	"Get-Content -Wait log.txt",
	"Get-Content \u2013Wait log.txt",
	"git log HEAD\u00a0--output=x",
	"& git commit -m x",
	". ./script.ps1",
	"iex 'rm x'",
	"Invoke-Expression 'rm x'",
	"ls | % { rm $_ }",
	"[System.IO.File]::Delete('a')",
	"Get-ChildItem -Path C::x",
	"Set-Content out.txt x",
	"Get-Content notes.txt | Out-File out.txt",
	"Get-ChildItem > o16.txt",
	"Remove-Item x",
	"Get-Content a | Set-Content b",
	"ls (del x)",
	// Writes through plain commands, redirects, separators, and substitutions.
	"rm -rf x",
	"echo hi > file.txt",
	"echo hi >> file.txt",
	"ls >| out.txt",
	"ls &>out.txt",
	"ls 2>/dev/null.txt",
	"cat notes.txt | tee out.txt",
	"cat a |& tee b",
	"git commit -m wip",
	"git checkout main",
	"git remote add origin url",
	"npm install",
	"touch new.ts",
	"ls; rm x",
	"ls && python script.py",
	"cat x | sh",
	"cat x | xargs rm",
	"echo $(python -c 'import os')",
	"echo `whoami`",
	"find . -name '*.tmp' -delete",
	"find . -exec sh -c 'echo' \\;",
	"sed -n -i 's/a/b/' file",
	"sed -i s/foo/bar/ notes.txt",
	"curl -o out.html https://example.com",
	"curl -X POST https://example.com",
	"env python script.py",
	"python script.py",
	"node -e \"require('fs').writeFileSync('p','x')\"",
	"sleep 1 & ls",
	"ls;",
	"ls ; ; ls",
	"",
	"constructor",
	"git toString",
	// find reads its expression after `--`, and git reads a subcommand there.
	"find -- . -delete",
	"find -- . -maxdepth 0 -exec touch X ';'",
	"find -- . -fprint out",
	"find -- -fprintf x %p",
	"find -- -fls x",
	"find . -name x -- -delete",
	"git -- status",
	"tree -- -o out.txt",
	"curl -- -o out.txt file:///etc/hosts",
	"git diff -- -x",
	// bash ends the command at a line break after `2>`, so the next line runs as another command.
	"ls 2>\n/dev/null",
	"ls 2>\n$null",
	"git status -ux",
	"git status -u*",
];

describe("plan mode shell allowlist", () => {
	it.each(allowedInBash)("allows %j in bash", (command) => {
		expect(isReadOnlyShellCommand(command, "bash")).toBe(true);
	});

	it.each(allowedInPowerShell)("allows %j in PowerShell", (command) => {
		expect(isReadOnlyShellCommand(command, "powershell")).toBe(true);
	});

	it.each(rejected)("rejects %j in bash and PowerShell", (command) => {
		expect(isReadOnlyShellCommand(command, "bash")).toBe(false);
		expect(isReadOnlyShellCommand(command, "powershell")).toBe(false);
	});

	it.each([
		// bash reads \' as a quote character, so the redirect is outside quotes.
		"echo \\' > x \\'",
		// A glob at the start of a word can expand to a file named like a flag, such as -delete.
		"find * -name x",
		"ls ''*",
		// bash expands a glob anywhere in a word to any number of arguments. uniq writes to its second one.
		"uniq a*",
		"uniq u?",
		"uniq -c a*",
		"uniq ./a*",
		"uniq -c 'a'*",
		"uniq -c a*b",
		// Globs that shift a program, an expression, or a positional argument a command does not allow.
		"jq . a*",
		"find . -name a*",
		"find ./s* -name x",
		"git branch a*",
		"git remote a?",
		"pwd a*",
		"env a*",
		"uname s*",
	])("rejects %j in bash, which expands it differently than PowerShell", (command) => {
		expect(isReadOnlyShellCommand(command, "bash")).toBe(false);
	});

	it.each([
		// PowerShell ends a word that starts with a quote at the closing quote, so these are two arguments.
		"git diff 'HEAD'--output=out.txt",
		"find . 'x'-delete",
		"rg x '.'--pre=cmd",
		'git log "HEAD"--output=x',
		"git log 'a''b'--output=x",
		`git diff ."HEAD"--output=x`,
		"git diff .'HEAD'--output=x",
		"git diff a,'x'--output=x",
		`rg x a,"b"--pre=rm`,
		"git log a'b'",
		"git log --format='%h %s' -5",
		"git log a,b",
		// pwsh expands globs for programs, and a file can be named like a flag.
		"ls *",
		"cat ?x",
		"git log *",
		"jq . a*",
		"git branch a*",
		// Windows PowerShell passes these to programs so that they split into more arguments.
		`git log 'a" --output=x "b'`,
		'git log "a"" --output=x ""b"',
		"git log 'x y\\' ' --output=x'",
		// PowerShell reads a carriage return as a line break.
		"ls\rrm x",
	])("rejects %j in PowerShell, which splits it into other words", (command) => {
		expect(isReadOnlyShellCommand(command, "powershell")).toBe(false);
	});

	it.each(["sls x", "select x", "gc a.txt", "gci", "gi x", "measure", "LS", "GIT status", "Get-ChildItem"])(
		"rejects the PowerShell or differently cased name %j in bash",
		(command) => {
			expect(isReadOnlyShellCommand(command, "bash")).toBe(false);
		},
	);

	it.each(["GIT status", "Gci", "SLS x a.txt"])("matches PowerShell command names in any case: %j", (command) => {
		expect(isReadOnlyShellCommand(command, "powershell")).toBe(true);
	});

	it.each(["head -5 a.txt", "find . -name x", "curl -s https://example.com", "env"])(
		"rejects the bash-only command %j in PowerShell",
		(command) => {
			expect(isReadOnlyShellCommand(command, "powershell")).toBe(false);
		},
	);

	it("rejects a carriage return in bash, which reads it as part of a word", () => {
		// bash writes to a file named "/dev/null\r".
		expect(isReadOnlyShellCommand("ls 2>/dev/null\r; ls", "bash")).toBe(false);
		expect(isReadOnlyShellCommand("cat a.txt\r", "bash")).toBe(false);
		expect(isReadOnlyShellCommand("ls\rrm x", "bash")).toBe(false);
		expect(isReadOnlyShellCommand("git log -5\r", "bash")).toBe(false);
		expect(isReadOnlyShellCommand("\rgit status", "bash")).toBe(false);
	});

	it("allows only the null device of the shell that runs the command", () => {
		expect(isReadOnlyShellCommand("ls 2>$null", "bash")).toBe(false);
		expect(isReadOnlyShellCommand("ls 2>/dev/null", "powershell")).toBe(false);
	});

	it("checks a long command in linear time", () => {
		const words = "a ".repeat(100_000);
		const commands = [
			`rg '${words}\\' .`,
			`rg '${words}' .`,
			`ls${" ".repeat(200_000)}x`,
			`ls x${" \t".repeat(100_000)}`,
		];
		for (const shell of ["bash", "powershell"] as const) {
			for (const command of commands) {
				const start = performance.now();
				isReadOnlyShellCommand(command, shell);
				expect(performance.now() - start).toBeLessThan(200);
			}
		}
	});

	it("reads backslashes as escapes in bash and as path separators in PowerShell", () => {
		expect(isReadOnlyShellCommand("cat src\\a.ts", "bash")).toBe(false);
		expect(isReadOnlyShellCommand("cat src\\a.ts", "powershell")).toBe(true);
	});
});
