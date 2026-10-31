import { getAgentDir, ModelRuntime, SettingsManager } from "@sorvex/coding-agent";
import type { Hub } from "./hub.ts";

/** Model-call types, taken from ModelRuntime so this app needs no direct dependency on the ai package. */
export type TurnContext = Parameters<ModelRuntime["streamSimple"]>[1];
export type TurnMessage = Awaited<ReturnType<ReturnType<ModelRuntime["streamSimple"]>["result"]>>;
export type TurnEvent = { type: "text"; delta: string };

/**
 * Credentials and model calls through Sorvex's own ModelRuntime, so ~/.sorvex/agent/auth.json is read and
 * written exactly as `/login` does it. API keys stay in this process and never reach the webview.
 *
 * A login runs Sorvex's provider flow (API key prompt, browser OAuth, or device code). Each prompt the flow
 * raises is pushed to the UI as an `auth` event and resolved by `answer()`.
 */
export class Credentials {
	private readonly runtime: ModelRuntime;
	private readonly settings: SettingsManager;
	private readonly hub: Hub;
	private readonly prompts = new Map<string, { resolve: (value: string) => void; reject: (error: Error) => void }>();
	private readonly logins = new Map<string, AbortController>();
	private counter = 0;

	private constructor(runtime: ModelRuntime, hub: Hub) {
		this.runtime = runtime;
		this.hub = hub;
		this.settings = SettingsManager.create(process.cwd(), getAgentDir());
	}

	static async create(hub: Hub): Promise<Credentials> {
		return new Credentials(await ModelRuntime.create({ allowModelNetwork: false }), hub);
	}

	async providers() {
		await this.runtime.refresh({ allowNetwork: false });
		return this.runtime
			.getProviders()
			.map((provider) => {
				const status = this.runtime.getProviderAuthStatus(provider.id);
				return {
					id: provider.id,
					name: provider.name,
					apiKey: provider.auth.apiKey !== undefined,
					oauth: provider.auth.oauth
						? { name: provider.auth.oauth.name, subscription: provider.auth.oauth.isSubscription === true }
						: null,
					configured: status.configured,
					source: status.source ?? null,
					label: status.label ?? null,
					usingOAuth: this.runtime.isUsingOAuth(provider.id),
				};
			})
			.sort((a, b) => a.name.localeCompare(b.name));
	}

	/**
	 * Starts a login under a caller-chosen id. The UI picks the id so it can match prompts that arrive on the
	 * event stream before this request's response does. Completion arrives as an `auth` event with kind "done".
	 */
	startLogin(loginId: string, providerId: string, authType: "api_key" | "oauth", onSuccess: () => void): string {
		const controller = new AbortController();
		this.logins.set(loginId, controller);
		this.runtime
			.login(
				providerId,
				authType,
				{
					signal: controller.signal,
					prompt: (prompt) =>
						new Promise<string>((resolve, reject) => {
							const promptId = `prompt-${++this.counter}`;
							this.prompts.set(promptId, { resolve, reject });
							controller.signal.addEventListener("abort", () => reject(new Error("Login cancelled")), { once: true });
							const { signal: _signal, ...visible } = prompt;
							this.hub.broadcast("auth", { kind: "prompt", loginId, promptId, prompt: visible });
						}),
					notify: (event) => this.hub.broadcast("auth", { kind: "event", loginId, event }),
				},
				{ getDeviceId: () => this.settings.getOrCreateDeviceId(), agentName: "Sorvex Desktop" },
			)
			.then(
				() => {
					this.hub.broadcast("auth", { kind: "done", loginId, ok: true });
					onSuccess();
				},
				(error: unknown) =>
					this.hub.broadcast("auth", {
						kind: "done",
						loginId,
						ok: false,
						error: error instanceof Error ? error.message : String(error),
					}),
			)
			.finally(() => this.logins.delete(loginId));
		return loginId;
	}

	answer(promptId: string, value: string): void {
		const prompt = this.prompts.get(promptId);
		this.prompts.delete(promptId);
		prompt?.resolve(value);
	}

	cancel(loginId: string): void {
		this.logins.get(loginId)?.abort();
	}

	logout(providerId: string): Promise<void> {
		return this.runtime.logout(providerId);
	}

	/** The stored key and base URL for a provider, for speech endpoints. Undefined provider means no key. */
	async keyFor(providerId: string | undefined): Promise<string | undefined> {
		if (!providerId) return undefined;
		const result = await this.runtime.getAuth(providerId);
		if (!result?.auth.apiKey) throw new Error(`No credential for ${providerId}. Add one on the Providers page.`);
		return result.auth.apiKey;
	}

	/**
	 * One streamed model turn for the side chat: `context` may include tools. Text deltas and finished tool calls go
	 * to `onEvent`; resolves with the final assistant message. Aborting `signal` stops it.
	 */
	async turn(model: string, context: TurnContext, onEvent: (event: TurnEvent) => void, signal: AbortSignal): Promise<TurnMessage> {
		const [provider = "", ...rest] = model.split("/");
		const resolved = this.runtime.getModel(provider, rest.join("/"));
		if (!resolved) throw new Error(`Unknown model ${model}`);
		const events = this.runtime.streamSimple(resolved, context, { signal });
		for await (const event of events) {
			if (event.type === "text_delta") onEvent({ type: "text", delta: event.delta });
		}
		return events.result();
	}

	/** One-shot completion, used by LLM guardrail reviewers. `model` is "provider/id". */
	async complete(model: string, systemPrompt: string, content: string): Promise<string> {
		const [provider = "", ...rest] = model.split("/");
		const resolved = this.runtime.getModel(provider, rest.join("/"));
		if (!resolved) throw new Error(`Unknown reviewer model ${model}`);
		const message = await this.runtime.completeSimple(resolved, {
			systemPrompt,
			messages: [{ role: "user", content, timestamp: Date.now() }],
		});
		if (message.stopReason === "error") throw new Error(message.errorMessage ?? "Review failed");
		return message.content
			.filter((block): block is { type: "text"; text: string } => block.type === "text")
			.map((block) => block.text)
			.join("");
	}
}
