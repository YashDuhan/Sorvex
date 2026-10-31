import { type Todo, type TodoState, type TodoStatus, visibleTodos } from "./state.ts";

export const TODOS_SECTION = "todos";

const MARKERS: Record<TodoStatus, string> = {
	pending: "○",
	in_progress: "◐",
	completed: "✓",
	deleted: "✗",
};

export interface TodoWidgetView {
	collapsed: boolean;
	maxLines: number;
}

function terminalSafe(text: string): string {
	return text.replace(/\p{Cc}+/gu, " ").trim();
}

function label(todo: Todo): string {
	return terminalSafe(todo.status === "in_progress" && todo.activeForm ? todo.activeForm : todo.subject);
}

function unresolvedBlockers(todo: Todo, state: TodoState): number[] {
	return todo.blockedBy.filter((dep) => {
		const status = state.todos.find((other) => other.id === dep)?.status;
		return status === "pending" || status === "in_progress";
	});
}

function taskLine(todo: Todo, state: TodoState): string {
	const blockers = unresolvedBlockers(todo, state);
	const blocked = blockers.length > 0 ? ` (blocked by ${blockers.map((id) => `#${id}`).join(", ")})` : "";
	return `${MARKERS[todo.status]} #${todo.id} ${label(todo)}${blocked}`;
}

function header(visible: readonly Todo[]): string {
	const done = visible.filter((todo) => todo.status === "completed").length;
	return `Todos (${done}/${visible.length})`;
}

export function widgetLines(state: TodoState, view: TodoWidgetView): string[] {
	const visible = visibleTodos(state);
	const title = header(visible);
	if (view.collapsed) {
		const active = visible.find((todo) => todo.status === "in_progress");
		return [active ? `${title} · ${label(active)}` : title];
	}

	const room = view.maxLines - 1;
	if (visible.length <= room) return [title, ...visible.map((todo) => taskLine(todo, state))];
	if (room < 1) return [title];

	const open = visible.filter((todo) => todo.status !== "completed").slice(0, room - 1);
	return [title, ...open.map((todo) => taskLine(todo, state)), `... +${visible.length - open.length} more`];
}

export function commandLines(state: TodoState): string[] {
	const visible = visibleTodos(state);
	if (visible.length === 0) return ["No todos yet. Ask the agent to add some!"];
	const lines = [header(visible)];
	for (const [status, title] of [
		["in_progress", "In progress"],
		["pending", "Pending"],
		["completed", "Completed"],
	] as const) {
		const group = visible.filter((todo) => todo.status === status);
		if (group.length === 0) continue;
		lines.push(`${title}:`, ...group.map((todo) => `  ${taskLine(todo, state)}`));
	}
	return lines;
}

export function openTasksSection(state: TodoState): string | undefined {
	const open = visibleTodos(state).filter((todo) => todo.status !== "completed");
	if (open.length === 0) return undefined;
	return [
		"Open tasks when this session was resumed or compacted. Later todo tool results supersede this list.",
		...open.map((todo) => `- #${todo.id} [${todo.status}] ${terminalSafe(todo.subject)}`),
	].join("\n");
}
