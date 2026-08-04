import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import type { Tool, ToolArgumentValidationOptions } from "@caupulican/pi-ai";
import { validateToolArguments } from "@caupulican/pi-ai/validation";
import { Type } from "typebox";
import { safeRealpathSync } from "../autonomy/path-scope.ts";
import { type CapabilityGateway, CapabilityGatewayDeniedError } from "../orchestration/capability-gateway.ts";
import type { ToolCapabilityManifest } from "../orchestration/contracts.ts";
import { readBoundedTextFileSync } from "../util/bounded-file.ts";
import { isPlainRecord } from "../util/value-guards.ts";
import type { WorkerActionInspectionRequired, WorkerActionJournal } from "./worker-action-journal.ts";

/**
 * Code-writing workers (G2): the worker MODEL never touches the filesystem — it emits strict-JSON
 * actions, and this RUNNER-side module applies them deterministically through the compiled
 * execution grant. That keeps the structural-contract philosophy (a local model without
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

export type WorkerActionRejectionCode =
	| "worker_actions_invalid_shape"
	| "worker_actions_too_many"
	| "worker_actions_path_too_long"
	| "worker_actions_field_too_large"
	| "worker_actions_payload_too_large";

export interface AcceptedWorkerActions {
	kind: "accepted";
	actions: WorkerAction[];
}

export interface RejectedWorkerActions {
	kind: "rejected";
	reasonCode: WorkerActionRejectionCode;
	message: string;
}

/** The sole structured-action admission result used before execution or worker-result projection. */
export type WorkerActionParseOutcome = AcceptedWorkerActions | RejectedWorkerActions;

/** Bounded model-to-filesystem mutation contract. All execution callers pass through this owner. */
export const MAX_WORKER_ACTIONS = 20;
export const MAX_WORKER_ACTION_PATH_CHARS = 2_048;
export const MAX_WORKER_ACTION_TEXT_CHARS = 512 * 1024;
/** Limits all source/replacement payloads for one atomic worker action batch. */
export const MAX_WORKER_ACTION_PAYLOAD_CHARS = 512 * 1024;
/**
 * A structured edit only needs bounded source/replacement text. Limit the target read to 2 MiB:
 * this admits the largest UTF-8 text payload (512 Ki code units at four bytes each)
 * without letting a small edit cause an unbounded repository-file allocation.
 */
export const MAX_WORKER_ACTION_EDIT_TARGET_BYTES = 2 * 1024 * 1024;

const workerActionSchema = Type.Union([
	Type.Object(
		{
			op: Type.Literal("write"),
			path: Type.String({ minLength: 1, maxLength: MAX_WORKER_ACTION_PATH_CHARS }),
			content: Type.String({ maxLength: MAX_WORKER_ACTION_TEXT_CHARS }),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			op: Type.Literal("edit"),
			path: Type.String({ minLength: 1, maxLength: MAX_WORKER_ACTION_PATH_CHARS }),
			old: Type.String({ minLength: 1, maxLength: MAX_WORKER_ACTION_TEXT_CHARS }),
			new: Type.String({ maxLength: MAX_WORKER_ACTION_TEXT_CHARS }),
		},
		{ additionalProperties: false },
	),
]);

const workerActionsTool: Tool = {
	name: "worker_actions",
	description: "Worker filesystem action list",
	parameters: Type.Object(
		{ actions: Type.Array(workerActionSchema, { maxItems: MAX_WORKER_ACTIONS }) },
		{ additionalProperties: false },
	),
};

function rejectWorkerActions(reasonCode: WorkerActionRejectionCode): RejectedWorkerActions {
	const messages: Record<WorkerActionRejectionCode, string> = {
		worker_actions_invalid_shape: "worker actions must be a strict JSON write/edit action list",
		worker_actions_too_many: `worker actions exceed the ${MAX_WORKER_ACTIONS}-action limit`,
		worker_actions_path_too_long: "worker action path exceeds the allowed limit",
		worker_actions_field_too_large: "worker actions contain a field larger than the allowed limit",
		worker_actions_payload_too_large: "worker actions exceed the aggregate payload limit",
	};
	return { kind: "rejected", reasonCode, message: messages[reasonCode] };
}

