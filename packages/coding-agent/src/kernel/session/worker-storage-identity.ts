import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { writeFileAtomicSync } from "../storage/atomic-file.ts";
import { readOptionalBoundedTextFileSync } from "../storage/bounded-file.ts";
import { isPlainRecord } from "../utils/value-guards.ts";
import type { AgentResumeContext } from "./agent-identity.ts";
import {
	type OrchestrationHome,
	orchestrationSessionDir,
	orchestrationSessionsDir,
	workerConversationSessionsDir,
} from "./session-bundle-paths.ts";
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

export function workerTranscriptLocation(home: OrchestrationHome, identity: WorkerTranscriptIdentity) {
	const sessionDir = workerConversationSessionsDir(home, identity.parentSessionId);
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

export function assertWorkerConversationFile(home: OrchestrationHome, sessionFile: string, sessionId: string): string {
	const workersRoot = resolve(orchestrationSessionsDir(home));
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

/**
 * A session bundle's worker storage as its records name it. The records (a worker's birth metadata, the agent bindings
 * and delivery executions of the bundle's event store and retention archives) name a worker transcript by absolute path
 * in the orchestration home the bundle lived in when they were written. A bundle moved into another home
 * (`bot-bundle-move.ts`) keeps the roots it lived in before in `<bundle>/former-roots.json`, written into the bundle
 * before its rename so it travels with it; a recorded path under `<former root>/sessions/<bundle>` is read as the same
 * path under the bundle's directory now. The stored bytes are never rewritten: exact-content, digest and idempotency
 * checks keep reading what was written, and every reader of the records gets the paths through this translation. A build
 * up to 0.104.65 never reads the file (it only sizes a bundle's tree).
 */
export interface WorkerStorageIdentity {
	/** The bundle's directory now. */
	readonly bundleDir: string;
	/** The directories the bundle had in its former homes (`<former root>/sessions/<bundle>`), none of them its own. */
	readonly formerBundleDirs: readonly string[];
}

const FORMER_ROOTS_FILE = "former-roots.json";
const MAX_FORMER_ROOTS_BYTES = 64 * 1024;

/** The orchestration home roots the bundle at `bundleDir` lived in before; none for a bundle never moved. */
function readFormerRoots(bundleDir: string): string[] {
	const file = join(bundleDir, FORMER_ROOTS_FILE);
	const text = readOptionalBoundedTextFileSync(file, MAX_FORMER_ROOTS_BYTES, "Session bundle former roots");
	if (text === undefined) return [];
	const value: unknown = JSON.parse(text);
	if (
		!isPlainRecord(value) ||
		!Array.isArray(value.formerRoots) ||
		!value.formerRoots.every((root) => typeof root === "string" && isAbsolute(root))
	)
		throw new Error(`Session bundle former roots ${file} are invalid.`);
	return value.formerRoots as string[];
}

/** The worker storage of the bundle at `bundleDir`, with the roots it was moved from. */
export function workerStorageIdentity(bundleDir: string): WorkerStorageIdentity {
	const dir = resolve(bundleDir);
	const formerBundleDirs = readFormerRoots(dir)
		.map((root) => join(root, "sessions", basename(dir)))
		.filter((former) => former !== dir);
	return { bundleDir: dir, formerBundleDirs };
}

/** {@link workerStorageIdentity} of session `parentSessionId`'s bundle in `home`. */
export function sessionWorkerStorage(home: OrchestrationHome, parentSessionId: string): WorkerStorageIdentity {
	return workerStorageIdentity(orchestrationSessionDir(home, parentSessionId));
}

/** {@link workerStorageIdentity} of the bundle holding the worker transcript, or its metadata, at `file`. */
export function workerFileStorage(file: string): WorkerStorageIdentity {
	return workerStorageIdentity(dirname(dirname(resolve(file))));
}

/**
 * Records that the bundle at `bundleDir` lived under `formerRoot`, before it is moved out of that home. A root it
 * already records is not written again.
 */
export function recordBundleFormerRoot(bundleDir: string, formerRoot: string): void {
	const roots = readFormerRoots(bundleDir);
	const root = resolve(formerRoot);
	if (roots.includes(root)) return;
	writeFileAtomicSync(join(bundleDir, FORMER_ROOTS_FILE), `${JSON.stringify({ formerRoots: [...roots, root] })}\n`, {
		mode: 0o600,
	});
}

/** The path `recorded` names now: under the bundle's directory when it was recorded under a former one, else itself. */
export function currentStoragePath(storage: WorkerStorageIdentity, recorded: string): string {
	for (const former of storage.formerBundleDirs) {
		if (recorded === former) return storage.bundleDir;
		if (recorded.startsWith(former + sep)) return storage.bundleDir + recorded.slice(former.length);
	}
	return recorded;
}

/** `value`, JSON read from the bundle's records, with every path in it as {@link currentStoragePath} names it. */
export function currentStorageRecord<T>(storage: WorkerStorageIdentity, value: T): T {
	if (storage.formerBundleDirs.length === 0) return value;
	const translate = (item: unknown): unknown => {
		if (typeof item === "string") return currentStoragePath(storage, item);
		if (Array.isArray(item)) return item.map(translate);
		if (isPlainRecord(item))
			return Object.fromEntries(Object.entries(item).map(([key, field]) => [key, translate(field)]));
		return item;
	};
	return translate(value) as T;
}
