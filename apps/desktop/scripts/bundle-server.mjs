#!/usr/bin/env node
/**
 * Bundles the desktop server (server/index.ts and the workspace sources it imports) into one ES module that a plain
 * `node` runs without the source resolver. Used by the Windows installer build, which ships its own node.exe.
 *
 * Usage: node apps/desktop/scripts/bundle-server.mjs <out-dir>
 * Writes <out-dir>/server/index.mjs plus the files the server reads next to itself at runtime.
 */

import { cpSync, rmSync } from "node:fs";
import { isBuiltin } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(appDir, "../..");
const outArg = process.argv[2];
if (!outArg) throw new Error("Usage: bundle-server.mjs <out-dir>");
const outDir = resolve(outArg);

// Shipped as real packages in <out-dir>/server/node_modules: photon loads a .wasm next to its JS, and playwright-core
// resolves its own files at runtime.
const externalPackages = ["@silvia-odwyer/photon-node", "playwright-core"];
// Optional native accelerators for ws. Their callers fall back to JavaScript when absent.
const optionalPackages = ["bufferutil", "utf-8-validate"];

rmSync(join(outDir, "server"), { recursive: true, force: true });
rmSync(join(outDir, "extension"), { recursive: true, force: true });

const result = await build({
	absWorkingDir: repoRoot,
	entryPoints: [join(appDir, "server/index.ts")],
	outfile: join(outDir, "server/index.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22.19",
	// Resolve @sorvex/* to workspace sources, as the source resolver does in development.
	tsconfig: join(repoRoot, "tsconfig.json"),
	banner: { js: 'import { createRequire as __sorvexCreateRequire } from "node:module"; const require = __sorvexCreateRequire(import.meta.url);' },
	external: [...externalPackages, ...optionalPackages],
	// Package sideEffects lists name dist/ files, so honoring them would drop side-effect imports from the sources.
	ignoreAnnotations: true,
	legalComments: "none",
	logLevel: "warning",
	metafile: true,
	minifySyntax: true,
});

const unexpected = new Set();
for (const input of Object.values(result.metafile.inputs)) {
	for (const imported of input.imports) {
		if (imported.external && !isBuiltin(imported.path) && !optionalPackages.includes(imported.path) && !externalPackages.some((name) => imported.path === name || imported.path.startsWith(`${name}/`))) {
			unexpected.add(imported.path);
		}
	}
}
if (unexpected.size > 0) throw new Error(`Server bundle left unexpected external imports: ${[...unexpected].sort().join(", ")}`);

// Files the server reads relative to its own directory (see server/paths.ts).
for (const file of ["shell_pty.py", "kokoro-server.mjs"]) cpSync(join(appDir, "server", file), join(outDir, "server", file));
cpSync(join(appDir, "extension"), join(outDir, "extension"), { recursive: true });
for (const name of externalPackages) {
	cpSync(join(repoRoot, "node_modules", name), join(outDir, "server/node_modules", name), { recursive: true, dereference: true });
}

const bytes = Object.values(result.metafile.outputs).reduce((total, output) => total + output.bytes, 0);
console.log(`Bundled desktop server into ${outDir} (${(bytes / 1024 / 1024).toFixed(1)} MB)`);
