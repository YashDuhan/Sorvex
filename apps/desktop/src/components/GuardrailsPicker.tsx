import { Bot, FileText, Layers, Search, Server, SquareTerminal } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";

/** One toggleable guardrail, whatever kind it is. */
interface Guard {
	key: string;
	label: string;
	hint?: string;
	tone?: "block" | "ask";
	on: boolean;
	toggle: (on: boolean) => void;
}

export interface GuardSection {
	id: string;
	label: string;
	/** What the section checks, shown under its title. */
	about: string;
	icon: ReactNode;
	guards: Guard[];
	/** Turns every guardrail of the section on or off in one save. */
	setAll: (on: boolean) => void;
	/** Shown above the rows, e.g. each SSH server's policy. */
	extra?: ReactNode;
	empty?: string;
}

const ALL = "all";

/** Builds the sections from the settings and the SSH guardrails. */
export function guardSections(input: {
	reviewers: { id: string; name: string; model?: string; enabled: boolean }[];
	chatModel: string;
	rules: { id: string; name: string; target: string; action: string; enabled: boolean }[];
	ssh: { hosts: { id: string; alias: string; policy: string }[]; block: { id: string; name: string; enabled: boolean }[]; ask: { id: string; name: string; enabled: boolean }[] } | null;
	setReviewers: (ids: string[], on: boolean) => void;
	setRules: (ids: string[], on: boolean) => void;
	setSsh: (ids: string[], on: boolean) => void;
}): GuardSection[] {
	const bashRules = input.rules.filter((entry) => entry.target === "bash").map((entry) => entry.id);
	const pathRules = input.rules.filter((entry) => entry.target !== "bash").map((entry) => entry.id);
	const sshIds = input.ssh ? [...input.ssh.block, ...input.ssh.ask].map((entry) => entry.id) : [];
	const rule = (target: string) =>
		input.rules
			.filter((entry) => (target === "bash" ? entry.target === "bash" : entry.target !== "bash"))
			.map<Guard>((entry) => ({ key: `rule:${entry.id}`, label: entry.name, tone: entry.action === "block" ? "block" : "ask", on: entry.enabled, toggle: (on) => input.setRules([entry.id], on) }));
	return [
		{
			id: "reviewers",
			label: "Reviewers",
			about: "LLM reviewers check each finished turn",
			icon: <Bot size={16} />,
			empty: "No reviewers yet. Add one in the rules editor.",
			guards: input.reviewers.map((reviewer) => ({
				key: `reviewer:${reviewer.id}`,
				label: reviewer.name,
				hint: !reviewer.model ? "No model set" : reviewer.model === input.chatModel ? `${reviewer.model} · same as chat` : reviewer.model,
				on: reviewer.enabled,
				toggle: (on) => input.setReviewers([reviewer.id], on),
			})),
			setAll: (on) => input.setReviewers(input.reviewers.map((reviewer) => reviewer.id), on),
		},
		{ id: "shell", label: "Shell commands", about: "Checked before each local shell command", icon: <SquareTerminal size={16} />, guards: rule("bash"), setAll: (on) => input.setRules(bashRules, on) },
		{ id: "files", label: "File paths", about: "Checked before each local file read or write", icon: <FileText size={16} />, guards: rule("path"), setAll: (on) => input.setRules(pathRules, on) },
		{
			id: "ssh",
			label: "SSH",
			about: "Checked before every remote command",
			icon: <Server size={16} />,
			empty: input.ssh ? "No SSH guardrails" : "Loading",
			extra:
				input.ssh && input.ssh.hosts.length > 0 ? (
					<div className="gp-hosts">
						{input.ssh.hosts.map((host) => (
							<span key={host.id} className="mcp-badge">
								{host.alias}: {host.policy}
							</span>
						))}
					</div>
				) : undefined,
			guards: input.ssh
				? [
						...input.ssh.block.map<Guard>((entry) => ({ key: `ssh:${entry.id}`, label: entry.name, tone: "block", on: entry.enabled, toggle: (on) => input.setSsh([entry.id], on) })),
						...input.ssh.ask.map<Guard>((entry) => ({ key: `ssh:${entry.id}`, label: entry.name, tone: "ask", on: entry.enabled, toggle: (on) => input.setSsh([entry.id], on) })),
					]
				: [],
			setAll: (on) => input.setSsh(sshIds, on),
		},
	];
}

