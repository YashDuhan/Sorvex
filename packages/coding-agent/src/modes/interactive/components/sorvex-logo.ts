import {
	backgroundAnsi,
	type Color,
	foregroundAnsi,
	isAppleTerminalSession,
	type TerminalColorMode,
} from "@sorvex/tui";
import { type ThemeColor, theme } from "../theme/theme.ts";

const SORVEX_LOGO_TOKENS: Record<string, ThemeColor> = { c: "accent", y: "text" };

/** Logo pixel colors in the active theme: the mark in the accent, the highlight pixel in the text color. */
export function sorvexLogoColors(): Record<string, Color> {
	return Object.fromEntries(Object.entries(SORVEX_LOGO_TOKENS).map(([pixel, token]) => [pixel, theme.colors[token]]));
}

// An "S": accent pixels, with one highlight pixel at the bottom end of the stroke.
export const SORVEX_LOGO_PIXELS = [".ccc", "c...", "...c", "ccy."];

const RESET = "\x1b[0m";

function renderCell(
	top: string | undefined,
	bottom: string | undefined,
	colors: Record<string, Color>,
	mode: TerminalColorMode,
): string {
	const topColor = top ? colors[top] : undefined;
	const bottomColor = bottom ? colors[bottom] : undefined;
	if (topColor && bottomColor) {
		if (top === bottom) return `${foregroundAnsi(topColor, mode)}█${RESET}`;
		return `${foregroundAnsi(topColor, mode)}${backgroundAnsi(bottomColor, mode)}▀${RESET}`;
	}
	if (topColor) return `${foregroundAnsi(topColor, mode)}▀${RESET}`;
	if (bottomColor) return `${foregroundAnsi(bottomColor, mode)}▄${RESET}`;
	return " ";
}

export function sorvexLogoLines(): [string, string] {
	const mode = theme.getColorMode();
	const colors = sorvexLogoColors();
	const line = (topRow: number) =>
		[...SORVEX_LOGO_PIXELS[topRow]!]
			.map((top, column) => renderCell(top, SORVEX_LOGO_PIXELS[topRow + 1]![column], colors, mode))
			.join("");
	return [line(0), line(2)];
}

/**
 * Whether the terminal renders the half-block logo correctly. Apple Terminal draws gaps between rows and
 * misaligns the half blocks, so it gets the text wordmark instead.
 */
export function supportsSorvexLogo(): boolean {
	return !isAppleTerminalSession();
}

export function sorvexWordmark(): string {
	return theme.fg("text", "Sorvex");
}
