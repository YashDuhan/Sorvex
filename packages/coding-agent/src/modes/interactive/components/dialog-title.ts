import { Container, Spacer, Text } from "@sorvex/tui";

/**
 * A dialog title whose indented lines keep their indent when they wrap, so text an extension
 * indents, such as a server's message, never starts a wrapped line at the title's margin. The first
 * line is the title; later lines use `bodyStyle` when given, so details do not look like the title.
 */
export class DialogTitle extends Container {
	private readonly style: (text: string) => string;
	private readonly bodyStyle: (text: string) => string;

	constructor(text: string, style: (text: string) => string, bodyStyle: (text: string) => string = style) {
		super();
		this.style = style;
		this.bodyStyle = bodyStyle;
		this.setText(text);
	}

	setText(text: string): void {
		this.clear();
		const lines = text.replace(/\t/g, "   ").split("\n");
		for (const [index, line] of lines.entries()) {
			const body = line.trimStart();
			const style = index === 0 ? this.style : this.bodyStyle;
			if (body === "") this.addChild(new Spacer(1));
			else this.addChild(new Text(style(body), 1 + line.length - body.length, 0));
		}
	}
}
