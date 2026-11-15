/**
 * Whether a bot session's workers are shared with another session of the owner's home, which a move of its bundle into
 * the bot's home would cut (`bot-bundle-move.ts`): an agent binding of the session (in its projection or its retention
 * archives) naming a worker transcript outside its own bundle (a specialist another session's bundle holds, which the
 * session claimed, and whose ownership names it), or a specialist directory of the home naming the session (a
 * specialist born in its bundle, claimable by every session of the home). A session that shares none moves its workers
 * with its bundle; their records are read through the bundle's former roots (`worker-storage-identity.ts`).
 */
import { existsSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { type OrchestrationHome, orchestrationSessionDir } from "../../kernel/session/session-bundle-paths.ts";
import { projectSpecialistsNameSession } from "../delegation/worker-project-directory.ts";
import { OrchestrationEventStore } from "../orchestration/event-store.ts";
import { readRetentionArchives, retentionArchiveDir } from "../orchestration/retention-archive.ts";
import { readTaskRuntimeProjection } from "../orchestration/task-runtime-reader.ts";
import { isPlainRecord } from "../util/value-guards.ts";

/** The worker transcripts the session's agent bindings name: in its projection, and in its retention archives. */
function boundWorkerTranscripts(home: OrchestrationHome, sessionId: string): string[] {
	const store = new OrchestrationEventStore({ orchestrationHome: home, sessionId });
	if (!existsSync(store.rootDir)) return [];
	const files: string[] = [];
	for (const agent of Object.values(readTaskRuntimeProjection(store).agents)) {
		if (agent.resumeContext.provider === "pi" && agent.resumeContext.sessionFile)
			files.push(agent.resumeContext.sessionFile);
	}
	for (const archive of readRetentionArchives(retentionArchiveDir(store.rootDir)).archives) {
		if (archive.sessionId !== sessionId) continue;
		for (const agent of Object.values(archive.records.agents ?? {})) {
			if (!isPlainRecord(agent) || !isPlainRecord(agent.resumeContext))
				throw new Error("Archived agent binding is malformed.");
			const { provider, sessionFile } = agent.resumeContext;
			if (provider === "pi" && typeof sessionFile === "string" && sessionFile) files.push(sessionFile);
		}
	}
	return files;
}

/** Whether session `sessionId` of `home` shares its workers with another session of that home. */
export function sessionWorkersShared(home: OrchestrationHome, sessionId: string): boolean {
	const bundle = resolve(orchestrationSessionDir(home, sessionId));
	const outside = (file: string) => {
		const offset = relative(bundle, resolve(file));
		return offset === "" || offset.startsWith("..") || isAbsolute(offset);
	};
	return boundWorkerTranscripts(home, sessionId).some(outside) || projectSpecialistsNameSession(home, sessionId);
}
