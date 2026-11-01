import { type RefObject, useMemo } from "react";
import { api } from "../api.ts";
import type { SelectedElement } from "../element.ts";
import { Annotate, type AnnotateSource } from "./Annotate.tsx";

/** From POST /api/browser/inspect (server/browser.ts). */
interface InspectedElement {
	rect: { x: number; y: number; width: number; height: number };
	label: string;
	tag?: string;
	text?: string;
	path?: string;
	styles?: Record<string, string>;
	html?: string;
	siblings?: string;
	react?: string;
	url?: string;
	image?: string;
}

/**
 * The Browser pane's annotation bar: pick an element to send its HTML, styles and a screenshot to the chat, or draw on
 * a frozen copy of the page and add it as an image.
 */
export function BrowserAnnotate({
	frame,
	imageRef,
	onClose,
	onActiveChange,
	onAttached,
	toast,
}: {
	frame: string | undefined;
	imageRef: RefObject<HTMLImageElement | null>;
	onClose: () => void;
	/** True while a tool is active, so the pane stops forwarding clicks and keys to the page. */
	onActiveChange: (active: boolean) => void;
	onAttached: () => void;
	toast: (kind: "info" | "error" | "warning", message: string) => void;
}) {
	const source = useMemo<AnnotateSource>(
		() => ({
			target: imageRef,
			size: () => {
				const image = imageRef.current;
				return image?.naturalWidth ? { width: image.naturalWidth, height: image.naturalHeight } : null;
			},
			snapshot: () => (frame ? `data:image/jpeg;base64,${frame}` : null),
			inspect: (x, y) => api<InspectedElement | null>("POST", "/api/browser/inspect", { x, y }),
			select: async (x, y) => {
				const element = await api<InspectedElement | null>("POST", "/api/browser/inspect", { x, y, full: true });
				if (!element) return null;
				const selected: SelectedElement = {
					tag: element.tag ?? "element",
					label: element.label,
					text: element.text ?? "",
					path: element.path ?? "",
					styles: element.styles ?? {},
					html: element.html ?? "",
					siblings: element.siblings ?? "",
					react: element.react || undefined,
					url: element.url,
					hasScreenshot: Boolean(element.image),
				};
				return { name: element.label, kind: "element", mimeType: "text/plain", data: "", size: selected.html.length, element: selected, image: element.image };
			},
			onWheel: (deltaY) => void api("POST", "/api/browser/input", { kind: "wheel", dy: Math.round(deltaY) }).catch(() => undefined),
			fileName: "browser-annotation.jpg",
			selectLabel: "Select element: sends its HTML, styles and a screenshot to the chat",
			emptyMessage: "Open a page first",
		}),
		[frame, imageRef],
	);
	return <Annotate source={source} onClose={onClose} onActiveChange={onActiveChange} onAttached={onAttached} toast={toast} />;
}
