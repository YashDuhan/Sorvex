import { beforeEach, describe, expect, it, vi } from "vitest";

const { initThemeMock } = vi.hoisted(() => ({ initThemeMock: vi.fn() }));

vi.mock("../src/modes/interactive/theme/theme.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/modes/interactive/theme/theme.ts")>()),
	initTheme: initThemeMock,
	stopThemeWatcher: vi.fn(),
}));

vi.mock("../src/modes/interactive/components/config-selector.ts", () => ({
	ConfigSelectorComponent: class {
		constructor(...args: unknown[]) {
			const onClose = args[4] as () => void;
			queueMicrotask(onClose);
		}
		getResourceList() {
			return {};
		}
		render() {
			return [];
		}
		invalidate() {}
	},
}));

vi.mock("@sorvex/tui", async (importOriginal) => ({
	...(await importOriginal<typeof import("@sorvex/tui")>()),
	ProcessTerminal: class {},
	TuiMainScreen: class {
		terminal = { rows: 24 };
		setClearOnShrink() {}
		addChild() {}
		setFocus() {}
		start() {}
		stop() {}
		requestRender() {}
	},
}));

import { selectConfig } from "../src/cli/config-selector.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

async function themeUsedFor(settings: Record<string, unknown>): Promise<string | undefined> {
	await selectConfig({
		resolvedPaths: { global: {}, project: {} } as never,
		settingsManager: SettingsManager.inMemory(settings),
		cwd: "/tmp",
		agentDir: "/tmp",
		writeScope: "global",
		projectModeAvailable: false,
	});
	return initThemeMock.mock.calls[0]?.[0];
}

describe("sorvex config theme", () => {
	beforeEach(() => {
		initThemeMock.mockClear();
	});

	it("uses the default dark theme on a dark terminal when no theme is set", async () => {
		expect(await themeUsedFor({})).toBe("dark");
	});

	it("resolves a light/dark pair setting", async () => {
		expect(await themeUsedFor({ theme: "light/dark" })).toBe("dark");
	});

	it("keeps an explicit theme", async () => {
		expect(await themeUsedFor({ theme: "light" })).toBe("light");
	});
});
