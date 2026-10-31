import { join } from "node:path";
import { Agent, type AgentMessage, setDefaultStreamFn, type ThinkingLevel } from "@sorvex/agent-core";
import type { ModelsSimpleStreamOptions } from "@sorvex/ai";
import { clampThinkingLevel, type Message, type Model, streamSimple } from "@sorvex/ai/compat";
import { getAgentDir } from "../config.ts";
import { resolvePath } from "../utils/paths.ts";
import { AgentSession } from "./agent-session.ts";
import { formatNoModelsAvailableMessage } from "./auth-guidance.ts";
import { CacheWarmer } from "./cache-warmer.ts";
import { getClientIdentity } from "./client-identity.ts";
import { DEFAULT_THINKING_LEVEL } from "./defaults.ts";
import type {
	ChildSessionFactory,
	ChildSessionFork,
	ExtensionRunner,
	InlineExtension,
	LoadExtensionsResult,
	SessionStartEvent,
	ToolDefinition,
} from "./extensions/index.ts";
import { emitSessionShutdownEvent } from "./extensions/runner.ts";
import { createToolNameMatcher } from "./mcp-servers.ts";
import { convertToLlm } from "./messages.ts";
import { findInitialModel } from "./model-resolver.ts";
import { ModelRuntime } from "./model-runtime.ts";
import type { ResourceLoader } from "./resource-loader.ts";
import { DefaultResourceLoader, isBuiltinExtension } from "./resource-loader.ts";
import { type FileEntry, getDefaultSessionDir, SessionManager } from "./session-manager.ts";
import {
	applyToolModifiers,
	DEFAULT_TOOL_NAMES,
	getToolListError,
	isToolModifier,
	SettingsManager,
} from "./settings-manager.ts";
import { BUILTIN_PATH_PREFIX } from "./source-info.ts";
import { time } from "./timings.ts";
import {
	createBashTool,
	createCodingTools,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createPowerShellTool,
	createReadOnlyTools,
	createReadTool,
	createWriteTool,
	withFileMutationQueue,
} from "./tools/index.ts";
import { isChildProjectTrusted, ProjectTrustStore } from "./trust-manager.ts";
import { getBranchSelection } from "./virtual-models.ts";

// Preserve the pre-0.81 fallback for extensions that construct Agent instances
// or invoke low-level agent loops without supplying streamFn. Agent core remains
// provider-agnostic and does not import pi-ai/compat itself.
setDefaultStreamFn(streamSimple);

export interface CreateAgentSessionOptions {
	/** Working directory for project-local discovery. Default: process.cwd() */
	cwd?: string;
	/** Global config directory. Default: ~/.pi/agent */
	agentDir?: string;

	/** Canonical model/auth runtime. Defaults to a runtime using agentDir/auth.json and models.json. */
	modelRuntime?: ModelRuntime;

	/** Model to use. Default: from settings, else first available */
	model?: Model<any>;
	/** Thinking level. Default: from settings, else 'medium' (clamped to model capabilities) */
	thinkingLevel?: ThinkingLevel;
	/** Models available for cycling (Ctrl+P in interactive mode) */
	scopedModels?: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;

	/**
	 * Optional default tool suppression mode when no explicit allowlist is provided.
	 *
	 * - "all": start with no tools enabled
	 * - "builtin": disable the default built-in tools (read, bash, edit, write)
	 *   but keep extension/custom tools enabled
	 */
	noTools?: "all" | "builtin";
	/**
	 * Optional allowlist of tool names or patterns, where `*` matches any characters.
	 *
	 * When omitted, pi uses the resolved `defaultTools` setting for the initial
	 * selection when configured. Otherwise it enables the default built-in tools
	 * (read, bash, edit, write). Extension/custom tools remain enabled unless
	 * `noTools` changes that default. When provided, only matching tools are
	 * enabled. MCP tools stay registered for codemode and tool search unless an
	 * entry starts with `mcp__`; then only matching MCP tools are kept. An empty
	 * list, like `noTools: "all"`, disables MCP tools too.
	 *
	 * A list of only `+name` and `-name` entries is not an allowlist: it adds tools
	 * to or removes them from the default selection, like the `defaultTools` setting.
	 * These entries take exact names. Mixing them with plain entries throws.
	 */
	tools?: string[];
	/**
	 * Optional denylist of tool names or patterns to disable. Applies after `tools` when both are
	 * provided, MCP tools included.
	 */
	excludeTools?: string[];
	/** Custom tools to register (in addition to built-in tools). */
	customTools?: ToolDefinition[];

