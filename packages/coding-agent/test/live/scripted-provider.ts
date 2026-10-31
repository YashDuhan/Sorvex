import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import {
	type FauxContentBlock,
	type FauxResponseFactory,
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxThinking,
	fauxToolCall,
	type JsonObject,
	type Message,
} from "@sorvex/ai";
import type { ExtensionAPI } from "@sorvex/coding-agent";

export interface ScriptedTurn {
	text?: string;
	thinking?: string;
	toolCalls?: { name: string; args: JsonObject; expectError?: boolean }[];
	error?: string;
	/**
	 * Answer only a request whose last message contains this text. Requests take the first unused
	 * turn that matches, so a script can answer a parent and its subagents, which may interleave.
	 */
	match?: string;
	/** Wait this long before answering. */
	delayMs?: number;
}

export type RpcUiAnswer =
	| { method: "select" | "input" | "editor"; value: string }
	| { method: "confirm"; confirmed: boolean }
	| { method: "select" | "input" | "editor" | "confirm"; cancelled: true };

interface ScenarioBase {
	args?: string[];
	turns: ScriptedTurn[];
	files?: Record<string, string>;
	homeFiles?: Record<string, string>;
	env?: Record<string, string | null>;
}

export interface Scenario extends ScenarioBase {
	mode: "json" | "rpc" | "print";
	prompts: string[];
	uiAnswers?: RpcUiAnswer[];
	expectFiles?: Record<string, string>;
}

export type TuiStep =
	| { type: "text"; text: string }
	| { type: "key"; key: string }
	| { type: "resize"; cols: number; rows: number }
	| { type: "wait_for"; text: string; timeoutMs?: number }
	| { type: "sleep"; ms: number }
	| { type: "expect_exit"; timeoutMs?: number };

export interface TuiScenario extends ScenarioBase {
	mode: "tui";
	cols: number;
	rows: number;
	steps: TuiStep[];
}

export default function (pi: ExtensionAPI) {
	const scriptPath = process.env.SORVEX_SCRIPT;
	if (!scriptPath) throw new Error("scripted-provider: SORVEX_SCRIPT is not set");
	const turns = JSON.parse(readFileSync(scriptPath, "utf8")) as ScriptedTurn[];

	const faux = fauxProvider({ provider: "scripted", models: [{ id: "scripted-1" }] });
	// Every request, the subagents' included, as the provider got it, one JSON line each.
	const requestsPath = process.env.SORVEX_SCRIPT_REQUESTS;
	const unused = [...turns];
	const answer: FauxResponseFactory = async (context, options, _state, model) => {
		if (requestsPath) {
			const request = { sessionId: options?.sessionId, model: model.id, messages: context.messages };
			appendFileSync(requestsPath, `${JSON.stringify(request)}\n`);
		}
		const last = messageText(context.messages[context.messages.length - 1]);
		const index = unused.findIndex((turn) => turn.match === undefined || last.includes(turn.match));
		if (index === -1)
			throw new Error(`scripted-provider: no turn matches a request ending in ${JSON.stringify(last)}`);
		const [turn] = unused.splice(index, 1);
		if (turn.delayMs) await delay(turn.delayMs, options?.signal);
		const runIds = context.messages.flatMap((message) => messageText(message).match(RUN_ID) ?? []);
		return toMessage(turn, runIds.at(-1));
	};
	faux.setResponses(turns.map(() => answer));
	pi.registerProvider(faux.provider);

	const reportPath = process.env.SORVEX_SCRIPT_REPORT;
	if (reportPath) {
		pi.on("session_shutdown", () => {
			const report = { peakRssKb: process.resourceUsage().maxRSS, pendingTurns: faux.getPendingResponseCount() };
			writeFileSync(reportPath, JSON.stringify(report));
		});
	}
}

/** Ends early when `signal` aborts, so a cancelled request does not wait out the delay. */
function delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				resolve();
			},
			{ once: true },
		);
	});
}

function messageText(message: Message | undefined): string {
	if (!message || message.role === "system") return "";
	if (typeof message.content === "string") return message.content;
	return message.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
}

const RUN_ID = /sub_[0-9a-f]{6}/g;
/** In tool call arguments, replaced with the latest subagent run id the request mentions. */
const LAST_RUN_ID = "{lastRunId}";

function toMessage(turn: ScriptedTurn, lastRunId: string | undefined) {
	const blocks: FauxContentBlock[] = [];
	if (turn.thinking) blocks.push(fauxThinking(turn.thinking));
	if (turn.text) blocks.push(fauxText(turn.text));
	for (const call of turn.toolCalls ?? []) {
		const args = JSON.stringify(call.args).replaceAll(LAST_RUN_ID, lastRunId ?? LAST_RUN_ID);
		blocks.push(fauxToolCall(call.name, JSON.parse(args) as JsonObject));
	}
	if (turn.error !== undefined) return fauxAssistantMessage(blocks, { stopReason: "error", errorMessage: turn.error });
	return fauxAssistantMessage(blocks, { stopReason: turn.toolCalls?.length ? "toolUse" : "stop" });
}
