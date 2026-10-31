import { getCurrentWindow } from "@tauri-apps/api/window";
import { useCallback, useEffect, useState } from "react";

/** True inside the Tauri webview; false in a plain browser tab opened on the Vite dev server. */
export const inTauri = "__TAURI_INTERNALS__" in window;

export function useWindowControls() {
	const [maximized, setMaximized] = useState(false);

	useEffect(() => {
		if (!inTauri) return;
		const win = getCurrentWindow();
		const sync = () =>
			void win.isMaximized().then((value) => {
				setMaximized(value);
				document.documentElement.classList.toggle("maximized", value);
			});
		sync();
		const unlisten = win.onResized(sync);
		return () => void unlisten.then((off) => off());
	}, []);

	return {
		maximized,
		minimize: useCallback(() => void getCurrentWindow().minimize(), []),
		toggleMaximize: useCallback(() => void getCurrentWindow().toggleMaximize(), []),
		close: useCallback(() => void getCurrentWindow().close(), []),
	};
}
