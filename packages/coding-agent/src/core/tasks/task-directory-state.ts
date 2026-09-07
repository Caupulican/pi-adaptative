import {
	createExecutionContext,
	type ExecutionAttachment,
	type ExecutionContext,
	resolveExecutionResource,
} from "@caupulican/pi-agent-core/paths";
import { isPlainRecord } from "../util/value-guards.ts";

export const MAX_TASK_WORKSPACES = 32;
export const MAX_TASK_DIRECTORY_BINDINGS = 128;
const MAX_DIRECTORY_PATH_LENGTH = 4096;

export interface TaskDirectoryBinding {
	readonly taskId: string;
	readonly pinned: boolean;
	/** Absent for an unpinned task: selection is captured at each admission. */
	readonly workspaceId?: string;
	readonly path: string;
}

export interface TaskDirectoryState {
	readonly version: 1;
	readonly revision: number;
	readonly selectedWorkspaceId: string;
	readonly workspaces: readonly ExecutionAttachment[];
	readonly bindings: readonly TaskDirectoryBinding[];
}

/** Directory validation/authorization is an adapter obligation before committing these commands. */
export type TaskDirectoryCommand =
	| { action: "register" | "reattach"; attachment: ExecutionAttachment }
	| { action: "select"; workspaceId: string }
	| { action: "bind"; taskId: string; pinned: boolean; workspaceId?: string; path?: string }
	| { action: "forget"; taskId: string };

function requireTaskIdentity(taskId: string): void {
	if (!taskId || taskId.length > 200 || /[\u0000-\u001f\u007f]/u.test(taskId)) {
		throw new Error("Task identity must be bounded nonempty text");
	}
}

function validatedAttachment(attachment: ExecutionAttachment): ExecutionAttachment {
	if (attachment.root.length > MAX_DIRECTORY_PATH_LENGTH) throw new Error("Workspace root exceeds path bound");
	return createExecutionContext({ attachment, cwd: attachment.root, sessionId: "validation", generation: 0 })
		.attachment;
}

function workspace(state: TaskDirectoryState, workspaceId: string): ExecutionAttachment {
	const attachment = state.workspaces.find((candidate) => candidate.workspaceId === workspaceId);
	if (!attachment) throw new Error(`Unknown workspace ${JSON.stringify(workspaceId)}`);
	return attachment;
}

function directoryContext(
	attachment: ExecutionAttachment,
	path: string,
	sessionId: string,
	generation: number,
): ExecutionContext {
	if (path.length > MAX_DIRECTORY_PATH_LENGTH) throw new Error("Task directory exceeds path bound");
	const base = createExecutionContext({ attachment, cwd: attachment.root, sessionId, generation });
	const resolved = resolveExecutionResource(base, { base: "workspace", path });
	return createExecutionContext({ ...base, cwd: resolved.path });
}

function freezeState(state: TaskDirectoryState): TaskDirectoryState {
	return Object.freeze({
		version: 1,
		revision: state.revision,
		selectedWorkspaceId: state.selectedWorkspaceId,
		workspaces: Object.freeze(state.workspaces.map(validatedAttachment)),
		bindings: Object.freeze(state.bindings.map((binding) => Object.freeze({ ...binding }))),
	});
}

export function createTaskDirectoryState(attachment: ExecutionAttachment): TaskDirectoryState {
	return freezeState({
		version: 1,
		revision: 0,
		selectedWorkspaceId: attachment.workspaceId,
		workspaces: [attachment],
		bindings: [],
	});
}

export function resolveTaskDirectoryContext(
	state: TaskDirectoryState,
	taskId: string | undefined,
	sessionId: string,
	inheritUnbound = false,
): ExecutionContext {
	if (taskId !== undefined) requireTaskIdentity(taskId);
	const binding = state.bindings.find((candidate) => candidate.taskId === taskId);
	if (taskId !== undefined && !binding && !inheritUnbound)
		throw new Error(`Task has no directory binding: ${JSON.stringify(taskId)}`);
	const context = directoryContext(
		workspace(state, binding?.workspaceId ?? state.selectedWorkspaceId),
		binding?.path ?? ".",
		sessionId,
		state.revision,
	);
	return createExecutionContext({ ...context, ...(taskId === undefined ? {} : { taskId }) });
}

