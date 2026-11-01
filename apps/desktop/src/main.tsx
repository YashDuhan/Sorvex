import { createRoot } from "react-dom/client";
import { api } from "./api.ts";
import { App } from "./App.tsx";
import "@fontsource-variable/onest";
import "@fontsource-variable/jetbrains-mono";
import "./styles.css";

// No StrictMode: its double-run effects would start and stop the Sorvex child process twice.
createRoot(document.getElementById("root")!).render(<App />);

// One line about the webview's media support, so microphone problems show up in Logs.
void api("POST", "/api/log", {
	line: `webview secure=${window.isSecureContext} mediaDevices=${Boolean(navigator.mediaDevices?.getUserMedia)} audioContext=${typeof AudioContext !== "undefined"} ua=${navigator.userAgent}`,
}).catch(() => undefined);
