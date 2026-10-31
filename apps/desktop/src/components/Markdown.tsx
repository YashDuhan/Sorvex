import { Check, Copy } from "lucide-react";
import { type ComponentProps, memo, type ReactNode, useState } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";

export function CopyButton({ text, size = 13 }: { text: string; size?: number }) {
	const [copied, setCopied] = useState(false);
	return (
		<button
			type="button"
			className="icon-btn sm"
			aria-label="Copy"
			onClick={() => {
				void navigator.clipboard.writeText(text).then(() => {
					setCopied(true);
					setTimeout(() => setCopied(false), 1200);
				});
			}}
		>
			{copied ? <Check size={size} /> : <Copy size={size} />}
		</button>
	);
}

function textOf(node: ReactNode): string {
	if (typeof node === "string" || typeof node === "number") return String(node);
	if (Array.isArray(node)) return node.map(textOf).join("");
	if (node && typeof node === "object" && "props" in node) {
		return textOf((node.props as { children?: ReactNode }).children);
	}
	return "";
}

function Pre({ children }: ComponentProps<"pre">) {
	const child = Array.isArray(children) ? children[0] : children;
	const className =
		child && typeof child === "object" && "props" in child ? ((child.props as { className?: string }).className ?? "") : "";
	const language = /language-([\w+-]+)/.exec(className)?.[1] ?? "text";
	return (
		<div className="code-block">
			<div className="code-header">
				<span>{language.toLowerCase()}</span>
				<CopyButton text={textOf(children).replace(/\n$/, "")} />
			</div>
			<pre>{children}</pre>
		</div>
	);
}

function Link({ href, children }: ComponentProps<"a">) {
	return (
		<a href={href} target="_blank" rel="noreferrer">
			{children}
		</a>
	);
}

// react-markdown does not render raw HTML, so model output cannot inject markup.
export const Markdown = memo(function Markdown({ text }: { text: string }) {
	return (
		<div className="md">
			<ReactMarkdown
				remarkPlugins={[remarkGfm]}
				rehypePlugins={[[rehypeHighlight, { detect: false, ignoreMissing: true }]]}
				components={{ pre: Pre, a: Link }}
			>
				{text}
			</ReactMarkdown>
		</div>
	);
});
