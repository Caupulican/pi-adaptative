import { stat } from "node:fs/promises";
import { resolvePath } from "@caupulican/pi-agent-core/paths";
import { resolveReadPathAsync } from "../tools/path-utils.ts";

export interface GoalFileEvidenceResolution {
	verified: boolean;
	/** Resolved backend locator, never a path relative to a later selected workspace. */
	uri: string;
	reason?: string;
}

/** A non-native backend owns its directory, path dialect, and read authority in this adapter. */
export type GoalFileEvidenceResolver = (uri: string, signal?: AbortSignal) => Promise<GoalFileEvidenceResolution>;

/** Native existence evidence at observation time, not a content hash or renewed filesystem grant. */
export async function resolveNativeGoalFileEvidence(
	uri: string,
	cwd: string,
	signal?: AbortSignal,
): Promise<GoalFileEvidenceResolution> {
	signal?.throwIfAborted();
	const requestedPath = resolvePath(uri, cwd);
	try {
		let verified = false;
		const path = await resolveReadPathAsync(
			uri,
			cwd,
			async (candidate) => {
				verified = (await stat(candidate)).isFile();
			},
			undefined,
			signal,
		);
		return { verified, uri: path, ...(verified ? {} : { reason: "file evidence locator is not a regular file" }) };
	} catch (error) {
		signal?.throwIfAborted();
		return {
			verified: false,
			uri: requestedPath,
			reason: `file evidence unavailable: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}