/** Pure transition; no process-global cwd, filesystem, shell session, or persistence side effects. */
export function transitionTaskDirectoryState(
	state: TaskDirectoryState,
	command: TaskDirectoryCommand,
): TaskDirectoryState {
	let workspaces = state.workspaces;
	let bindings = state.bindings;
	let selectedWorkspaceId = state.selectedWorkspaceId;
	switch (command.action) {
		case "register":
		case "reattach": {
			const attachment = validatedAttachment(command.attachment);
			const existing = workspaces.find((candidate) => candidate.workspaceId === attachment.workspaceId);
			if (existing && JSON.stringify(existing) === JSON.stringify(attachment)) return state;
			if (command.action === "register" && existing)
				throw new Error("Workspace already registered; use explicit reattachment");
			if (command.action === "reattach" && !existing) throw new Error("Cannot reattach an unknown workspace");
			if (workspaces.some((candidate) => candidate.attachmentId === attachment.attachmentId)) {
				throw new Error("Reattachment requires a fresh attachment identity");
			}
			if (!existing && workspaces.length >= MAX_TASK_WORKSPACES) throw new Error("Workspace registry is full");
			workspaces = existing
				? workspaces.map((candidate) => (candidate === existing ? attachment : candidate))
				: [...workspaces, attachment];
			break;
		}
		case "select":
			workspace(state, command.workspaceId);
			if (selectedWorkspaceId === command.workspaceId) return state;
			selectedWorkspaceId = command.workspaceId;
			break;
		case "bind": {
			requireTaskIdentity(command.taskId);
			if (typeof command.pinned !== "boolean") throw new Error("Pin mode must be explicit");
			if (!command.pinned && command.workspaceId !== undefined)
				throw new Error("Unpinned tasks inherit the selected workspace");
			const path = command.path ?? ".";
			const workspaceId = command.pinned ? (command.workspaceId ?? selectedWorkspaceId) : undefined;
			directoryContext(workspace(state, workspaceId ?? selectedWorkspaceId), path, "validation", state.revision);
			const binding: TaskDirectoryBinding = {
				taskId: command.taskId,
				pinned: command.pinned,
				...(workspaceId ? { workspaceId } : {}),
				path,
			};
			const existing = bindings.find((candidate) => candidate.taskId === command.taskId);
			if (
				existing &&
				existing.pinned === binding.pinned &&
				existing.workspaceId === binding.workspaceId &&
				existing.path === path
			)
				return state;
			if (!existing && bindings.length >= MAX_TASK_DIRECTORY_BINDINGS)
				throw new Error("Task directory registry is full");
			bindings = existing
				? bindings.map((candidate) => (candidate === existing ? binding : candidate))
				: [...bindings, binding];
			break;
		}
		case "forget":
			requireTaskIdentity(command.taskId);
			bindings = bindings.filter((binding) => binding.taskId !== command.taskId);
			if (bindings.length === state.bindings.length) return state;
			break;
	}
	if (state.revision >= Number.MAX_SAFE_INTEGER) throw new Error("Task directory revision exhausted");
	const next = freezeState({ ...state, revision: state.revision + 1, selectedWorkspaceId, workspaces, bindings });
	// Reattachment or selection may change dialect. Validate every affected portable reference before publication.
	for (const binding of next.bindings) resolveTaskDirectoryContext(next, binding.taskId, "validation");
	return next;
}

/** Corrupt latest state must block restoration; never silently resurrect an older directory binding. */
export function restoreTaskDirectoryState(value: unknown): TaskDirectoryState {
	if (
		!isPlainRecord(value) ||
		value.version !== 1 ||
		!Number.isSafeInteger(value.revision) ||
		Number(value.revision) < 0 ||
		typeof value.selectedWorkspaceId !== "string" ||
		!Array.isArray(value.workspaces) ||
		value.workspaces.length === 0 ||
		value.workspaces.length > MAX_TASK_WORKSPACES ||
		!Array.isArray(value.bindings) ||
		value.bindings.length > MAX_TASK_DIRECTORY_BINDINGS
	) {
		throw new Error("Invalid task directory snapshot");
	}
	const workspaces = value.workspaces.map((attachment: unknown) => {
		if (
			!isPlainRecord(attachment) ||
			typeof attachment.workspaceId !== "string" ||
			typeof attachment.attachmentId !== "string" ||
			typeof attachment.root !== "string" ||
			(attachment.flavor !== "posix" && attachment.flavor !== "win32") ||
			typeof attachment.caseSensitive !== "boolean"
		) {
			throw new Error("Invalid workspace attachment snapshot");
		}
		return validatedAttachment({
			workspaceId: attachment.workspaceId,
			attachmentId: attachment.attachmentId,
			root: attachment.root,
			flavor: attachment.flavor,
			caseSensitive: attachment.caseSensitive,
		});
	});
	const bindings = value.bindings.map((binding: unknown): TaskDirectoryBinding => {
		if (
			!isPlainRecord(binding) ||
			typeof binding.taskId !== "string" ||
			typeof binding.pinned !== "boolean" ||
			typeof binding.path !== "string" ||
			(binding.pinned ? typeof binding.workspaceId !== "string" : binding.workspaceId !== undefined)
		) {
			throw new Error("Invalid task directory binding snapshot");
		}
		requireTaskIdentity(binding.taskId);
		return {
			taskId: binding.taskId,
			pinned: binding.pinned,
			path: binding.path,
			...(typeof binding.workspaceId === "string" ? { workspaceId: binding.workspaceId } : {}),
		};
	});
	if (
		new Set(workspaces.map((item) => item.workspaceId)).size !== workspaces.length ||
		new Set(workspaces.map((item) => item.attachmentId)).size !== workspaces.length ||
		new Set(bindings.map((item) => item.taskId)).size !== bindings.length
	)
		throw new Error("Duplicate directory snapshot identities");
	const state = freezeState({
		version: 1,
		revision: Number(value.revision),
		selectedWorkspaceId: value.selectedWorkspaceId,
		workspaces,
		bindings,
	});
	workspace(state, state.selectedWorkspaceId);
	for (const binding of bindings) resolveTaskDirectoryContext(state, binding.taskId, "validation");
	return state;
}
