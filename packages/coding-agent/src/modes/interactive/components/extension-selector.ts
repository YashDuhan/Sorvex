/**
 * Generic selector component for extensions.
 * Displays a list of string options with keyboard navigation.
 */

import { Container, getKeybindings, Spacer, Text, type TUI } from "@sorvex/tui";
import { theme } from "../theme/theme.ts";
import { CountdownTimer } from "./countdown-timer.ts";
import { DialogTitle } from "./dialog-title.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyHint, rawKeyHint } from "./keybinding-hints.ts";

export interface ExtensionSelectorOptions {
	tui?: TUI;
	timeout?: number;
	onToggleToolsExpanded?: () => void;
	description?: string;
	/**
	 * Rows the whole dialog may use at a render width. Defaults to the terminal height when `tui` is given.
	 * When the title and description do not fit, they scroll so the options stay visible.
	 */
	maxHeight?: (width: number) => number;
}

export class ExtensionSelectorComponent extends Container {
	private options: string[];
	private selectedIndex = 0;
	private listContainer: Container;
	private onSelectCallback: (option: string) => void;
	private onCancelCallback: () => void;
	private titleText: DialogTitle;
	private baseTitle: string;
	private countdown: CountdownTimer | undefined;
	private onToggleToolsExpanded: (() => void) | undefined;
	private readonly header = new Container();
	private readonly message = new Container();
	private readonly body = new Container();
	private readonly maxHeight: ((width: number) => number) | undefined;
	/** First visible line of the message when it scrolls. */
	private messageOffset = 0;
	/** Message lines visible in the last render; 0 when the message fits. */
	private messagePageSize = 0;
	private messageMaxOffset = 0;

	constructor(
		title: string,
		options: string[],
		onSelect: (option: string) => void,
		onCancel: () => void,
		opts?: ExtensionSelectorOptions,
	) {
		super();

		this.options = options;
		this.onSelectCallback = onSelect;
		this.onCancelCallback = onCancel;
		this.onToggleToolsExpanded = opts?.onToggleToolsExpanded;
		this.baseTitle = title;
		const tui = opts?.tui;
		this.maxHeight = opts?.maxHeight ?? (tui ? () => tui.terminal.rows : undefined);

		this.header.addChild(new DynamicBorder());
		this.header.addChild(new Spacer(1));

		this.titleText = new DialogTitle(
			title,
			(text) => theme.bold(theme.fg("text", text)),
			(text) => theme.fg("text", text),
		);
		this.message.addChild(this.titleText);
		if (opts?.description) {
			this.message.addChild(new Spacer(1));
			this.message.addChild(new Text(theme.fg("text", opts.description), 1, 0));
		}
		this.body.addChild(new Spacer(1));

		if (opts?.timeout && opts.timeout > 0 && opts.tui) {
			this.countdown = new CountdownTimer(
				opts.timeout,
				opts.tui,
				(s) => this.titleText.setText(`${this.baseTitle} (${s}s)`),
				() => this.onCancelCallback(),
			);
		}

		this.listContainer = new Container();
		this.body.addChild(this.listContainer);
		this.body.addChild(new Spacer(1));
		this.body.addChild(
			new Text(
				rawKeyHint("↑↓", "navigate") +
					"  " +
					keyHint("tui.select.confirm", "select") +
					"  " +
					keyHint("tui.select.cancel", "cancel"),
				1,
				0,
			),
		);
		this.body.addChild(new Spacer(1));
		this.body.addChild(new DynamicBorder());

		this.addChild(this.header);
		this.addChild(this.message);
		this.addChild(this.body);

		this.updateList();
	}

	override render(width: number): string[] {
		const header = this.header.render(width);
		const message = this.message.render(width);
		const body = this.body.render(width);
		const maxHeight = this.maxHeight?.(width);
		if (maxHeight === undefined || header.length + message.length + body.length <= maxHeight) {
			this.messagePageSize = 0;
			this.messageMaxOffset = 0;
			this.messageOffset = 0;
			return [...header, ...message, ...body];
		}
		// One row holds the scroll indicator.
		const pageSize = Math.max(1, maxHeight - header.length - body.length - 1);
		this.messagePageSize = pageSize;
		this.messageMaxOffset = Math.max(0, message.length - pageSize);
		this.messageOffset = Math.min(this.messageOffset, this.messageMaxOffset);
		const end = Math.min(message.length, this.messageOffset + pageSize);
		const indicator = new Text(
			theme.fg("muted", `lines ${this.messageOffset + 1}-${end} of ${message.length}`) +
				"  " +
				keyHint("app.dialog.scrollUp", "up") +
				"  " +
				keyHint("app.dialog.scrollDown", end < message.length ? "more" : "down"),
			1,
			0,
		).render(width);
		return [...header, ...message.slice(this.messageOffset, end), ...indicator, ...body];
	}

	private updateList(): void {
		this.listContainer.clear();
		for (let i = 0; i < this.options.length; i++) {
			const isSelected = i === this.selectedIndex;
			const text = isSelected
				? theme.fg("accent", "→ ") + theme.fg("accent", this.options[i])
				: `  ${theme.fg("text", this.options[i])}`;
			this.listContainer.addChild(new Text(text, 1, 0));
		}
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		if (kb.matches(keyData, "app.tools.expand")) {
			this.onToggleToolsExpanded?.();
		} else if (kb.matches(keyData, "app.dialog.scrollUp") || kb.matches(keyData, "tui.select.pageUp")) {
			this.messageOffset = Math.max(0, this.messageOffset - this.messagePageSize);
		} else if (kb.matches(keyData, "app.dialog.scrollDown") || kb.matches(keyData, "tui.select.pageDown")) {
			this.messageOffset = Math.min(this.messageMaxOffset, this.messageOffset + this.messagePageSize);
		} else if (kb.matches(keyData, "tui.select.up") || keyData === "k") {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.updateList();
		} else if (kb.matches(keyData, "tui.select.down") || keyData === "j") {
			this.selectedIndex = Math.min(this.options.length - 1, this.selectedIndex + 1);
			this.updateList();
		} else if (kb.matches(keyData, "tui.select.confirm") || keyData === "\n") {
			const selected = this.options[this.selectedIndex];
			if (selected) this.onSelectCallback(selected);
		} else if (kb.matches(keyData, "tui.select.cancel")) {
			this.onCancelCallback();
		}
	}

	dispose(): void {
		this.countdown?.dispose();
	}
}
