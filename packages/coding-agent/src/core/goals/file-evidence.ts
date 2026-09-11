import { readdir, stat } from "node:fs/promises";
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

/**
 * Name a file the model can cite instead, so a directory citation costs one rejection rather than a
 * guessing sequence. Best-effort: an unreadable directory simply contributes no example.
 */
async function firstRegularFileIn(directory: string, signal?: AbortSignal): Promise<string | undefined> {
	try {
		const entries = await readdir(directory, { withFileTypes: true });
		signal?.throwIfAborted();
		return entries
			.filter((entry) => entry.isFile())
			.map((entry) => entry.name)
			.sort()[0];
	} catch {
		return undefined;
	}
}

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
		let directory = false;
		const path = await resolveReadPathAsync(
			uri,
			cwd,
			async (candidate) => {
				const stats = await stat(candidate);
				verified = stats.isFile();
				directory = stats.isDirectory();
			},
			undefined,
			signal,
		);
		if (verified) return { verified, uri: path };
		if (!directory) return { verified, uri: path, reason: "file evidence locator is not a regular file" };
		const example = await firstRegularFileIn(path, signal);
		return {
			verified,
			uri: path,
			reason: `file evidence locator is a directory; cite a file inside it${example ? ` (e.g. ${example})` : ""}`,
		};
	} catch (error) {
		signal?.throwIfAborted();
		return {
			verified: false,
			uri: requestedPath,
			reason: `file evidence unavailable: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}
