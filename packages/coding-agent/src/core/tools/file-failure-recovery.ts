import { realpathSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import {
	type AgentToolFailureRecoveryAuthority,
	type AgentToolFailureRecoveryTarget,
	createAgentToolFailureRecoveryAuthority,
} from "@caupulican/pi-agent-core/types";
import { resolveToCwd } from "./path-utils.ts";

export const FILE_EXISTS_RECOVERY_TARGET_KIND = "filesystem.file.exists";
export const FILE_CURRENT_TEXT_RECOVERY_TARGET_KIND = "filesystem.file.current-text";
export const WORKSPACE_MUTATED_RECOVERY_TARGET_KIND = "filesystem.workspace.mutated";
export const WRITE_RETARGET_RECOVERY_TARGET_KIND = "filesystem.write.retarget";
export const EDIT_RETARGET_RECOVERY_TARGET_KIND = "filesystem.edit.retarget";

export interface FileFailureRecoveryAuthority {
	/** Exact backend identity shared by cooperating tool contracts. */
	readonly contractAuthority: AgentToolFailureRecoveryAuthority;
	/** Pure canonical identity for a path already resolved against the tool cwd. */
	getScope: (absolutePath: string) => string;
}

/** Create one backend authority and pass the same instance to every cooperating custom file tool. */
export function createFileFailureRecoveryAuthority(
	getScope: (absolutePath: string) => string,
): FileFailureRecoveryAuthority {
	return Object.freeze({ contractAuthority: createAgentToolFailureRecoveryAuthority(), getScope });
}

function canonicalizeLocalPath(absolutePath: string): string {
	let existingAncestor = absolutePath;
	const missingSegments: string[] = [];
	while (true) {
		try {
			return resolve(realpathSync.native(existingAncestor), ...missingSegments.reverse());
		} catch {
			const parent = dirname(existingAncestor);
			if (parent === existingAncestor) return absolutePath;
			missingSegments.push(basename(existingAncestor));
			existingAncestor = parent;
		}
	}
}

const LOCAL_FILE_FAILURE_RECOVERY_AUTHORITY = createFileFailureRecoveryAuthority(canonicalizeLocalPath);

export function selectFileFailureRecoveryAuthority(
	usesCustomOperations: boolean,
	explicitAuthority: FileFailureRecoveryAuthority | undefined,
): FileFailureRecoveryAuthority | undefined {
	return explicitAuthority ?? (usesCustomOperations ? undefined : LOCAL_FILE_FAILURE_RECOVERY_AUTHORITY);
}

export function fileRecoveryScope(authority: FileFailureRecoveryAuthority, path: string, cwd: string): string {
	return authority.getScope(resolveToCwd(path, cwd));
}

export function fileRecoveryTarget(
	authority: FileFailureRecoveryAuthority,
	kind: string,
	path: string,
	cwd: string,
): AgentToolFailureRecoveryTarget {
	return {
		authority: authority.contractAuthority,
		kind,
		scope: fileRecoveryScope(authority, path, cwd),
	};
}

export function workspaceRecoveryScope(authority: FileFailureRecoveryAuthority, cwd: string): string {
	return authority.getScope(resolve(cwd));
}

export function workspaceRecoveryTarget(
	authority: FileFailureRecoveryAuthority,
	kind: string,
	cwd: string,
): AgentToolFailureRecoveryTarget {
	return {
		authority: authority.contractAuthority,
		kind,
		scope: workspaceRecoveryScope(authority, cwd),
	};
}
