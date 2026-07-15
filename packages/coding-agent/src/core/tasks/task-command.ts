import type { TaskStepStatus } from "./task-state.ts";

export type TaskCommand =
	| { type: "list"; includeTerminal: boolean }
	| { type: "add"; content: string }
	| { type: "update"; selector: string; status: TaskStepStatus; evidence?: string; note?: string }
	| { type: "clear" }
	| { type: "compact" }
	| { type: "retired_execution"; operation: "run" | "route" | "bg" | "team" };

export type ParsedTaskCommand = { ok: true; command: TaskCommand } | { ok: false; error: string };

const TASK_COMMAND_USAGE =
	"Usage: /task [list|all|add <text>|start <selector>|done <selector> [-- evidence]|block <selector> -- <reason>|cancel <selector> [-- reason]|reopen <selector>|clear|compact]";

function splitSelectorAndDetail(value: string): { selector: string; detail?: string } {
	const delimiterIndex = value.indexOf(" -- ");
	if (delimiterIndex >= 0) {
		return {
			selector: value.slice(0, delimiterIndex).trim(),
			detail: value.slice(delimiterIndex + 4).trim() || undefined,
		};
	}
	const [first = "", ...rest] = value.trim().split(/\s+/);
	if ((first === "current" || first === "active" || /^step-[1-9]\d*$/.test(first)) && rest.length > 0) {
		return { selector: first, detail: rest.join(" ") };
	}
	return { selector: value.trim() };
}

function updateCommand(
	operation: "start" | "done" | "block" | "cancel" | "reopen",
	remainder: string,
): ParsedTaskCommand {
	if (!remainder) return { ok: false, error: `${operation} requires a task step selector. ${TASK_COMMAND_USAGE}` };
	if (operation === "start") {
		return { ok: true, command: { type: "update", selector: remainder, status: "in_progress" } };
	}
	if (operation === "reopen") {
		return { ok: true, command: { type: "update", selector: remainder, status: "pending" } };
	}
	const { selector, detail } = splitSelectorAndDetail(remainder);
	if (!selector) return { ok: false, error: `${operation} requires a task step selector. ${TASK_COMMAND_USAGE}` };
	if (operation === "block" && !detail) {
		return {
			ok: false,
			error: `block requires a reason after the selector. Use: /task block <selector> -- <reason>`,
		};
	}
	if (operation === "done") {
		return {
			ok: true,
			command: { type: "update", selector, status: "completed", ...(detail ? { evidence: detail } : {}) },
		};
	}
	if (operation === "block") {
		return { ok: true, command: { type: "update", selector, status: "blocked", note: detail } };
	}
	return {
		ok: true,
		command: { type: "update", selector, status: "cancelled", ...(detail ? { note: detail } : {}) },
	};
}

export function parseTaskCommand(text: string): ParsedTaskCommand {
	const input = text.replace(/^\/(?:task|steps)(?:\s+|$)/, "").trim();
	if (!input || input === "list") return { ok: true, command: { type: "list", includeTerminal: false } };
	if (input === "all" || input === "list all" || input === "list --all") {
		return { ok: true, command: { type: "list", includeTerminal: true } };
	}
	if (input === "clear") return { ok: true, command: { type: "clear" } };
	if (input === "compact") return { ok: true, command: { type: "compact" } };

	const spaceIndex = input.indexOf(" ");
	const operation = spaceIndex < 0 ? input : input.slice(0, spaceIndex);
	const remainder = spaceIndex < 0 ? "" : input.slice(spaceIndex + 1).trim();
	if (operation === "add") {
		return remainder
			? { ok: true, command: { type: "add", content: remainder } }
			: { ok: false, error: `add requires task step text. Use: /task add <text>` };
	}
	if (
		operation === "start" ||
		operation === "done" ||
		operation === "block" ||
		operation === "cancel" ||
		operation === "reopen"
	) {
		return updateCommand(operation, remainder);
	}
	if (operation === "run" || operation === "route" || operation === "bg" || operation === "team") {
		return { ok: true, command: { type: "retired_execution", operation } };
	}
	return { ok: true, command: { type: "add", content: input } };
}
