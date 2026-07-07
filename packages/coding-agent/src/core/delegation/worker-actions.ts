import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import type { Tool, ToolArgumentValidationOptions } from "@caupulican/pi-ai";
import { validateToolArguments } from "@caupulican/pi-ai";
import { Type } from "typebox";
import type { CapabilityEnvelope } from "../autonomy/contracts.ts";
import { isPathWithinEnvelope } from "../autonomy/envelope-enforcement.ts";

/**
 * Code-writing workers (G2): the worker MODEL never touches the filesystem — it emits strict-JSON
 * actions, and this RUNNER-side module applies them deterministically through the capability
 * envelope's path scope. That keeps the structural-contract philosophy (a local model without
 * tool-calling templates can still write code) and makes enforcement execution-time, not
 * validation-only: an out-of-scope action is REFUSED with a reason, never silently dropped, and
 * refusals surface as blockers on the result.
 */

export interface WorkerAction {
	op: "write" | "edit";
	path: string;
	/** write: full file content. */
	content?: string;
	/** edit: exact string to replace (must occur in the file). */
	old?: string;
	/** edit: replacement text. */
	new?: string;
}

const MAX_ACTIONS = 20;
const MAX_CONTENT_CHARS = 512 * 1024;

const workerActionSchema = Type.Union([
	Type.Object({
		op: Type.Literal("write"),
		path: Type.String({ minLength: 1 }),
		content: Type.String({ maxLength: MAX_CONTENT_CHARS }),
	}),
	Type.Object({
		op: Type.Literal("edit"),
		path: Type.String({ minLength: 1 }),
		old: Type.String({ minLength: 1 }),
		new: Type.String({ maxLength: MAX_CONTENT_CHARS }),
	}),
]);

const workerActionsTool: Tool = {
	name: "worker_actions",
	description: "Worker filesystem action list",
	parameters: Type.Object({ actions: Type.Array(workerActionSchema) }),
};

function validateWorkerActions(raw: unknown, validation?: ToolArgumentValidationOptions): unknown[] {
	try {
		const validated = validateToolArguments(
			workerActionsTool,
			{ type: "toolCall", id: "worker-actions", name: "worker_actions", arguments: { actions: raw } },
			validation,
		).actions;
		return Array.isArray(validated) ? validated : [];
	} catch {
		return [];
	}
}

function sanitizeWorkerActions(raw: readonly unknown[]): WorkerAction[] {
	const actions: WorkerAction[] = [];
	for (const entry of raw.slice(0, MAX_ACTIONS)) {
		if (!entry || typeof entry !== "object") continue;
		const record = entry as Record<string, unknown>;
		if (record.op !== "write" && record.op !== "edit") continue;
		if (typeof record.path !== "string" || record.path.length === 0) continue;
		if (record.op === "write") {
			if (typeof record.content !== "string" || record.content.length > MAX_CONTENT_CHARS) continue;
			actions.push({ op: "write", path: record.path, content: record.content });
		} else {
			if (typeof record.old !== "string" || record.old.length === 0) continue;
			if (typeof record.new !== "string" || record.new.length > MAX_CONTENT_CHARS) continue;
			actions.push({ op: "edit", path: record.path, old: record.old, new: record.new });
		}
	}
	return actions;
}

export function parseWorkerActions(raw: unknown, validation?: ToolArgumentValidationOptions): WorkerAction[] {
	if (Array.isArray(raw)) return sanitizeWorkerActions(validateWorkerActions(sanitizeWorkerActions(raw), validation));
	return sanitizeWorkerActions(validateWorkerActions(raw, validation));
}

export interface AppliedActionsReport {
	/** Repo-relative paths actually changed. */
	changedFiles: string[];
	/** Envelope-scope refusals (execution-time enforcement) — surfaced, never silent. */
	refused: Array<{ path: string; reason: string }>;
	/** Actions that were in scope but could not be applied (missing file, old-text not found). */
	failed: Array<{ path: string; reason: string }>;
}

export function applyWorkerActions(args: {
	actions: readonly WorkerAction[];
	envelope: CapabilityEnvelope;
	cwd: string;
}): AppliedActionsReport {
	const report: AppliedActionsReport = { changedFiles: [], refused: [], failed: [] };
	for (const action of args.actions) {
		if (!isPathWithinEnvelope(args.envelope, action.path, args.cwd)) {
			report.refused.push({ path: action.path, reason: `outside envelope ${args.envelope.id} path scope` });
			continue;
		}
		const target = resolve(args.cwd, action.path);
		const relativePath = relative(args.cwd, target);
		try {
			if (action.op === "write") {
				mkdirSync(dirname(target), { recursive: true });
				writeFileSync(target, action.content ?? "", "utf-8");
			} else {
				if (!existsSync(target)) {
					report.failed.push({ path: action.path, reason: "file does not exist" });
					continue;
				}
				const current = readFileSync(target, "utf-8");
				if (!action.old || !current.includes(action.old)) {
					report.failed.push({ path: action.path, reason: "edit old-text not found in file" });
					continue;
				}
				writeFileSync(
					target,
					current.replace(action.old, () => action.new ?? ""),
					"utf-8",
				);
			}
			if (!report.changedFiles.includes(relativePath)) report.changedFiles.push(relativePath);
		} catch (error) {
			report.failed.push({ path: action.path, reason: error instanceof Error ? error.message : String(error) });
		}
	}
	return report;
}
