import { createHash } from "node:crypto";
import type { ExecutionAttachment, ExecutionContext } from "@caupulican/pi-agent-core/paths";
import type { TaskDirectoryBinding, TaskDirectoryState } from "./task-directory-state.ts";

// A valid 4096-character root plus relative path can expand sixfold in JSON. Keep enough
// room for the complete active context and at least one maximum-sized row on every page.
export const MAX_TASK_DIRECTORY_STATUS_BYTES = 128 * 1024;

interface TaskDirectoryStatus {
	state: TaskDirectoryState;
	activeTaskId: string | undefined;
	effective: ExecutionContext | undefined;
	unavailable: string | undefined;
}

/** Read-only, whole-row pagination. A cursor identifies a snapshot, never an execution grant. */
export function projectTaskDirectoryStatus(status: TaskDirectoryStatus, cursor?: string) {
	const { state, ...context } = status;
	const fingerprint = createHash("sha256").update(JSON.stringify(status)).digest("hex");
	const total = state.workspaces.length + state.bindings.length;
	let offset = 0;
	if (cursor !== undefined) {
		const parsed = /^([a-f0-9]{64}):(\d{1,3})$/.exec(cursor);
		if (!parsed || parsed[1] !== fingerprint || Number(parsed[2]) > total)
			throw new Error("Directory status changed or cursor is invalid; request status without a cursor");
		offset = Number(parsed[2]);
	}
	const page = {
		...context,
		version: state.version,
		revision: state.revision,
		selectedWorkspaceId: state.selectedWorkspaceId,
		workspaces: [] as ExecutionAttachment[],
		bindings: [] as TaskDirectoryBinding[],
		totals: { workspaces: state.workspaces.length, bindings: state.bindings.length },
		// Reserve the longest possible cursor before measuring rows; the final cursor can only shrink.
		nextCursor: `${fingerprint}:${total}` as string | undefined,
	};
	let remaining = MAX_TASK_DIRECTORY_STATUS_BYTES - Buffer.byteLength(JSON.stringify(page));
	if (remaining < 0) throw new Error("Directory status context exceeds its byte bound");
	let index = offset;
	for (; index < total; index++) {
		const isWorkspace = index < state.workspaces.length;
		const row = isWorkspace ? state.workspaces[index]! : state.bindings[index - state.workspaces.length]!;
		const length = isWorkspace ? page.workspaces.length : page.bindings.length;
		const bytes = Buffer.byteLength(JSON.stringify(row)) + (length > 0 ? 1 : 0);
		if (bytes > remaining) break;
		remaining -= bytes;
		if (isWorkspace) page.workspaces.push(state.workspaces[index]!);
		else page.bindings.push(state.bindings[index - state.workspaces.length]!);
	}
	if (index === offset && index < total) throw new Error("Directory status cannot fit a complete row");
	page.nextCursor = index < total ? `${fingerprint}:${index}` : undefined;
	return page;
}
