import { beforeAll, describe, expect, it, vi } from "vitest";
import {
	FirstTimeSetupComponent,
	type FirstTimeSetupResult,
} from "../src/modes/interactive/components/first-time-setup.ts";
import { DEFAULT_THEME_SETTING, initTheme, resolveThemeSetting } from "../src/modes/interactive/theme/theme.ts";

const ENTER = "\r";
const DOWN = "\x1b[B";

function strip(lines: string[]): string {
	return lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
}

function createSetup() {
	const previews: string[] = [];
	const submitted: FirstTimeSetupResult[] = [];
	const component = new FirstTimeSetupComponent({
		onThemePreview: (name) => previews.push(name),
		onSubmit: (result) => submitted.push(result),
		onCancel: vi.fn(),
	});
	return { component, previews, submitted };
}

describe("first-time setup theme choice", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("preselects Default, which is the unset-theme setting", () => {
		const { component } = createSetup();
		const rendered = strip(component.render(100));

		expect(rendered).toMatch(/→ Default/);
		expect(rendered.indexOf("Default")).toBeLessThan(rendered.indexOf("System"));
	});

	it("saves the default theme setting when Enter is pressed through both steps", () => {
		const { component, previews, submitted } = createSetup();

		component.handleInput(ENTER);
		component.handleInput(ENTER);

		expect(previews).toEqual([]);
		expect(submitted).toEqual([{ theme: DEFAULT_THEME_SETTING, shareAnalytics: true }]);
		expect(resolveThemeSetting(submitted[0]?.theme, "dark")).toBe("dark");
		expect(resolveThemeSetting(submitted[0]?.theme, "light")).toBe("system");
	});

	it("previews the system theme when System is picked", () => {
		const { component, previews, submitted } = createSetup();

		component.handleInput(DOWN);
		component.handleInput(ENTER);
		component.handleInput(ENTER);

		expect(previews).toEqual(["system"]);
		expect(submitted[0]?.theme).toBe("system");
	});
});
