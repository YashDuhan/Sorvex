import { SearchIcon } from "lucide-react";
import type { ReactNode } from "react";

export interface Section<Id extends string> {
	id: Id;
	group: string;
	label: string;
	icon: ReactNode;
	/** Short state shown at the right of the entry, e.g. a count or "running". */
	meta?: ReactNode;
}

/**
 * A page with its sections listed on the left, grouped under small headings, and the chosen section on the right
 * under its title and description. Used by Settings and Local models.
 */
export function SectionLayout<Id extends string>({
	sections,
	current,
	onPick,
	search,
	empty = "Nothing matches",
	title,
	about,
	children,
}: {
	sections: Section<Id>[];
	current: Id | undefined;
	onPick: (id: Id) => void;
	search?: { query: string; onQuery: (query: string) => void; placeholder: string };
	empty?: string;
	title?: string;
	about?: ReactNode;
	children: ReactNode;
}) {
	let lastGroup = "";
	return (
		<div className="settings">
			<nav className="settings-nav" aria-label="Sections">
				{search && (
					<label className="search">
						<SearchIcon size={14} />
						<input placeholder={search.placeholder} value={search.query} onChange={(event) => search.onQuery(event.target.value)} />
					</label>
				)}
				{sections.map((entry) => {
					const header = entry.group !== lastGroup ? entry.group : null;
					lastGroup = entry.group;
					return (
						<div key={entry.id} className="settings-nav-entry">
							{header && <div className="settings-nav-group">{header}</div>}
							<button
								type="button"
								className={`settings-nav-item${current === entry.id ? " on" : ""}`}
								aria-current={current === entry.id ? "page" : undefined}
								onClick={() => onPick(entry.id)}
							>
								{entry.icon}
								<span className="settings-nav-label">{entry.label}</span>
								{entry.meta !== undefined && <span className="settings-nav-meta">{entry.meta}</span>}
							</button>
						</div>
					);
				})}
				{sections.length === 0 && <div className="empty-note">{empty}</div>}
			</nav>
			<div className="settings-body">
				{title && (
					<div className="settings-inner">
						<header className="settings-head">
							<h1>{title}</h1>
							{about && <p>{about}</p>}
						</header>
						{children}
					</div>
				)}
			</div>
		</div>
	);
}

/** Reads a remembered section id, falling back when it is missing or no longer exists. */
export function storedSection<Id extends string>(key: string, ids: readonly Id[], fallback: Id): Id {
	try {
		const stored = localStorage.getItem(key);
		return ids.includes(stored as Id) ? (stored as Id) : fallback;
	} catch {
		return fallback;
	}
}

export function rememberSection(key: string, id: string): void {
	try {
		localStorage.setItem(key, id);
	} catch {
		// Not remembered.
	}
}
