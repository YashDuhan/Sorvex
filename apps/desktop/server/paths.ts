import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getAgentDir } from "@sorvex/coding-agent";

/** apps/desktop */
export const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** The Sorvex checkout this app lives in. */
export const repoRoot = resolve(appDir, "../..");

export const cliPath = join(repoRoot, "packages/coding-agent/src/cli.ts");
export const resolverUrl = pathToFileURL(join(repoRoot, "packages/coding-agent/src/experimental/source-resolver.ts")).href;
export const bridgeExtension = join(appDir, "extension/gui-bridge.ts");
export const distDir = join(appDir, "dist");

/** Settings and the optional Kokoro install live next to Sorvex's own data. */
export const desktopDir = join(getAgentDir(), "desktop");
export const settingsPath = join(desktopDir, "settings.json");
export const kokoroDir = join(desktopDir, "kokoro");

export const hasSourceCheckout = existsSync(cliPath);
