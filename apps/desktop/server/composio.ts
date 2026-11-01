import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { addMcpServer, removeMcpServer } from "./mcp.ts";
import { desktopDir } from "./paths.ts";

/**
 * Composio Connect on the MCP page: one hosted MCP endpoint (connect.composio.dev/mcp) that reaches every app the
 * user connects in their Composio account. The user pastes their consumer key (ck_...), which this server keeps in
 * ~/.sorvex/agent/desktop/composio.json (mode 0600) and puts in the `composio` entry of the global mcp.json, the
 * header Composio's own setup asks for, so the CLI gets the same server.
 *
 * Apps come from Composio's public toolkit directory (the ranked popular apps with descriptions) and its sitemap
 * (every toolkit). Connection state and connect / disconnect go through the endpoint's COMPOSIO_MANAGE_CONNECTIONS
 * tool, the same one the agent uses.
 */

const ENDPOINT = "https://connect.composio.dev/mcp";
const DIRECTORY = "https://composio.dev/toolkits";
const SITEMAP = "https://composio.dev/toolkits/sitemap.xml";
const LOGO = (slug: string) => `https://logos.composio.dev/api/${slug}`;
const SERVER_NAME = "composio";
/**
 * The server entry. Direct exposure lists Composio's eleven tools with their exact schemas, so the model sees them up
 * front and calls them with the right arguments (in codemode it had to discover and guess them). The description goes
 * into the agent's MCP section and tool search.
 */
export const composioServerConfig = (key: string) => ({
	url: ENDPOINT,
	headers: { "x-consumer-api-key": key },
	exposure: "direct",
	timeout: 180,
	description:
		"The user's connected apps (Gmail, Slack, GitHub, Notion, Google Drive and others) through Composio. Find tools with COMPOSIO_SEARCH_TOOLS, check COMPOSIO_GET_TOOL_SCHEMAS, then run them with COMPOSIO_MULTI_EXECUTE_TOOL. If an app is not connected, COMPOSIO_MANAGE_CONNECTIONS returns a sign-in link for the user. Large results are saved in Composio's remote workbench (paths like /mnt/files/...): read them with COMPOSIO_REMOTE_BASH_TOOL or COMPOSIO_REMOTE_WORKBENCH, not the local read tool.",
});
const keyPath = join(desktopDir, "composio.json");
const catalogPath = join(desktopDir, "composio-catalog.json");
const CATALOG_MAX_AGE = 24 * 60 * 60 * 1000;
/** Toolkits per status request; the endpoint answers 120 in one call. */
const STATUS_BATCH = 120;

export interface ComposioApp {
	slug: string;
	name: string;
	description: string;
	logo: string;
	/** Rank in Composio's directory; popular apps have one. */
	rank: number | null;
}

export interface ComposioAccount {
	id: string;
	status: string;
	isDefault: boolean;
	email?: string;
	handle?: string;
}

interface ManageResult {
	toolkit: string;
	status: string;
	redirect_url?: string;
	accounts?: { id: string; status: string; is_default?: boolean; user_info?: { email?: string; handle?: string } }[];
}

const ACRONYMS = new Set(["api", "crm", "sms", "sql", "aws", "gcp", "cms", "pdf", "seo", "ssh", "erp", "hrm", "llm", "rss", "vpn", "dns", "url", "sdk"]);
const SPECIAL_NAMES: Record<string, string> = { github: "GitHub", gitlab: "GitLab", hubspot: "HubSpot", linkedin: "LinkedIn", youtube: "YouTube", openai: "OpenAI" };

/** "zoho_bigin" → "Zoho Bigin"; "amplitude_mcp" → "Amplitude (MCP)". */
function nameFromSlug(slug: string): string {
	if (SPECIAL_NAMES[slug]) return SPECIAL_NAMES[slug];
	const mcp = slug.endsWith("_mcp");
	const words = (mcp ? slug.slice(0, -4) : slug).split(/[_-]+/).filter(Boolean);
	const name = words.map((word) => (word.length <= 2 || ACRONYMS.has(word) ? word.toUpperCase() : word[0]!.toUpperCase() + word.slice(1))).join(" ");
	return mcp ? `${name} (MCP)` : name;
}

