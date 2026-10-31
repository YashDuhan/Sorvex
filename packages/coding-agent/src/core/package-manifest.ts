import { readFileSync } from "node:fs";
import { stripBom } from "../utils/text.ts";

export interface PackageManifest {
	extensions?: string[];
	skills?: string[];
	prompts?: string[];
	themes?: string[];
}

const RESOURCE_FIELDS = ["extensions", "skills", "prompts", "themes"] as const;

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The resource manifest under the `sorvex` key of a package.json, or under the `pi` key when there is no `sorvex`
 * object, so packages written for pi keep loading. A `sorvex` object replaces the `pi` one; they are not merged.
 */
export function readPackageManifest(packageJsonPath: string): PackageManifest | null {
	try {
		const pkg: unknown = JSON.parse(stripBom(readFileSync(packageJsonPath, "utf-8")));
		if (!isObject(pkg)) return null;
		const source = isObject(pkg.sorvex) ? pkg.sorvex : isObject(pkg.pi) ? pkg.pi : undefined;
		if (!source) return null;

		const manifest: PackageManifest = {};
		for (const field of RESOURCE_FIELDS) {
			const entries = source[field];
			if (Array.isArray(entries) && entries.every((entry) => typeof entry === "string")) {
				manifest[field] = entries;
			}
		}
		return manifest;
	} catch {
		return null;
	}
}
