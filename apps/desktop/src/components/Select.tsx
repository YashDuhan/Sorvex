import { Check, ChevronDown, Search } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";

export interface SelectOption {
	value: string;
	label: ReactNode;
	/** Plain text used for search and the closed button when `label` is not a string. */
	text?: string;
	hint?: string;
	group?: string;
}

/**
 * Styled dropdown. Native <select> popups ignore the app theme in WebKitGTK (white list, unreadable text),
 * so every select in the app goes through this instead.
 */
export function Select({
	value,
	options,
	onChange,
	placeholder = "Select",
	width = 220,
	searchable,
	icon,
	className,
	up,
	ariaLabel,
}: {
	value: string;
	options: SelectOption[];
	onChange: (value: string) => void;
	placeholder?: string;
	width?: number | string;
	searchable?: boolean;
	icon?: ReactNode;
	className?: string;
	/** Open above the button, for controls at the bottom of the window. */
	up?: boolean;
	ariaLabel?: string;
}) {
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [highlight, setHighlight] = useState(0);
	const ref = useRef<HTMLDivElement>(null);
	const current = options.find((option) => option.value === value);

	const filtered = useMemo(() => {
		const needle = query.trim().toLowerCase();
		if (!needle) return options;
		return options.filter((option) =>
			`${option.text ?? (typeof option.label === "string" ? option.label : "")} ${option.value} ${option.group ?? ""}`
				.toLowerCase()
				.includes(needle),
		);
	}, [options, query]);

	useEffect(() => {
		if (!open) return;
		setQuery("");
		setHighlight(Math.max(0, options.findIndex((option) => option.value === value)));
		const onDown = (event: MouseEvent) => {
			if (!ref.current?.contains(event.target as Node)) setOpen(false);
		};
		document.addEventListener("mousedown", onDown);
		return () => document.removeEventListener("mousedown", onDown);
	}, [open, options, value]);

	const pick = (option: SelectOption | undefined) => {
		if (!option) return;
		onChange(option.value);
		setOpen(false);
	};

	const onKeyDown = (event: KeyboardEvent) => {
		if (!open) {
			if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
				event.preventDefault();
				setOpen(true);
			}
			return;
		}
		if (event.key === "Escape") {
			event.preventDefault();
			setOpen(false);
		} else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			const step = event.key === "ArrowDown" ? 1 : -1;
			setHighlight((current) => (current + step + filtered.length) % Math.max(1, filtered.length));
		} else if (event.key === "Enter") {
			event.preventDefault();
			pick(filtered[highlight]);
		}
	};

	let lastGroup: string | undefined;
	return (
		<div ref={ref} className={`select ${className ?? ""}`} style={{ width }} onKeyDown={onKeyDown}>
			<button type="button" className="select-button" aria-haspopup="listbox" aria-expanded={open} aria-label={ariaLabel} onClick={() => setOpen(!open)}>
				{icon}
				<span className={current ? "" : "placeholder"}>{current ? (current.text ?? current.label) : placeholder}</span>
				<ChevronDown size={13} />
			</button>
			{open && (
				<div className={`popover select-menu${up ? " up" : ""}`} role="listbox">
					{searchable && (
						<div className="popover-search">
							<Search size={13} />
							<input
								autoFocus
								placeholder="Search"
								value={query}
								onChange={(event) => {
									setQuery(event.target.value);
									setHighlight(0);
								}}
							/>
						</div>
					)}
					{filtered.length === 0 && <div className="empty-note">No matches</div>}
					{filtered.map((option, index) => {
						const header = option.group && option.group !== lastGroup ? option.group : undefined;
						lastGroup = option.group;
						return (
							<div key={option.value}>
								{header && <div className="popover-group">{header}</div>}
								<button
									type="button"
									role="option"
									aria-selected={option.value === value}
									className={`menu-item${index === highlight ? " highlight" : ""}`}
									onMouseEnter={() => setHighlight(index)}
									onClick={() => pick(option)}
								>
									<span className="stack">
										<span>{option.label}</span>
										{option.hint && <small>{option.hint}</small>}
									</span>
									{option.value === value && <Check size={14} className="check" />}
								</button>
							</div>
						);
					})}
				</div>
			)}
		</div>
	);
}
