export function areExperimentalFeaturesEnabled(): boolean {
	return process.env.SORVEX_EXPERIMENTAL === "1";
}
