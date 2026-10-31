import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { appDir } from "./paths.ts";

const icon = join(appDir, "src-tauri/icons/128x128.png");

/**
 * A desktop notification through the system's own tool (notify-send on Linux, osascript on macOS), so the app needs
 * no notification plugin. Failures are ignored: a missing notifier only means no popup.
 */
export function notify(title: string, body: string): void {
	const done = () => undefined;
	if (process.platform === "darwin") {
		const quote = (text: string) => JSON.stringify(text);
		execFile("osascript", ["-e", `display notification ${quote(body)} with title ${quote(title)}`], done);
	} else if (process.platform === "linux") {
		execFile("notify-send", ["--app-name=Sorvex", ...(existsSync(icon) ? [`--icon=${icon}`] : []), title, body], done);
	}
}