/** The toolkit list the directory page embeds in its React Server Components payload. */
function directoryToolkits(html: string): { slug: string; name: string; description: string; logo: string; rank: number }[] {
	const text = [...html.matchAll(/self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)<\/script>/g)]
		.map((match) => {
			try {
				return JSON.parse(`"${match[1]}"`) as string;
			} catch {
				return "";
			}
		})
		.join("");
	const at = text.indexOf('{"toolkits":[');
	if (at === -1) return [];
	const start = at + '{"toolkits":'.length;
	let depth = 0;
	for (let index = start; index < text.length; index++) {
		if (text[index] === "[") depth++;
		else if (text[index] === "]" && --depth === 0) {
			try {
				return JSON.parse(text.slice(start, index + 1));
			} catch {
				return [];
			}
		}
	}
	return [];
}

export class Composio {
	private catalog: Promise<ComposioApp[]> | undefined;

	private readKey(): string | null {
		try {
			const key = (JSON.parse(readFileSync(keyPath, "utf8")) as { apiKey?: string }).apiKey;
			return key?.trim() || null;
		} catch {
			return null;
		}
	}

	status(): { configured: boolean; keyHint: string | null } {
		const key = this.readKey();
		return { configured: Boolean(key), keyHint: key ? `${key.slice(0, 5)}…${key.slice(-4)}` : null };
	}

	/** One JSON-RPC call to the endpoint; it answers over SSE, and the last `data:` line is the response. */
	private async rpc(key: string, method: string, params: unknown): Promise<unknown> {
		const response = await fetch(ENDPOINT, {
			method: "POST",
			headers: {
				"x-consumer-api-key": key,
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
				"mcp-protocol-version": "2025-06-18",
			},
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
			signal: AbortSignal.timeout(90_000),
		});
		const text = await response.text();
		if (response.status === 401 || response.status === 403) throw new Error("Composio rejected the API key. Copy it again from the Composio dashboard.");
		if (!response.ok) throw new Error(`Composio answered ${response.status}: ${text.slice(0, 200)}`);
		const data = text
			.split(/\r?\n/)
			.filter((line) => line.startsWith("data:"))
			.map((line) => line.slice(5).trim())
			.at(-1);
		const message = JSON.parse(data ?? text) as { result?: unknown; error?: { message?: string } };
		if (message.error) throw new Error(`Composio: ${message.error.message ?? "request failed"}`);
		return message.result;
	}

	private async manage(toolkits: { name: string; action: "list" | "add" | "remove"; account_id?: string }[]): Promise<Record<string, ManageResult>> {
		const key = this.readKey();
		if (!key) throw new Error("Add your Composio API key first");
		const result = (await this.rpc(key, "tools/call", { name: "COMPOSIO_MANAGE_CONNECTIONS", arguments: { toolkits } })) as {
			content?: { type: string; text?: string }[];
			isError?: boolean;
		};
		const text = result.content?.find((block) => block.type === "text")?.text ?? "";
		let parsed: { successful?: boolean; error?: string | null; data?: { results?: Record<string, ManageResult> } };
		try {
			parsed = JSON.parse(text);
		} catch {
			throw new Error(`Composio: ${text.slice(0, 300) || "unexpected response"}`);
		}
		if (result.isError || parsed.successful === false) throw new Error(`Composio: ${parsed.error ?? text.slice(0, 300)}`);
		return parsed.data?.results ?? {};
	}

	/** Checks the key against the endpoint, saves it, and adds (or updates) the `composio` MCP server. */
	async setKey(apiKey: string): Promise<{ tools: number }> {
		const key = apiKey.trim();
		if (!/^[A-Za-z0-9_-]{8,}$/.test(key)) throw new Error("That does not look like a Composio API key");
		const listed = (await this.rpc(key, "tools/list", {})) as { tools?: unknown[] };
		mkdirSync(desktopDir, { recursive: true });
		writeFileSync(keyPath, `${JSON.stringify({ apiKey: key }, null, "\t")}\n`, { mode: 0o600 });
		chmodSync(keyPath, 0o600);
		addMcpServer(process.cwd(), "global", SERVER_NAME, composioServerConfig(key));
		return { tools: listed.tools?.length ?? 0 };
	}