	/** Resource loader. When omitted, DefaultResourceLoader is used. */
	resourceLoader?: ResourceLoader;

	/** Session manager. Default: SessionManager.create(cwd) */
	sessionManager?: SessionManager;

	/** Settings manager. Default: SettingsManager.create(cwd, agentDir) */
	settingsManager?: SettingsManager;
	/** Session start event metadata for extension runtime startup. */
	sessionStartEvent?: SessionStartEvent;
	/**
	 * Built-in extensions a child session (`ctx.createChildSession()`) may load. A child loads those of
	 * them this session loaded. The SDK's default resource loader loads no built-in extensions, so the
	 * CLI passes its list here. Default: none.
	 */
	childExtensions?: InlineExtension[];
	/** Backs `ctx.createChildSession()`. Default: {@link createChildSessionFactory} for this session. */
	createChildSession?: ChildSessionFactory;
	/**
	 * Make this session a fork child that declares its parent's system prompt and tools. Pass a
	 * `sessionManager` that holds `fork.messages`, as {@link createChildSessionFactory} does.
	 */
	fork?: ChildSessionFork;
	/** Once it aborts, `prompt()` returns without starting a run. It does not abort a running turn. */
	signal?: AbortSignal;
}

/** Nesting limit for child sessions. A child at this depth cannot create children of its own. */
export const MAX_CHILD_SESSION_DEPTH = 2;

export interface ChildSessionFactoryOptions {
	agentDir: string;
	/** Shared with the parent, so children see providers that extensions registered. */
	modelRuntime: ModelRuntime;
	/**
	 * Extensions each child loads. User and project extensions never load in a child. Providers and
	 * virtual models they register while loading are dropped: the parent registered them already.
	 */
	getExtensions: () => InlineExtension[];
	/** Project trust for a child's working directory. */
	isProjectTrusted: (cwd: string) => boolean;
	/** Depth of the sessions this factory creates. The top-level session is depth 0. Default: 1. */
	depth?: number;
}

function extensionName(extension: InlineExtension): string | undefined {
	return typeof extension === "function" ? undefined : extension.name;
}

/** A fork child's transcript: one message entry per message of the parent's context. */
function forkEntries(fork: ChildSessionFork): FileEntry[] {
	const timestamp = new Date().toISOString();
	return fork.messages.map((message, index) => ({
		type: "message",
		id: `fork-${index}`,
		parentId: index === 0 ? null : `fork-${index - 1}`,
		timestamp,
		message,
	}));
}

/**
 * Blocks a fork child's calls to the tools it declares only because its parent does. Calls that
 * another tool makes, such as a codemode script, are left to the tools the child has.
 */
function forkToolLimit(tools: readonly string[]): InlineExtension {
	const allowed = createToolNameMatcher(tools);
	const list = tools.length > 0 ? tools.join(", ") : "none";
	return {
		name: "fork-tool-limit",
		factory: (pi) => {
			pi.on("tool_call", (event) => {
				if (event.parentToolCallId !== undefined || allowed(event.toolName)) return;
				return {
					block: true,
					reason: `${event.toolName} is not one of this agent's tools, so it did not run. Its tools: ${list}.`,
				};
			});
		},
	};
}

/**
 * Create child sessions in-process: an in-memory session on a fresh resource loader and settings
 * manager, so the parent's extension actions (`sendMessage`, `appendEntry`) never reach the child or
 * the other way round. The child's extensions get `session_start` in print mode, which registers MCP
 * servers. A child at {@link MAX_CHILD_SESSION_DEPTH} gets no `subagent` extension.
 */
