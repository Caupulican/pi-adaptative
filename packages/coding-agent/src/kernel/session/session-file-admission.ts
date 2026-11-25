import { linkSync, lstatSync, realpathSync, type Stats, statSync, unlinkSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
	currentSynchronousFileLockScope,
	isMissingFileError,
	type SynchronousFileLockScope,
	withFileLockSync,
	writeFileAtomicSync,
} from "../storage/atomic-file.ts";
import { readOptionalBoundedTextFileSync, sameFileVersion } from "../storage/bounded-file.ts";
import { isPlainRecord } from "../utils/value-guards.ts";
import { hasCurrentSessionBundleAdmission, withSessionBundleAdmission } from "./session-bundle-lifecycle.ts";
import {
	type OrchestrationHome,
	orchestrationSessionsDir,
	type SessionStorageRoots,
	sameOrchestrationHome,
} from "./session-bundle-paths.ts";
import { readSessionHeaderResult } from "./session-header.ts";
import type { ReadonlySessionManager } from "./session-manager.ts";
import { assertSpecialistContextClaim, type SpecialistContextClaim } from "./specialist-context-ownership.ts";
import { readWorkerConversationMetadata, type WorkerConversationMetadata } from "./worker-conversation-metadata.ts";
import { projectEnrollmentKey } from "./worker-project-enrollment.ts";
import {
	assertWorkerConversationFile,
	matchesWorkerTranscriptLocation,
	workerConversationMetadataFile,
	workerTranscriptLocation,
} from "./worker-storage-identity.ts";

export type SessionFileMutationKind = "create" | "initialize" | "append" | "rewrite" | { enrollmentKey: string };

interface FileOwner {
	/** The orchestration home holding the bundle the file's mutations are admitted against. */
	home: OrchestrationHome;
	parentSessionId: string;
	metadata?: WorkerConversationMetadata;
}

interface WorkerContinuation {
	roots: SessionStorageRoots;
	file: string;
	sessionId: string;
	parentSessionId: string;
	specializationKey: string;
	claim: SpecialistContextClaim;
	lock: SynchronousFileLockScope;
	revision: Stats | undefined;
	enrolling: boolean;
}

const continuations = new Map<string, WorkerContinuation>();

function readPublicationCleanup(file: string): { temporary: string; device: number; inode: number } | undefined {
	const text = readOptionalBoundedTextFileSync(`${file}.publish.json`, 16 * 1024, "Session publication cleanup");
	if (text === undefined) return undefined;
	const value: unknown = JSON.parse(text);
	if (
		!isPlainRecord(value) ||
		Object.keys(value).length !== 4 ||
		value.schemaVersion !== 1 ||
		typeof value.temporaryName !== "string" ||
		basename(value.temporaryName) !== value.temporaryName ||
		!value.temporaryName.startsWith(`${basename(file)}.`) ||
		!value.temporaryName.endsWith(".tmp") ||
		typeof value.device !== "number" ||
		!Number.isSafeInteger(value.device) ||
		value.device < 0 ||
		typeof value.inode !== "number" ||
		!Number.isSafeInteger(value.inode) ||
		value.inode < 0
	)
		throw new Error("Session publication cleanup identity requires inspection.");
	return { temporary: join(dirname(file), value.temporaryName), device: value.device, inode: value.inode };
}

/** Publish without replacement and retain the exact staging-link cleanup for the next write boundary. */
export function publishSessionFileExclusive(temporary: string, target: string): void {
	const revision = statSync(temporary);
	writeFileAtomicSync(
		`${target}.publish.json`,
		`${JSON.stringify({ schemaVersion: 1, temporaryName: basename(temporary), device: revision.dev, inode: revision.ino })}\n`,
	);
	linkSync(temporary, target);
	try {
		unlinkSync(temporary);
		unlinkSync(`${target}.publish.json`);
	} catch {
		// Publication succeeded. A later mutation retries only this exact owned link.
	}
}

function reconcilePublicationCleanup(file: string): void {
	const pending = readPublicationCleanup(file);
	if (!pending) return;
	try {
		const source = lstatSync(pending.temporary);
		if (source.dev !== pending.device || source.ino !== pending.inode || !source.isFile())
			throw new Error("Session publication cleanup identity changed.");
		unlinkSync(pending.temporary);
	} catch (error) {
		if (!isMissingFileError(error)) throw error;
	}
	unlinkSync(`${file}.publish.json`);
}

