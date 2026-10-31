import type { ExtensionUIContext } from "../../core/extensions/types.ts";
import { widgetLines } from "./render.ts";
import { type TodoState, visibleTodos } from "./state.ts";

const WIDGET_KEY = "todos";

export interface TodoWidget {
	refresh(ui: ExtensionUIContext, state: TodoState): void;
	dismissFinished(ui: ExtensionUIContext, state: TodoState): void;
	toggleCollapsed(ui: ExtensionUIContext, state: TodoState): void;
}

function isFinished(state: TodoState): boolean {
	const visible = visibleTodos(state);
	return visible.length > 0 && visible.every((todo) => todo.status === "completed");
}

export function createTodoWidget(getMaxLines: () => number): TodoWidget {
	let collapsed = false;
	let retired = false;
	let shown = false;

	const refresh = (ui: ExtensionUIContext, state: TodoState): void => {
		if (!isFinished(state)) retired = false;
		if (visibleTodos(state).length === 0 || retired) {
			if (shown) ui.setWidget(WIDGET_KEY, undefined);
			shown = false;
			return;
		}
		ui.setWidget(WIDGET_KEY, widgetLines(state, { collapsed, maxLines: getMaxLines() }), {
			placement: "aboveEditor",
		});
		shown = true;
	};

	return {
		refresh,
		dismissFinished(ui, state) {
			if (isFinished(state)) retired = true;
			refresh(ui, state);
		},
		toggleCollapsed(ui, state) {
			collapsed = !collapsed;
			refresh(ui, state);
		},
	};
}
