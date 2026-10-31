import { afterEach, describe, expect, it } from "vitest";
import { areExperimentalFeaturesEnabled } from "../src/core/experimental.ts";

describe("areExperimentalFeaturesEnabled", () => {
	const originalPiExperimental = process.env.SORVEX_EXPERIMENTAL;

	afterEach(() => {
		if (originalPiExperimental === undefined) {
			delete process.env.SORVEX_EXPERIMENTAL;
		} else {
			process.env.SORVEX_EXPERIMENTAL = originalPiExperimental;
		}
	});

	it("returns false when SORVEX_EXPERIMENTAL is unset", () => {
		delete process.env.SORVEX_EXPERIMENTAL;

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});

	it("returns false when SORVEX_EXPERIMENTAL is empty", () => {
		process.env.SORVEX_EXPERIMENTAL = "";

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});

	it("returns true when SORVEX_EXPERIMENTAL is set to 1", () => {
		process.env.SORVEX_EXPERIMENTAL = "1";

		expect(areExperimentalFeaturesEnabled()).toBe(true);
	});

	it("returns false when SORVEX_EXPERIMENTAL is set to 0", () => {
		process.env.SORVEX_EXPERIMENTAL = "0";

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});

	it("returns false when SORVEX_EXPERIMENTAL is set to a non-1 value", () => {
		process.env.SORVEX_EXPERIMENTAL = "true";

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});
});