function validateWorkerActions(
	raw: unknown,
	validation?: ToolArgumentValidationOptions,
): readonly unknown[] | undefined {
	try {
		const validated = validateToolArguments(
			workerActionsTool,
			{ type: "toolCall", id: "worker-actions", name: "worker_actions", arguments: { actions: raw } },
			validation,
		).actions;
		return Array.isArray(validated) ? validated : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Normalizes every model or direct caller before it can reach the gateway, journal, or filesystem.
 * Any malformed entry rejects the entire batch so a partially malformed request cannot mutate a
 * surprising prefix.
 */
function normalizeWorkerActions(raw: readonly unknown[]): WorkerActionParseOutcome {
	if (raw.length > MAX_WORKER_ACTIONS) return rejectWorkerActions("worker_actions_too_many");
	const actions: WorkerAction[] = [];
	let payloadChars = 0;
	for (const entry of raw) {
		if (!isPlainRecord(entry)) return rejectWorkerActions("worker_actions_invalid_shape");
		const descriptors = Object.getOwnPropertyDescriptors(entry);
		const op = descriptors.op?.value;
		if (op !== "write" && op !== "edit") return rejectWorkerActions("worker_actions_invalid_shape");
		const expectedKeys = op === "write" ? ["op", "path", "content"] : ["op", "path", "old", "new"];
		if (
			Reflect.ownKeys(entry).length !== expectedKeys.length ||
			!expectedKeys.every((key) => {
				const descriptor = descriptors[key];
				return descriptor?.enumerable === true && "value" in descriptor;
			})
		)
			return rejectWorkerActions("worker_actions_invalid_shape");
		const actionPath = descriptors.path?.value;
		if (typeof actionPath !== "string" || actionPath.length === 0)
			return rejectWorkerActions("worker_actions_invalid_shape");
		if (actionPath.length > MAX_WORKER_ACTION_PATH_CHARS) return rejectWorkerActions("worker_actions_path_too_long");
		if (op === "write") {
			const content = descriptors.content?.value;
			if (typeof content !== "string") return rejectWorkerActions("worker_actions_invalid_shape");
			if (content.length > MAX_WORKER_ACTION_TEXT_CHARS)
				return rejectWorkerActions("worker_actions_field_too_large");
			if (payloadChars + content.length > MAX_WORKER_ACTION_PAYLOAD_CHARS)
				return rejectWorkerActions("worker_actions_payload_too_large");
			payloadChars += content.length;
			actions.push({ op: "write", path: actionPath, content });
		} else {
			const old = descriptors.old?.value;
			const replacement = descriptors.new?.value;
			if (typeof old !== "string" || old.length === 0 || typeof replacement !== "string")
				return rejectWorkerActions("worker_actions_invalid_shape");
			if (old.length > MAX_WORKER_ACTION_TEXT_CHARS || replacement.length > MAX_WORKER_ACTION_TEXT_CHARS)
				return rejectWorkerActions("worker_actions_field_too_large");
			if (payloadChars + old.length + replacement.length > MAX_WORKER_ACTION_PAYLOAD_CHARS)
				return rejectWorkerActions("worker_actions_payload_too_large");
			payloadChars += old.length + replacement.length;
			actions.push({ op: "edit", path: actionPath, old, new: replacement });
		}
	}
	return { kind: "accepted", actions };
}

export function parseWorkerActions(raw: unknown, validation?: ToolArgumentValidationOptions): WorkerActionParseOutcome {
	if (raw === undefined) return { kind: "accepted", actions: [] };
	const candidate = Array.isArray(raw) ? normalizeWorkerActions(raw) : undefined;
	if (candidate?.kind === "rejected") return candidate;
	const validated = validateWorkerActions(candidate?.actions ?? raw, validation);
	if (!validated) return rejectWorkerActions("worker_actions_invalid_shape");
	return normalizeWorkerActions(validated);
}

export interface AppliedActionsReport {
	/** Repo-relative paths actually changed. */
	changedFiles: string[];
	/** Grant refusals (execution-time enforcement) — surfaced, never silent. */
	refused: Array<{ path: string; reason: string }>;
	/** Actions that were in scope but could not be applied (missing file, old-text not found). */
	failed: Array<{ path: string; reason: string }>;
	/** Durable replay blocks. The parent must inspect workspace/evidence instead of re-executing. */
	inspectionRequired: Array<{
		path: string;
		actionId: string;
		state: WorkerActionInspectionRequired["state"];
		reasonCode: string;
		evidencePointer?: string;
	}>;
}

export function applyWorkerActions(args: {
	actions: readonly WorkerAction[];
	gateway: CapabilityGateway;
	toolManifests: readonly ToolCapabilityManifest[];
	cwd: string;
	/** Optional durable mutation journal for one fenced worker attempt. */
	actionJournal?: WorkerActionJournal;
}): AppliedActionsReport {
	const report: AppliedActionsReport = { changedFiles: [], refused: [], failed: [], inspectionRequired: [] };
	const manifests = new Map(args.toolManifests.map((manifest) => [manifest.toolName, manifest]));
	const parsedActions = parseWorkerActions(args.actions);
	if (parsedActions.kind === "rejected") {
		report.failed.push({ path: "<worker_actions>", reason: `${parsedActions.reasonCode}: ${parsedActions.message}` });
		return report;
	}
	for (const [index, action] of parsedActions.actions.entries()) {
		const manifest = manifests.get(action.op);
		if (!manifest) {
			report.refused.push({
				path: action.path,
				reason: `${action.op} is not present in the compiled tool manifest`,
			});
			continue;
		}
		try {
			args.gateway.authorizeToolCall(manifest, action.op, { path: action.path });
		} catch (error) {
			if (error instanceof CapabilityGatewayDeniedError) {
				report.refused.push({ path: action.path, reason: `${error.reasonCode}: ${error.message}` });
				continue;
			}
			throw error;
		}
		let target: string;
		let relativePath: string;
		try {
			target = safeRealpathSync(resolve(args.cwd, action.path));
			relativePath = relative(args.cwd, target).replaceAll("\\", "/");
		} catch {
			report.failed.push({ path: action.path, reason: "target path could not be resolved" });
			continue;
		}
		let journalPermit: ReturnType<WorkerActionJournal["begin"]> | undefined;
		if (args.actionJournal) {
			try {
				journalPermit = args.actionJournal.begin({ index, action, targetPath: target });
			} catch {
				report.failed.push({ path: action.path, reason: "mutation journal intent could not be persisted" });
				continue;
			}
			if (journalPermit.kind === "inspection_required") {
				report.inspectionRequired.push({
					path: action.path,
					actionId: journalPermit.actionId,
					state: journalPermit.state,
					reasonCode: journalPermit.reasonCode,
					...(journalPermit.evidencePointer ? { evidencePointer: journalPermit.evidencePointer } : {}),
				});
				continue;
			}
		}
		let mutationStarted = false;
		try {
			if (action.op === "write") {
				// mkdir may create one or more parents before an error or process interruption. Once it
				// is invoked the durable intent is conservatively unknown, never replayed as a precondition failure.
				mutationStarted = true;
				mkdirSync(dirname(target), { recursive: true });
				writeFileSync(target, action.content ?? "", "utf-8");
			} else {
				if (!existsSync(target)) {
					throw new Error("worker_action_file_missing");
				}
				const current = readBoundedTextFileSync(
					target,
					MAX_WORKER_ACTION_EDIT_TARGET_BYTES,
					"Worker action edit target",
				);
				if (!action.old || !current.includes(action.old)) {
					throw new Error("worker_action_old_text_missing");
				}
				mutationStarted = true;
				writeFileSync(
					target,
					current.replace(action.old, () => action.new ?? ""),
					"utf-8",
				);
			}
			if (!report.changedFiles.includes(relativePath)) report.changedFiles.push(relativePath);
			journalPermit?.kind === "execute" &&
				args.actionJournal?.recordSucceeded(journalPermit, {
					evidencePointer: `workspace:file:${target}`,
				});
		} catch {
			if (mutationStarted && journalPermit?.kind === "execute") {
				report.inspectionRequired.push({
					path: action.path,
					actionId: journalPermit.actionId,
					state: "unknown",
					reasonCode: "worker_action_outcome_unknown",
					evidencePointer: `workspace:file:${target}`,
				});
			} else {
				if (journalPermit?.kind === "execute") {
					try {
						args.actionJournal?.recordFailed(journalPermit, "worker_action_precondition_failed", {
							evidencePointer: `workspace:file:${target}`,
						});
					} catch {
						report.inspectionRequired.push({
							path: action.path,
							actionId: journalPermit.actionId,
							state: "unknown",
							reasonCode: "worker_action_outcome_unknown",
							evidencePointer: `workspace:file:${target}`,
						});
					}
				}
				report.failed.push({ path: action.path, reason: "action precondition or filesystem operation failed" });
			}
		}
	}
	return report;
}
