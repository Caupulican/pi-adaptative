/** Executes the admitted physical phase of an ordered transcript append. */
import type { Stats } from "node:fs";
import type { SessionStorageRoots } from "./session-bundle-paths.ts";
import { type SessionFileMutationKind, withSessionFileMutation } from "./session-file-admission.ts";
import { appendToExistingSessionFile, writeSessionFile } from "./session-file-writing.ts";
import type { ReadonlySessionManager } from "./session-manager.ts";

export interface SessionAppendDiskRequest {
	readonly roots: SessionStorageRoots;
	readonly file: string;
	readonly sessionId: string;
	readonly kind: SessionFileMutationKind;
	readonly payload: string;
	readonly confirmWrite: boolean;
}

export interface SessionAppendDiskStep {
	readonly request: SessionAppendDiskRequest;
	readonly assertCurrent: () => void;
	readonly view?: { session: ReadonlySessionManager; revision: Stats | undefined };
}

export type SessionAppendDiskResult =
	| { revision: Stats; recovered?: { error: unknown } }
	| { failed: true; started: boolean; error: unknown; recovered?: { error: unknown } };

export function executeSessionAppendDisk(
	request: SessionAppendDiskRequest,
	step?: Pick<SessionAppendDiskStep, "assertCurrent" | "view">,
): SessionAppendDiskResult {
	let started = false;
	let recovered: { error: unknown } | undefined;
	try {
		const { roots, file, sessionId, kind, payload } = request;
		const revision = withSessionFileMutation(
			roots,
			file,
			sessionId,
			kind,
			() => {
				step?.assertCurrent();
				started = true;
				const confirm = request.confirmWrite
					? (error: unknown) => {
							recovered = { error };
						}
					: undefined;
				return kind === "create"
					? writeSessionFile(file, "wx", payload, undefined, confirm)
					: appendToExistingSessionFile(file, payload, undefined, confirm);
			},
			step?.view,
		);
		return { revision, recovered };
	} catch (error) {
		return { failed: true, started, error, recovered };
	}
}
