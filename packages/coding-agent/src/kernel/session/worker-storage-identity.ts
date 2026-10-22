import { createHash } from "node:crypto";
import { basename, isAbsolute, relative, resolve } from "node:path";
import type { AgentResumeContext } from "./agent-identity.ts";
import { orchestrationSessionsDir, workerConversationSessionsDir } from "./session-bundle-paths.ts";
import { assertValidSessionId } from "./session-identity.ts";
import type { WorkerTranscriptIdentity } from "./worker-transcript-reference.ts";

function stableWorkerSessionId(parentSessionId: string, logicalAgentId: string): string {
	const normalizedAgentId = logicalAgentId.trim();
	if (!normalizedAgentId) throw new TypeError("A logical worker agent id is required.");
	const digest = createHash("sha256")
		.update("pi-worker-conversation-v1")
		.update("\0")
		.update(parentSessionId)
		.update("\0")
		.update(normalizedAgentId)
		.digest("hex")
		.slice(0, 32);
	return `worker-${digest}`;
}

export function workerTranscriptLocation(agentDir: string, identity: WorkerTranscriptIdentity) {
	const sessionDir = workerConversationSessionsDir(agentDir, identity.parentSessionId);
	const sessionId = stableWorkerSessionId(identity.parentSessionId, identity.logicalAgentId);
	assertValidSessionId(sessionId);
	return { sessionDir, sessionId, sessionFile: joinWorkerSessionFile(sessionDir, sessionId) };
}

export function matchesWorkerTranscriptLocation(
	context: AgentResumeContext,
	location: ReturnType<typeof workerTranscriptLocation>,
): boolean {
	return (
		context.provider === "pi" &&
		context.sessionId === location.sessionId &&
		typeof context.sessionFile === "string" &&
		context.sessionFile.length > 0 &&
		resolve(context.sessionFile) === resolve(location.sessionFile) &&
		(context.sessionDir === undefined || resolve(context.sessionDir) === resolve(location.sessionDir))
	);
}

export function assertWorkerConversationFile(agentDir: string, sessionFile: string, sessionId: string): string {
	const workersRoot = resolve(orchestrationSessionsDir(agentDir));
	const resolvedFile = resolve(sessionFile);
	const fileRelativeToWorkersRoot = relative(workersRoot, resolvedFile);
	if (
		fileRelativeToWorkersRoot === "" ||
		fileRelativeToWorkersRoot.startsWith("..") ||
		isAbsolute(fileRelativeToWorkersRoot)
	) {
		throw new Error("Worker conversation session file must remain under the canonical worker sessions directory.");
	}
	const segments = fileRelativeToWorkersRoot.split(/[\\/]/);
	if (segments.length !== 3 || segments[1] !== "worker-conversations") {
		throw new Error("Worker conversation session file must remain under the canonical worker sessions directory.");
	}
	if (basename(resolvedFile) !== `${sessionId}.jsonl`) {
		throw new Error("Worker conversation session file does not match its durable session id.");
	}
	return resolvedFile;
}

function joinWorkerSessionFile(sessionDir: string, sessionId: string): string {
	return resolve(sessionDir, `${sessionId}.jsonl`);
}

export function workerConversationMetadataFile(sessionFile: string): string {
	return `${sessionFile}.worker.json`;
}
