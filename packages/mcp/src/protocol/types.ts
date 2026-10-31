import type { BlobResourceContents, ContentAnnotations, ContentBlock, TextResourceContents } from "./content.ts";
import type { JsonRpcId } from "./jsonrpc.ts";

export const LATEST_PROTOCOL_VERSION = "2025-11-25";
/**
 * Versions the client accepts from a server. Servers that do not support the requested version answer
 * with their own latest one, so older versions stay accepted for servers built on older SDKs.
 */
export const SUPPORTED_PROTOCOL_VERSIONS = [LATEST_PROTOCOL_VERSION, "2025-06-18", "2025-03-26", "2024-11-05"] as const;
export type SupportedProtocolVersion = (typeof SUPPORTED_PROTOCOL_VERSIONS)[number];

export interface Implementation {
	name: string;
	version: string;
	title?: string;
}

export interface Root {
	uri: string;
	name?: string;
}

export interface ClientCapabilities {
	experimental?: Record<string, unknown>;
	roots?: { listChanged?: boolean };
	sampling?: Record<string, unknown>;
	elicitation?: { form?: Record<string, unknown>; url?: Record<string, unknown> };
}

export interface ServerCapabilities {
	experimental?: Record<string, unknown>;
	logging?: Record<string, unknown>;
	prompts?: { listChanged?: boolean };
	resources?: { subscribe?: boolean; listChanged?: boolean };
	tools?: { listChanged?: boolean };
	completions?: Record<string, unknown>;
}

export interface InitializeParams {
	protocolVersion: string;
	capabilities: ClientCapabilities;
	clientInfo: Implementation;
}

export interface InitializeResult {
	protocolVersion: string;
	capabilities: ServerCapabilities;
	serverInfo: Implementation;
	instructions?: string;
}

export interface ProgressNotification {
	progressToken: string | number;
	progress: number;
	total?: number;
	message?: string;
}

export interface CancelledNotification {
	requestId: JsonRpcId;
	reason?: string;
}

export interface ToolAnnotations {
	title?: string;
	readOnlyHint?: boolean;
	destructiveHint?: boolean;
	idempotentHint?: boolean;
	openWorldHint?: boolean;
}

export interface ToolExecution {
	taskSupport?: "forbidden" | "optional" | "required";
}

export interface Tool {
	name: string;
	title?: string;
	description?: string;
	inputSchema: Record<string, unknown>;
	outputSchema?: Record<string, unknown>;
	annotations?: ToolAnnotations;
	execution?: ToolExecution;
	_meta?: Record<string, unknown>;
}

export interface ListToolsResult {
	tools: Tool[];
	nextCursor?: string;
	_meta?: Record<string, unknown>;
}

/** A resource a server lists in `resources/list`. */
export interface Resource {
	uri: string;
	name: string;
	title?: string;
	description?: string;
	mimeType?: string;
	size?: number;
	annotations?: ContentAnnotations;
	_meta?: Record<string, unknown>;
}

/** A family of resources, addressed by an RFC 6570 URI template, from `resources/templates/list`. */
export interface ResourceTemplate {
	uriTemplate: string;
	name: string;
	title?: string;
	description?: string;
	mimeType?: string;
	annotations?: ContentAnnotations;
	_meta?: Record<string, unknown>;
}

export interface ListResourcesResult {
	resources: Resource[];
	nextCursor?: string;
	_meta?: Record<string, unknown>;
}

export interface ListResourceTemplatesResult {
	resourceTemplates: ResourceTemplate[];
	nextCursor?: string;
	_meta?: Record<string, unknown>;
}

export interface ReadResourceResult {
	contents: (TextResourceContents | BlobResourceContents)[];
	_meta?: Record<string, unknown>;
}

export interface PromptArgument {
	name: string;
	title?: string;
	description?: string;
	required?: boolean;
}

/** A prompt or prompt template a server lists in `prompts/list`. */
export interface Prompt {
	name: string;
	title?: string;
	description?: string;
	arguments?: PromptArgument[];
	_meta?: Record<string, unknown>;
}

export interface PromptMessage {
	role: "user" | "assistant";
	content: ContentBlock;
}

export interface GetPromptResult {
	description?: string;
	messages: PromptMessage[];
	_meta?: Record<string, unknown>;
}

interface ElicitSchemaBase {
	title?: string;
	description?: string;
}

export interface ElicitStringSchema extends ElicitSchemaBase {
	type: "string";
	minLength?: number;
	maxLength?: number;
	format?: "email" | "uri" | "date" | "date-time";
	default?: string;
}

export interface ElicitNumberSchema extends ElicitSchemaBase {
	type: "number" | "integer";
	minimum?: number;
	maximum?: number;
	default?: number;
}

export interface ElicitBooleanSchema extends ElicitSchemaBase {
	type: "boolean";
	default?: boolean;
}

/** One of `enum`, labelled by the legacy `enumNames` when present. */
export interface ElicitEnumSchema extends ElicitSchemaBase {
	type: "string";
	enum: string[];
	enumNames?: string[];
	default?: string;
}

export interface ElicitTitledEnumSchema extends ElicitSchemaBase {
	type: "string";
	oneOf: { const: string; title: string }[];
	default?: string;
}

export interface ElicitMultiSelectSchema extends ElicitSchemaBase {
	type: "array";
	minItems?: number;
	maxItems?: number;
	items: { type: "string"; enum: string[] } | { anyOf: { const: string; title: string }[] };
	default?: string[];
}

/** A field of an elicitation form: the flat subset of JSON Schema the spec allows. */
export type ElicitSchema =
	| ElicitStringSchema
	| ElicitNumberSchema
	| ElicitBooleanSchema
	| ElicitEnumSchema
	| ElicitTitledEnumSchema
	| ElicitMultiSelectSchema;

/** `elicitation/create` in form mode, the only mode the client declares. */
export interface ElicitRequestParams {
	mode?: "form";
	message: string;
	requestedSchema: {
		$schema?: string;
		type: "object";
		properties: Record<string, ElicitSchema>;
		required?: string[];
	};
}

export type ElicitValue = string | number | boolean | string[];

export type ElicitResult =
	| { action: "accept"; content: Record<string, ElicitValue> }
	| { action: "decline" | "cancel" };
