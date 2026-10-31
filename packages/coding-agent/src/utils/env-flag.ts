/** True for "1", "true", and "yes" (case-insensitive). Anything else, including "0" and "", is false. */
export function isTruthyEnvFlag(value: string | undefined): boolean {
	if (!value) return false;
	return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

/** Whether `SORVEX_OFFLINE` asks for offline mode. `SORVEX_OFFLINE=0` is online. */
export function isOfflineMode(): boolean {
	return isTruthyEnvFlag(process.env.SORVEX_OFFLINE);
}
