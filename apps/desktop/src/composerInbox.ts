import type { Attachment } from "./store.ts";

export type IncomingAttachment = Omit<Attachment, "id">;

const listeners = new Set<(items: IncomingAttachment[]) => void>();

/** Adds attachments to the composer from elsewhere in the UI, e.g. the Browser pane's element picker and drawings. */
export function attachToComposer(items: IncomingAttachment[]): void {
	for (const listener of listeners) listener(items);
}

export function onComposerAttach(listener: (items: IncomingAttachment[]) => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}