/** Resolve existing ancestors too: a missing leaf must not hide a symlink into another bundle. */
function assertCanonicalWritePath(file: string): void {
	let ancestor = file;
	const suffix: string[] = [];
	while (true) {
		try {
			const physical = join(realpathSync(ancestor), ...suffix);
			const same = process.platform === "win32" ? physical.toLowerCase() === file.toLowerCase() : physical === file;
			if (!same) throw new Error("Session writes require the canonical physical path, not a filesystem alias.");
			break;
		} catch (error) {
			if (!isMissingFileError(error)) throw error;
			const parent = dirname(ancestor);
			if (parent === ancestor) throw error;
			suffix.unshift(basename(ancestor));
			ancestor = parent;
		}
	}
	try {
		const stat = lstatSync(file);
		const pending = stat.isFile() && stat.nlink > 1 ? readPublicationCleanup(file) : undefined;
		if (stat.isFile() && stat.nlink > 1 && (!pending || pending.device !== stat.dev || pending.inode !== stat.ino))
			throw new Error("Session writes cannot use a multiply linked transcript.");
	} catch (error) {
		if (!isMissingFileError(error)) throw error;
	}
}

/**
 * The orchestration root whose bundle a worker transcript path lies in (`<root>/sessions/<key>/worker-conversations/
 * <file>`, the layout of {@link workerConversationSessionsDir}), else undefined: decided by the path alone.
 */
function workerTranscriptRoot(file: string): string | undefined {
	const conversations = dirname(file);
	if (basename(conversations) !== "worker-conversations") return;
	const sessions = dirname(dirname(conversations));
	return basename(sessions) === "sessions" ? dirname(sessions) : undefined;
}

/** Claimed worker and borrowed lock scopes must keep their exact synchronous owner. */
export function canOffloadSessionAppend(roots: SessionStorageRoots, path: string, sessionId: string): boolean {
	const file = resolve(path);
	return (
		workerTranscriptRoot(file) === undefined &&
		!currentSynchronousFileLockScope(file) &&
		!hasCurrentSessionBundleAdmission(roots.orchestrationHome, sessionId)
	);
}

/**
 * The file's owner in the writer's home: a worker transcript of a bundle there, else the writing session itself. A
 * worker transcript of another home's bundle is refused: its writes are admitted only against the lease of its own
 * home, which this writer does not hold.
 */
function fileOwner(roots: SessionStorageRoots, file: string, sessionId: string): FileOwner {
	assertCanonicalWritePath(resolve(roots.agentDir));
	assertCanonicalWritePath(file);
	const home = roots.orchestrationHome;
	const sessionsDir = resolve(orchestrationSessionsDir(home));
	const inside = relative(sessionsDir, file);
	const isWorker =
		inside !== "" &&
		inside !== ".." &&
		!inside.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
		!isAbsolute(inside);
	if (!isWorker) {
		const foreign = workerTranscriptRoot(file);
		if (foreign !== undefined && foreign !== dirname(sessionsDir))
			throw new Error("A worker transcript of another orchestration home is not written from this session's home.");
		return { home, parentSessionId: sessionId };
	}
	assertWorkerConversationFile(home, file, sessionId);
	const metadata = readWorkerConversationMetadata(workerConversationMetadataFile(file)).metadata;
	if (
		!metadata.parentSessionId ||
		!matchesWorkerTranscriptLocation(
			metadata.resumeContext,
			workerTranscriptLocation(home, {
				parentSessionId: metadata.parentSessionId,
				logicalAgentId: metadata.logicalAgentId,
			}),
		) ||
		resolve(metadata.resumeContext.sessionFile!) !== file ||
		metadata.resumeContext.sessionId !== sessionId
	) {
		throw new Error("Worker transcript birth identity is missing or does not match its canonical location.");
	}
	return { home, parentSessionId: metadata.parentSessionId, metadata };
}

function assertExistingHeader(file: string, sessionId: string): void {
	const header = readSessionHeaderResult(file);
	if (!header.ok || header.header.id !== sessionId) throw new Error("Session file identity changed before mutation.");
}

