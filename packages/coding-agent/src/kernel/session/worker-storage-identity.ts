import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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

const MAX_CACHED_FORMER_ROOTS = 1024;

/**
 * The former roots read per bundle directory in this process, each with the identity of the file it was read from
 * (absent, or its device, inode, size and change times): a read whose file has the same identity is answered from here,
 * so the readers of a bundle's records (every mailbox record read among them) stat the file instead of reading it. A
 * write replaces the file (`writeFileAtomicSync`'s rename), which changes its identity.
 */
const formerRootsRead = new Map<string, { readonly identity: string; readonly roots: readonly string[] }>();

function fileIdentity(file: string): string {
	const stat = statSync(file, { throwIfNoEntry: false, bigint: true });
	return stat ? `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}` : "absent";
}

/** The orchestration home roots the bundle at `bundleDir` lived in before; none for a bundle never moved. */
function readFormerRoots(bundleDir: string): readonly string[] {
	const file = join(bundleDir, FORMER_ROOTS_FILE);
	const identity = fileIdentity(file);
	const known = formerRootsRead.get(bundleDir);
	if (known?.identity === identity) return known.roots;
	const roots = parseFormerRoots(file);
	formerRootsRead.delete(bundleDir);
	formerRootsRead.set(bundleDir, { identity, roots });
	if (formerRootsRead.size > MAX_CACHED_FORMER_ROOTS) formerRootsRead.delete(formerRootsRead.keys().next().value!);
	return roots;
}

function parseFormerRoots(file: string): readonly string[] {
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
	const roots = readFormerRoots(resolve(bundleDir));
	const root = resolve(formerRoot);
	if (roots.includes(root)) return;
	writeFileAtomicSync(join(bundleDir, FORMER_ROOTS_FILE), `${JSON.stringify({ formerRoots: [...roots, root] })}\n`, {
		mode: 0o600,
	});
}

/**
 * The path `recorded` names in the bundle's directory now, when it was recorded under a former one: one that resolves
 * inside that former directory reads as the same place inside the bundle's. Anything else, a path that only starts with
 * a former directory's text and resolves outside it included, is not the bundle's and reads as recorded.
 */
function translatedPath(storage: WorkerStorageIdentity, recorded: string): string | undefined {
	for (const former of storage.formerBundleDirs) {
		if (recorded !== former && !recorded.startsWith(former + sep)) continue;
		const inside = relative(former, resolve(recorded));
		if (inside.startsWith("..") || isAbsolute(inside)) return undefined;
		return inside === "" ? storage.bundleDir : join(storage.bundleDir, inside);
	}
	return undefined;
}

/**
 * The path `recorded` names now ({@link translatedPath}), else itself. A file URL (a worker's terminal output artifact
 * is recorded as one) is read the same way, by the path it names.
 */
export function currentStoragePath(storage: WorkerStorageIdentity, recorded: string): string {
	if (!recorded.startsWith("file:")) return translatedPath(storage, recorded) ?? recorded;
	if (!storage.formerBundleDirs.some((former) => recorded.startsWith(pathToFileURL(former).href))) return recorded;
	const translated = translatedPath(storage, fileURLToPath(recorded));
	return translated === undefined ? recorded : pathToFileURL(translated).href;
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