export function createChildSessionFactory(factoryOptions: ChildSessionFactoryOptions): ChildSessionFactory {
	const depth = factoryOptions.depth ?? 1;
	return async (options) => {
		if (depth > MAX_CHILD_SESSION_DEPTH) {
			throw new Error(`Child sessions nest at most ${MAX_CHILD_SESSION_DEPTH} levels deep.`);
		}
		const { agentDir, modelRuntime } = factoryOptions;
		const cwd = resolvePath(options.cwd);
		const extensions = factoryOptions
			.getExtensions()
			.filter((extension) => depth < MAX_CHILD_SESSION_DEPTH || extensionName(extension) !== "subagent");
		if (options.fork) extensions.push(forkToolLimit(options.tools));
		const settingsManager = SettingsManager.create(cwd, agentDir, {
			projectTrusted: factoryOptions.isProjectTrusted(cwd),
		});
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
			extensionFactories: extensions,
			additionalExtensionPaths: extensions
				.filter(isBuiltinExtension)
				.map((extension) => `${BUILTIN_PATH_PREFIX}${extension.name}`),
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			// The built-in default prompt, not a SYSTEM.md, with the agent's prompt appended.
			systemPromptOverride: () => undefined,
			appendSystemPrompt: [],
			appendSystemPromptOverride: () => [options.systemPrompt],
		});
		await resourceLoader.reload();
		// The parent loaded these extensions and registered their providers on the shared runtime.
		// Registering them again would swap the parent's provider objects for the child's and refresh
		// the whole runtime once per child, which is how the llama.cpp built-in grew the heap per child.
		const extensionRuntime = resourceLoader.getExtensions().runtime;
		extensionRuntime.pendingProviderRegistrations = [];
		extensionRuntime.pendingNativeProviderRegistrations = [];
		extensionRuntime.pendingVirtualModelRegistrations = [];
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			modelRuntime,
			model: options.model,
			thinkingLevel: options.thinkingLevel,
			tools: options.tools,
			resourceLoader,
			sessionManager: options.fork
				? SessionManager.inMemory(cwd, undefined, forkEntries(options.fork))
				: SessionManager.inMemory(cwd),
			settingsManager,
			signal: options.signal,
			fork: options.fork,
			createChildSession: createChildSessionFactory({ ...factoryOptions, depth: depth + 1 }),
		});

		// A failed abort leaves the run to end on its own; the caller sees its outcome from prompt().
		const abort = () => void session.abort().catch(() => {});
		let disposed: Promise<void> | undefined;
		const dispose = async () => {
			options.signal?.removeEventListener("abort", abort);
			try {
				await emitSessionShutdownEvent(session.extensionRunner, { type: "session_shutdown", reason: "quit" });
			} finally {
				session.dispose();
			}
		};
		const disposeOnce = () => {
			disposed ??= dispose();
			return disposed;
		};
		try {
			await session.bindExtensions({ mode: "print" });
		} catch (error) {
			await disposeOnce();
			throw error;
		}
		options.signal?.addEventListener("abort", abort, { once: true });
		if (options.signal?.aborted) abort();
		return { session, dispose: disposeOnce };
	};
}

/** Result from createAgentSession */
export interface CreateAgentSessionResult {
	/** The created session */
	session: AgentSession;
	/** Extensions result (for UI context setup in interactive mode) */
	extensionsResult: LoadExtensionsResult;
	/** Warning if session was restored with a different model than saved */
	modelFallbackMessage?: string;
}

// Re-exports

export * from "./agent-session-runtime.ts";
export type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionFactory,
	InlineExtension,
	SlashCommandInfo,
	SlashCommandSource,
	ToolDefinition,
} from "./extensions/index.ts";
export type { PromptTemplate } from "./prompt-templates.ts";
export type { Skill } from "./skills.ts";
export type { Tool } from "./tools/index.ts";

export {
	withFileMutationQueue,
	// Tool factories (for custom cwd)
	createCodingTools,
	createReadOnlyTools,
	createReadTool,
	createBashTool,
	createEditTool,
	createWriteTool,
	createGrepTool,
	createFindTool,
	createLsTool,
	createPowerShellTool,
};

// Helper Functions

function getDefaultAgentDir(): string {
	return getAgentDir();
}

/**
 * Create an AgentSession with the specified options.
 *
 * @example
 * ```typescript
 * // Minimal - uses defaults
 * const { session } = await createAgentSession();
 *
 * // With explicit model
 * import { getModel } from '@sorvex/ai';
 * const { session } = await createAgentSession({
 *   model: getModel('anthropic', 'claude-opus-4-5'),
 *   thinkingLevel: 'high',
 * });
 *
 * // Continue previous session
 * const { session, modelFallbackMessage } = await createAgentSession({
 *   continueSession: true,
 * });
 *
 * // Full control
 * const loader = new DefaultResourceLoader({
 *   cwd: process.cwd(),
 *   agentDir: getAgentDir(),
 *   settingsManager: SettingsManager.create(),
 * });
 * await loader.reload();
 * const { session } = await createAgentSession({
 *   model: myModel,
 *   tools: ["read", "bash"],
 *   resourceLoader: loader,
 *   sessionManager: SessionManager.inMemory(),
 * });
 * ```
 */
