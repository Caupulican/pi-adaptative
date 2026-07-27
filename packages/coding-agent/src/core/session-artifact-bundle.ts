import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, rm, unlink } from "node:fs/promises";
import { orchestrationSessionDir } from "./agent-paths.ts";

export type SessionArtifactDeletionMethod = "trash" | "unlink";

export interface SessionArtifactPathDeletion {
	ok: boolean;
	method: SessionArtifactDeletionMethod;
	error?: string;
}

export interface ForegroundSessionBundleDeletion {
	foreground: SessionArtifactPathDeletion;
	workerArtifacts: SessionArtifactPathDeletion | { ok: true; method: "absent" } | { ok: false; method: "preserved" };
	complete: boolean;
}

export interface DeleteForegroundSessionBundleOptions {
	agentDir: string;
	parentSessionId: string;
	sessionPath: string;
	removePath?: (path: string) => Promise<SessionArtifactPathDeletion>;
}

function describeTrashError(result: ReturnType<typeof spawnSync>): string | undefined {
	const parts: string[] = [];
	if (result.error) parts.push(result.error.message);
	const stderr = typeof result.stderr === "string" ? result.stderr.trim() : undefined;
	if (stderr) parts.push(stderr.split("\n")[0] ?? stderr);
	return parts.length > 0 ? `trash: ${parts.join(" · ").slice(0, 200)}` : undefined;
}

/**
 * Move a managed path to the platform trash when available. Permanent removal is a documented
 * fallback only when trash cannot complete the individual path.
 */
export async function removePathWithTrashFallback(path: string): Promise<SessionArtifactPathDeletion> {
	const trashArgs = path.startsWith("-") ? ["--", path] : [path];
	const trashResult = spawnSync("trash", trashArgs, { encoding: "utf-8", timeout: 10_000 });
	if (trashResult.status === 0 || !existsSync(path)) return { ok: true, method: "trash" };

	try {
		const stat = await lstat(path);
		if (stat.isDirectory()) {
			await rm(path, { recursive: true, force: false });
		} else {
			await unlink(path);
		}
		return { ok: true, method: "unlink" };
	} catch (error) {
		const fallbackError = error instanceof Error ? error.message : String(error);
		const trashError = describeTrashError(trashResult);
		return {
			ok: false,
			method: "unlink",
			error: trashError ? `${fallbackError} (${trashError})` : fallbackError,
		};
	}
}

/**
 * Explicitly delete one foreground session together with its exact session-owned control-plane
 * namespace. No age-based cleanup is performed. If the foreground file moves first but its worker
 * bundle cannot, the result reports that partial state rather than claiming a full deletion.
 */
export async function deleteForegroundSessionBundle(
	options: DeleteForegroundSessionBundleOptions,
): Promise<ForegroundSessionBundleDeletion> {
	const removePath = options.removePath ?? removePathWithTrashFallback;
	const foreground = await removePath(options.sessionPath);
	if (!foreground.ok) {
		return { foreground, workerArtifacts: { ok: false, method: "preserved" }, complete: false };
	}

	const workerArtifactsPath = orchestrationSessionDir(options.agentDir, options.parentSessionId);
	if (!existsSync(workerArtifactsPath)) {
		return { foreground, workerArtifacts: { ok: true, method: "absent" }, complete: true };
	}
	const workerArtifacts = await removePath(workerArtifactsPath);
	return { foreground, workerArtifacts, complete: workerArtifacts.ok };
}
