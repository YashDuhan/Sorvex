/**
 * Every live service Sorvex can call. An absent field turns its feature off; callers read this table and nothing else.
 */
export interface Endpoints {
	/** Latest-version API used by the startup update banner and `update --self`. */
	versionCheck?: string;
	/** Base URL of managed-install release artifacts used by `update --self` on managed installations. Needs `versionCheck`. */
	installerReleases?: string;
	/** URL pinged once per version after an install or update. */
	installReport?: string;
	/** URL that receives uploaded `/bug` reports. */
	bugReportUpload?: string;
	/** Base URL of the session viewer. Absent also turns `/share` off. */
	shareViewer?: string;
	/** Base URL of the model catalog. */
	modelCatalog: string;
	/** Base URL of the MCP OAuth Client ID Metadata Documents. */
	mcpOAuthClientMetadata: string;
}

export const DEFAULT_ENDPOINTS: Endpoints = {
	modelCatalog: "https://pi.dev",
	mcpOAuthClientMetadata: "https://pi.dev/oauth",
};

const warnedInvalid = new Set<string>();

/** Forget which invalid overrides were already warned about, so each warns again. */
export function resetEndpointWarnings(): void {
	warnedInvalid.clear();
}

function isHttpUrl(value: string): boolean {
	const protocol = URL.canParse(value) ? new URL(value).protocol : undefined;
	return protocol === "http:" || protocol === "https:";
}

/** The trimmed value of `env[name]` when it is set but not an `http(s)` URL, otherwise undefined. */
export function getInvalidOverride(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
	const value = env[name]?.trim();
	return value && !isHttpUrl(value) ? value : undefined;
}

/** A trimmed `http(s)` URL from `env[name]`, or undefined. An invalid value is treated as absent and warned about once. */
function override(env: NodeJS.ProcessEnv, name: string): string | undefined {
	const value = env[name]?.trim();
	if (!value) return undefined;
	if (isHttpUrl(value)) return value;
	if (!warnedInvalid.has(name)) {
		warnedInvalid.add(name);
		console.warn(`Ignoring ${name}: ${JSON.stringify(value)} is not an http(s) URL.`);
	}
	return undefined;
}

/** The endpoint table: the defaults plus the `SORVEX_*` overrides that switch an off feature on. */
export function getEndpoints(env: NodeJS.ProcessEnv = process.env): Endpoints {
	return {
		...DEFAULT_ENDPOINTS,
		versionCheck: override(env, "SORVEX_VERSION_CHECK_URL"),
		installerReleases: override(env, "SORVEX_INSTALLER_API_BASE"),
		installReport: override(env, "SORVEX_INSTALL_REPORT_URL"),
		bugReportUpload: override(env, "SORVEX_BUG_REPORT_URL"),
		shareViewer: override(env, "SORVEX_SHARE_VIEWER_URL"),
	};
}