function Toggle({ on, label, onChange }: { on: boolean; label: string; onChange: (on: boolean) => void }) {
	return (
		<button type="button" role="switch" aria-checked={on} aria-label={label} className={`dr-check${on ? " on" : ""}`} onClick={() => onChange(!on)} />
	);
}

/**
 * The composer's Guardrails menu, laid out like the model and tools pickers: sections on the left (reviewers, shell
 * and file safety rules, SSH), the chosen section's guardrails on the right with a switch each and one for the whole
 * section. Typing searches every section. The footer opens the full editors.
 */
export function GuardrailsPicker({ sections, footer }: { sections: GuardSection[]; footer: ReactNode }) {
	const [tab, setTab] = useState(ALL);
	const [query, setQuery] = useState("");
	const needle = query.trim().toLowerCase();
	const total = sections.reduce((sum, section) => sum + section.guards.length, 0);
	const shown = useMemo(() => {
		const scoped = needle || tab === ALL ? sections : sections.filter((section) => section.id === tab);
		return scoped
			.map((section) => ({ ...section, guards: needle ? section.guards.filter((guard) => `${guard.label} ${guard.hint ?? ""} ${guard.tone ?? ""}`.toLowerCase().includes(needle)) : section.guards }))
			.filter((section) => !needle || section.guards.length > 0);
	}, [sections, tab, needle]);

	const rail = (id: string, label: string, on: number, count: number, icon: ReactNode) => (
		<button
			key={id}
			type="button"
			role="tab"
			aria-selected={!needle && tab === id}
			aria-label={`${label}, ${on} of ${count} on`}
			title={`${label} · ${on}/${count} on`}
			className={`mp-rail-item${!needle && tab === id ? " on" : ""}`}
			onClick={() => {
				setTab(id);
				setQuery("");
			}}
		>
			{icon}
		</button>
	);

	return (
		<div className="model-picker guard-picker">
			<nav className="mp-rail" role="tablist" aria-label="Guardrail sections" aria-orientation="vertical">
				{rail(ALL, "All guardrails", sections.reduce((sum, s) => sum + s.guards.filter((g) => g.on).length, 0), total, <Layers size={16} />)}
				<div className="mp-rail-sep" />
				{sections.map((section) => rail(section.id, section.label, section.guards.filter((guard) => guard.on).length, section.guards.length, section.icon))}
			</nav>
			<div className="mp-main">
				<label className="mp-search">
					<Search size={13} />
					<input autoFocus placeholder={`Search ${total} guardrails`} value={query} onChange={(event) => setQuery(event.target.value)} />
				</label>
				<div className="mp-list">
					{shown.map((section) => {
						const on = section.guards.filter((guard) => guard.on).length;
						return (
							<section key={section.id} className="gp-section">
								<div className="gp-head">
									<div className="gp-head-text">
										<span className="tp-title">
											{section.label}
											<span className="tp-count">
												{on}/{section.guards.length}
											</span>
										</span>
										<small>{section.about}</small>
									</div>
									{section.guards.length > 1 && (
										<Toggle
											on={on === section.guards.length}
											label={`${on === section.guards.length ? "Turn off" : "Turn on"} every ${section.label} guardrail`}
											onChange={section.setAll}
										/>
									)}
								</div>
								{!needle && section.extra}
								{section.guards.map((guard) => (
									<div key={guard.key} className={`gp-row${guard.on ? "" : " off"}`}>
										<div className="tp-text">
											<div className="gp-label">{guard.label}</div>
											{guard.hint && <div className="tp-desc">{guard.hint}</div>}
										</div>
										{guard.tone && <span className={`gp-tone ${guard.tone}`}>{guard.tone}</span>}
										<Toggle on={guard.on} label={`${guard.on ? "Turn off" : "Turn on"} ${guard.label}`} onChange={guard.toggle} />
									</div>
								))}
								{section.guards.length === 0 && section.empty && <div className="gp-empty">{section.empty}</div>}
							</section>
						);
					})}
					{shown.length === 0 && <div className="empty-note">No guardrails match</div>}
				</div>
				<div className="gp-footer">{footer}</div>
			</div>
		</div>
	);
}