/** Claim authority exists only inside the exact transcript lock and is never stored on a shared parsed core. */
export function withWorkerTranscriptContinuation<T>(
	roots: SessionStorageRoots,
	session: ReadonlySessionManager,
	claim: SpecialistContextClaim,
	operation: () => T,
	enrolling = false,
): T {
	const file = session.getSessionFile();
	if (!file) throw new Error("Worker continuation requires a persisted transcript.");
	const lock = currentSynchronousFileLockScope(file);
	if (!lock || continuations.has(file))
		throw new Error("Worker continuation requires its own active transcript lock.");
	const owner = fileOwner(roots, file, session.getSessionId());
	const project = owner.metadata?.projectContext;
	if (!project) throw new Error("Worker continuation requires an enrolled project claim.");
	assertSpecialistContextClaim(project.ownership, claim);
	assertExistingHeader(file, session.getSessionId());
	const enrollment = projectEnrollmentKey(session);
	if (
		enrolling
			? enrollment !== undefined || !hasCurrentSessionBundleAdmission(owner.home, owner.parentSessionId)
			: enrollment !== project.specializationKey
	) {
		throw new Error("Worker continuation enrollment does not match its claim.");
	}
	const scope: WorkerContinuation = {
		roots,
		file,
		sessionId: session.getSessionId(),
		parentSessionId: owner.parentSessionId,
		specializationKey: project.specializationKey,
		claim: { ...claim },
		lock,
		revision: statSync(file),
		enrolling,
	};
	continuations.set(file, scope);
	try {
		return operation();
	} finally {
		continuations.delete(file);
	}
}

/**
 * Mandatory physical mutation boundary: admission precedes directory creation and transcript locking. `roots` name the
 * writing session's home, the one whose bundle admits the file's mutations.
 */
export function withSessionFileMutation<T>(
	roots: SessionStorageRoots,
	filePath: string,
	sessionId: string,
	kind: SessionFileMutationKind,
	operation: () => T,
	view?: { session: ReadonlySessionManager; revision: Stats | undefined },
): T {
	const file = resolve(filePath);
	const scope = continuations.get(file);
	if (scope) {
		if (
			scope.roots.agentDir !== roots.agentDir ||
			!sameOrchestrationHome(scope.roots.orchestrationHome, roots.orchestrationHome) ||
			scope.sessionId !== sessionId ||
			currentSynchronousFileLockScope(file) !== scope.lock ||
			(scope.enrolling
				? typeof kind !== "object" || kind.enrollmentKey !== scope.specializationKey
				: kind !== "append")
		)
			throw new Error("Worker continuation cannot authorize this mutation.");
		const owner = fileOwner(roots, file, sessionId);
		if (
			owner.parentSessionId !== scope.parentSessionId ||
			owner.metadata?.projectContext?.specializationKey !== scope.specializationKey
		)
			throw new Error("Worker continuation birth identity changed.");
		assertSpecialistContextClaim(owner.metadata.projectContext.ownership, scope.claim);
		if (!scope.revision || !sameFileVersion(scope.revision, statSync(file)))
			throw new Error("Worker transcript changed outside its continuation.");
		assertExistingHeader(file, sessionId);
		reconcilePublicationCleanup(file);
		try {
			return operation();
		} finally {
			try {
				scope.revision = statSync(file);
			} catch {
				// A post-write read cannot erase the mutation's result or original error.
				scope.revision = undefined;
			}
		}
	}
	const owner = fileOwner(roots, file, sessionId);
	if (owner.metadata?.projectContext)
		throw new Error("Enrolled worker mutation requires the calling owner's exact claim.");
	if (currentSynchronousFileLockScope(file) && !hasCurrentSessionBundleAdmission(owner.home, owner.parentSessionId)) {
		throw new Error("Session bundle admission must precede its transcript lock.");
	}
	return withSessionBundleAdmission(owner.home, owner.parentSessionId, () => {
		const borrowedScope = currentSynchronousFileLockScope(file);
		return withFileLockSync(
			file,
			() => {
				reconcilePublicationCleanup(file);
				const current = fileOwner(roots, file, sessionId);
				if (current.parentSessionId !== owner.parentSessionId || current.metadata?.projectContext)
					throw new Error("Session file owner changed before mutation.");
				if (current.metadata && kind !== "create") {
					if (
						!view?.revision ||
						view.session.getSessionFile() !== file ||
						view.session.getSessionId() !== sessionId ||
						!sameFileVersion(view.revision, statSync(file))
					)
						throw new Error("Worker mutation requires a current validated transcript view.");
					if (projectEnrollmentKey(view.session) !== undefined)
						throw new Error("Worker enrollment metadata was removed or changed.");
				}
				if (kind === "initialize") {
					if (statSync(file).size !== 0) throw new Error("Session initialization requires an empty file.");
				} else if (kind !== "create") assertExistingHeader(file, sessionId);
				return operation();
			},
			borrowedScope ? { borrowedScope } : undefined,
		);
	});
}