export async function createAgentSession(options: CreateAgentSessionOptions = {}): Promise<CreateAgentSessionResult> {
	const cwd = resolvePath(options.cwd ?? options.sessionManager?.getCwd() ?? process.cwd());
	const agentDir = options.agentDir ? resolvePath(options.agentDir) : getDefaultAgentDir();
	let resourceLoader = options.resourceLoader;

	const authPath = options.agentDir ? join(agentDir, "auth.json") : undefined;
	const modelsPath = options.agentDir ? join(agentDir, "models.json") : undefined;
	const modelRuntime = options.modelRuntime ?? (await ModelRuntime.create({ authPath, modelsPath }));

	const settingsManager = options.settingsManager ?? SettingsManager.create(cwd, agentDir);
	const sessionManager = options.sessionManager ?? SessionManager.create(cwd, getDefaultSessionDir(cwd, agentDir));

	if (!resourceLoader) {
		resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
		await resourceLoader.reload();
		time("resourceLoader.reload");
	}
	const loadedResourceLoader = resourceLoader;

	// Check if session has existing data to restore
	const existingSession = sessionManager.buildSessionContext();
	const hasExistingSession = existingSession.messages.length > 0;
	const hasThinkingEntry = sessionManager.getBranch().some((entry) => entry.type === "thinking_level_change");

	let model = options.model;
	let modelFallbackMessage: string | undefined;

	// Assistant messages name the physical model that answered, so a virtual selection is only in
	// model_change entries.
	const sessionModel = getBranchSelection(sessionManager.getBranch(), (provider, modelId) =>
		modelRuntime.getModel(provider, modelId),
	);

	// If session has data, try to restore model from it
	if (!model && hasExistingSession && sessionModel) {
		const restoredModel = modelRuntime.getModel(sessionModel.provider, sessionModel.modelId);
		if (restoredModel && modelRuntime.hasConfiguredAuth(restoredModel.provider)) {
			model = restoredModel;
		}
		if (!model) {
			modelFallbackMessage = `Could not restore model ${sessionModel.provider}/${sessionModel.modelId}`;
		}
	}

	// If still no model, use findInitialModel (checks settings default, then provider defaults)
	if (!model) {
		const result = await findInitialModel({
			scopedModels: [],
			isContinuing: hasExistingSession,
			defaultProvider: settingsManager.getDefaultProvider(),
			defaultModelId: settingsManager.getDefaultModel(),
			defaultThinkingLevel: settingsManager.getDefaultThinkingLevel(),
			modelThinkingLevels: settingsManager.getAllModelThinkingLevels(),
			modelRuntime,
		});
		model = result.model;
		if (!model) {
			modelFallbackMessage = formatNoModelsAvailableMessage();
		} else if (modelFallbackMessage) {
			modelFallbackMessage += `. Using ${model.provider}/${model.id}`;
		}
	}

	let thinkingLevel = options.thinkingLevel;

	// If session has data, restore thinking level from it
	if (thinkingLevel === undefined && hasExistingSession) {
		thinkingLevel = hasThinkingEntry
			? (existingSession.thinkingLevel as ThinkingLevel)
			: (settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL);
	}

	// Fall back to per-model override, then global default
	if (thinkingLevel === undefined && model) {
		const perModel = settingsManager.getModelThinkingLevel(model.provider, model.id);
		if (perModel) {
			thinkingLevel = perModel;
		}
	}
	if (thinkingLevel === undefined) {
		thinkingLevel = settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL;
	}

	// Clamp to model capabilities
	if (!model) {
		thinkingLevel = "off";
	} else {
		thinkingLevel = clampThinkingLevel(model, thinkingLevel) as ThinkingLevel;
	}

	const toolListError = options.tools ? getToolListError(options.tools) : undefined;
	if (toolListError) throw new Error(`Invalid tools option: ${toolListError}`);
	const defaultToolNames = options.noTools ? [] : (settingsManager.getDefaultTools() ?? DEFAULT_TOOL_NAMES);
	// A `tools` list of only `+name`/`-name` entries changes the default selection instead of
	// replacing it, like the `defaultTools` setting.
	const toolModifiers = options.tools?.some(isToolModifier) ? options.tools : undefined;
	const selectedToolNames = toolModifiers ? applyToolModifiers(defaultToolNames, toolModifiers) : options.tools;
	const allowedToolNames = toolModifiers
		? options.noTools === "all"
			? selectedToolNames
			: undefined
		: (options.tools ?? (options.noTools === "all" ? [] : undefined));
	const excludedToolNames = options.excludeTools;
	const isExcludedTool = excludedToolNames ? createToolNameMatcher(excludedToolNames) : undefined;
	const initialActiveToolNames = (selectedToolNames ?? defaultToolNames).filter((name) => !isExcludedTool?.(name));

	// Create convertToLlm wrapper that filters images if blockImages is enabled (defense-in-depth)
	const convertToLlmWithBlockImages = (messages: AgentMessage[]): Message[] => {
		const converted = convertToLlm(messages);
		// Check setting dynamically so mid-session changes take effect
		if (!settingsManager.getBlockImages()) {
			return converted;
		}
		// Filter out ImageContent from all messages, replacing with text placeholder
		return converted.map((msg) => {
			if (msg.role === "user" || msg.role === "toolResult") {
				const content = msg.content;
				if (Array.isArray(content)) {
					const hasImages = content.some((c) => c.type === "image");
					if (hasImages) {
						const filteredContent = content
							.map((c) =>
								c.type === "image" ? { type: "text" as const, text: "Image reading is disabled." } : c,
							)
							.filter(
								(c, i, arr) =>
									// Dedupe consecutive "Image reading is disabled." texts
									!(
										c.type === "text" &&
										c.text === "Image reading is disabled." &&
										i > 0 &&
										arr[i - 1].type === "text" &&
										(arr[i - 1] as { type: "text"; text: string }).text === "Image reading is disabled."
									),
							);
						return { ...msg, content: filteredContent };
					}
				}
			}
			return msg;
		});
	};

	const extensionRunnerRef: { current?: ExtensionRunner } = {};
	const cacheWarmer = new CacheWarmer(
		modelRuntime,
		sessionManager,
		() => settingsManager.getCacheWarmingMode(),
		async (event) => extensionRunnerRef.current?.emitCacheWarmingDecision(event) ?? event.action,
	);
	const buildRequestOptions = (options: ModelsSimpleStreamOptions = {}): ModelsSimpleStreamOptions => {
		const providerRetrySettings = settingsManager.getProviderRetrySettings();
		const httpIdleTimeoutMs = settingsManager.getHttpIdleTimeoutMs();
		const effectiveTimeoutMs = httpIdleTimeoutMs === 0 ? 2147483647 : httpIdleTimeoutMs;
		const headerRunner = extensionRunnerRef.current;
		return {
			...options,
			timeoutMs: options.timeoutMs ?? providerRetrySettings.timeoutMs ?? effectiveTimeoutMs,
			websocketConnectTimeoutMs: options.websocketConnectTimeoutMs ?? settingsManager.getWebSocketConnectTimeoutMs(),
			maxRetries: options.maxRetries ?? providerRetrySettings.maxRetries,
			maxRetryDelayMs: options.maxRetryDelayMs ?? providerRetrySettings.maxRetryDelayMs,
			// Replaces the agent loop's default identity; read per request so telemetry changes apply at once.
			identity: getClientIdentity(settingsManager),
			transformHeaders: async (headers) =>
				headerRunner?.hasHandlers("before_provider_headers")
					? headerRunner.emitBeforeProviderHeaders(headers)
					: headers,
		};
	};
	// Warm only requests for the selected model. Requests a virtual selection routed, or that an
	// extension redirected, may not be repeated by the next request, so warming them could be wasted.
	const cacheContextIsCurrent = (requestModel: Model<any>) => {
		const messages = agent.state.messages;
		return () => {
			const currentModel = agent.state.model;
			const currentMessages = agent.state.messages;
			return (
				currentModel.provider === requestModel.provider &&
				currentModel.id === requestModel.id &&
				messages.length <= currentMessages.length &&
				messages.every((message, index) => currentMessages[index] === message)
			);
		};
	};
	const transformProviderPayload = async (payload: unknown) => {
		const runner = extensionRunnerRef.current;
		if (!runner?.hasHandlers("before_provider_request")) return payload;
		return runner.emitBeforeProviderRequest(payload);
	};
	const handleProviderResponse: NonNullable<ModelsSimpleStreamOptions["onResponse"]> = async (response) => {
		const runner = extensionRunnerRef.current;
		if (!runner?.hasHandlers("after_provider_response")) return;
		await runner.emit({
			type: "after_provider_response",
			status: response.status,
			headers: response.headers,
		});
	};
	const handleProviderStreamEvent: NonNullable<ModelsSimpleStreamOptions["onProviderStreamEvent"]> = async (
		data,
		model,
	) => {
		const runner = extensionRunnerRef.current;
		if (!runner?.hasHandlers("provider_stream_event")) return;
		await runner.emit({
			data,
			type: "provider_stream_event",
			provider: model.provider,
			api: model.api,
			model: model.id,
		});
	};

	const agent = new Agent({
		initialState: {
			systemPrompt: "",
			model,
			thinkingLevel,
			tools: [],
			messages: existingSession.messages,
		},
		convertToLlm: convertToLlmWithBlockImages,
		streamFn: async (model, context, options) => {
			const requestOptions = buildRequestOptions(options);
			// Compaction and summaries use their own routing ids; only session requests
			// replace the cache entry, so warming restarts from them. Keep warming while
			// the current transcript still extends the request's prefix. Agent state may
			// shallow-copy the messages array or refresh the model object without changing
			// the provider request, so top-level object identity is not a valid cache key.
			if (options?.sessionId === sessionManager.getSessionId()) {
				cacheWarmer.start({ model, context, options: requestOptions }, cacheContextIsCurrent(model));
			}
			return modelRuntime.streamSimple(model, context, requestOptions);
		},
		onPayload: transformProviderPayload,
		onResponse: handleProviderResponse,
		onProviderStreamEvent: handleProviderStreamEvent,
		sessionId: options.fork?.cacheSessionId ?? sessionManager.getSessionId(),
		transformContext: async (messages) => {
			const runner = extensionRunnerRef.current;
			if (!runner) return messages;
			return runner.emitContext(messages);
		},
		steeringMode: settingsManager.getSteeringMode(),
		followUpMode: settingsManager.getFollowUpMode(),
		transport: settingsManager.getTransport(),
		thinkingBudgets: settingsManager.getThinkingBudgets(),
		maxRetryDelayMs: settingsManager.getProviderRetrySettings().maxRetryDelayMs,
	});

	// Restore missing settings metadata for older sessions.
	if (hasExistingSession) {
		if (!hasThinkingEntry) {
			sessionManager.appendThinkingLevelChange(thinkingLevel);
		}
	} else {
		// Save initial model and thinking level for new sessions so they can be restored on resume
		if (model) {
			sessionManager.appendModelChange(model.provider, model.id);
		}
		sessionManager.appendThinkingLevelChange(thinkingLevel);
	}

	const session = new AgentSession({
		agent,
		sessionManager,
		settingsManager,
		cwd,
		scopedModels: options.scopedModels,
		resourceLoader,
		customTools: options.customTools,
		modelRuntime,
		cacheWarmer,
		initialActiveToolNames,
		usesDefaultTools: (options.tools === undefined || toolModifiers !== undefined) && !options.noTools,
		defaultToolModifiers: toolModifiers,
		allowedToolNames,
		excludedToolNames,
		extensionRunnerRef,
		sessionStartEvent: options.sessionStartEvent,
		signal: options.signal,
		fork: options.fork,
		createChildSession:
			options.createChildSession ??
			createChildSessionFactory({
				agentDir,
				modelRuntime,
				getExtensions: () => {
					const loaded = new Set(
						loadedResourceLoader
							.getExtensions()
							.extensions.map((extension) => extension.path)
							.filter((path) => path.startsWith(BUILTIN_PATH_PREFIX)),
					);
					return (options.childExtensions ?? []).filter((extension) => {
						const name = extensionName(extension);
						return name !== undefined && loaded.has(`${BUILTIN_PATH_PREFIX}${name}`);
					});
				},
				isProjectTrusted: (childCwd) =>
					isChildProjectTrusted(
						childCwd,
						{ cwd, trusted: settingsManager.isProjectTrusted() },
						new ProjectTrustStore(agentDir),
						settingsManager.getDefaultProjectTrust(),
					),
			}),
	});

	const extensionsResult = resourceLoader.getExtensions();

	return {
		session,
		extensionsResult,
		modelFallbackMessage,
	};
}