	/** Forgets the key and removes the `composio` MCP server. Connected apps stay connected in the Composio account. */
	removeKey(): void {
		rmSync(keyPath, { force: true });
		removeMcpServer(process.cwd(), "global", SERVER_NAME);
	}

	/** Popular apps (ranked, with descriptions) first, then every other toolkit alphabetically. Cached for a day. */
	apps(): Promise<ComposioApp[]> {
		if (existsSync(catalogPath)) {
			try {
				const cached = JSON.parse(readFileSync(catalogPath, "utf8")) as { at: number; apps: ComposioApp[] };
				if (Date.now() - cached.at < CATALOG_MAX_AGE && cached.apps.length > 0) return Promise.resolve(cached.apps);
			} catch {
				// Rebuild below.
			}
		}
		this.catalog ??= this.loadCatalog().finally(() => {
			this.catalog = undefined;
		});
		return this.catalog;
	}

	private async loadCatalog(): Promise<ComposioApp[]> {
		const [html, sitemap] = await Promise.all([
			fetch(DIRECTORY, { signal: AbortSignal.timeout(60_000) }).then((response) => (response.ok ? response.text() : "")),
			fetch(SITEMAP, { signal: AbortSignal.timeout(60_000) }).then((response) => (response.ok ? response.text() : "")),
		]);
		const popular = directoryToolkits(html);
		const apps = new Map<string, ComposioApp>();
		for (const toolkit of popular) {
			apps.set(toolkit.slug, { slug: toolkit.slug, name: toolkit.name, description: toolkit.description?.split("\n")[0] ?? "", logo: toolkit.logo || LOGO(toolkit.slug), rank: toolkit.rank });
		}
		for (const match of sitemap.matchAll(/<loc>https:\/\/composio\.dev\/toolkits\/([a-z0-9_]+)<\/loc>/g)) {
			const slug = match[1]!;
			if (!apps.has(slug)) apps.set(slug, { slug, name: nameFromSlug(slug), description: "", logo: LOGO(slug), rank: null });
		}
		if (apps.size === 0) throw new Error("Could not load Composio's app list");
		const list = [...apps.values()].sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity) || a.name.localeCompare(b.name));
		writeFileSync(catalogPath, JSON.stringify({ at: Date.now(), apps: list }));
		return list;
	}

	/** Active and pending accounts per app, for the given toolkit slugs. */
	async connections(slugs: string[]): Promise<Record<string, ComposioAccount[]>> {
		const unique = [...new Set(slugs.filter((slug) => /^[a-z0-9_]+$/.test(slug)))];
		const out: Record<string, ComposioAccount[]> = {};
		for (let index = 0; index < unique.length; index += STATUS_BATCH) {
			const results = await this.manage(unique.slice(index, index + STATUS_BATCH).map((name) => ({ name, action: "list" as const })));
			for (const [slug, result] of Object.entries(results)) {
				out[slug] = (result.accounts ?? []).map((account) => ({
					id: account.id,
					status: account.status,
					isDefault: account.is_default === true,
					email: account.user_info?.email,
					handle: account.user_info?.handle,
				}));
			}
		}
		return out;
	}

	/** Starts a connection and returns the page where the user signs in to the app. */
	async connect(slug: string): Promise<{ url: string; accountId: string | null }> {
		if (!/^[a-z0-9_]+$/.test(slug)) throw new Error("Not a Composio app");
		const result = (await this.manage([{ name: slug, action: "add" }]))[slug];
		if (!result?.redirect_url) throw new Error(`Composio did not return a sign-in link for ${slug}`);
		const pending = result.accounts?.find((account) => account.status !== "active");
		return { url: result.redirect_url, accountId: pending?.id ?? null };
	}

	/** Removes one connected (or pending) account of an app from the Composio account. */
	async disconnect(slug: string, accountId: string): Promise<void> {
		if (!/^[a-z0-9_]+$/.test(slug)) throw new Error("Not a Composio app");
		await this.manage([{ name: slug, action: "remove", account_id: accountId }]);
	}
}
