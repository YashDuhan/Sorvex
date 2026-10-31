import { api } from "./api.ts";
import type { SorvexActions } from "./store.ts";

/** Sorvex's built-in provider for models served by the local llama.cpp engine. */
export const LOCAL_PROVIDER = "llama.cpp";

export interface LocalModel {
	id: string;
	/** "incomplete" is a download that stopped part-way; it cannot run until it is resumed. */
	status: { value: "unloaded" | "loading" | "loaded" | "downloading" | "sleeping" | "incomplete"; failed?: boolean };
	meta?: { size?: number; n_ctx?: number; n_ctx_train?: number };
	/** False for GGUF files the user placed in the models folder: those are deleted there, not in the app. */
	can_remove?: boolean;
	/** Known once loaded: whether the chat template supports tool calls. False means chat only, no agent work. */
	tools?: boolean;
}

export const CHAT_ONLY_HINT = "This model's chat template has no tool calling, so it can chat but cannot run tools or act as an agent.";

/** "unsloth/Qwen3-4B-Instruct-2507-GGUF:Q4_K_M" → "Qwen3-4B-Instruct-2507 · Q4_K_M". */
export function localModelName(id: string): string {
	const [repo = id, quant] = id.split(":");
	const name = (repo.split("/").pop() ?? repo).replace(/-GGUF$/i, "");
	return quant ? `${name} · ${quant}` : name;
}

/**
 * Loads a local model in the engine (starting the engine first if needed), waits for the agent to list it, and
 * switches the chat to it. Agents only list llama.cpp models once they are loaded, hence the wait.
 */
export async function switchToLocalModel(actions: SorvexActions, id: string): Promise<void> {
	await api("POST", "/api/local/load", { model: id });
	const catalog = await actions.refreshModelCatalog((list) => list.some((entry) => entry.provider === LOCAL_PROVIDER && entry.id === id));
	const entry = catalog.find((candidate) => candidate.provider === LOCAL_PROVIDER && candidate.id === id);
	if (!entry) throw new Error(`${id} is loaded, but the agent has not listed it yet. Pick it again in a moment.`);
	await actions.setModel(entry);
}
