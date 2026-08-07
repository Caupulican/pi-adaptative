import { createHash } from "node:crypto";
import { closeSync, fstatSync, openSync, readSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { CURRENT_SESSION_VERSION } from "@caupulican/pi-agent-core/session";

const MAX_WORKER_SESSION_HEADER_BYTES = 64 * 1024;
const WORKER_SESSION_ENTRY_DIGEST_SEED = createHash("sha256").update("pi-worker-session-entry-chain-v1").digest("hex");

export interface WorkerConversationFileRevision {
	readonly dev: bigint;
	readonly ino: bigint;
	readonly size: bigint;
	readonly mtimeNs: bigint;
	readonly ctimeNs: bigint;
}

export interface WorkerSessionFileHead {
	readonly revision: WorkerConversationFileRevision;
	readonly headerDigest: string;
	readonly entryDigest: string;
	readonly entryCount: number;
	readonly prefixDigest?: string;
}

export class WorkerConversationOwnershipError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "WorkerConversationOwnershipError";
	}
}

function revisionFromStats(stats: {
	dev: bigint;
	ino: bigint;
	size: bigint;
	mtimeNs: bigint;
	ctimeNs: bigint;
}): WorkerConversationFileRevision {
	return {
		dev: stats.dev,
		ino: stats.ino,
		size: stats.size,
		mtimeNs: stats.mtimeNs,
		ctimeNs: stats.ctimeNs,
	};
}

export function readWorkerConversationFileRevision(file: string): WorkerConversationFileRevision {
	return revisionFromStats(statSync(file, { bigint: true }));
}

export function sameWorkerConversationFileRevision(
	left: WorkerConversationFileRevision,
	right: WorkerConversationFileRevision,
): boolean {
	return (
		left.dev === right.dev &&
		left.ino === right.ino &&
		left.size === right.size &&
		left.mtimeNs === right.mtimeNs &&
		left.ctimeNs === right.ctimeNs
	);
}

function lineDigest(content: string | Buffer): string {
	return createHash("sha256").update("pi-worker-session-line-v1").update("\0").update(content).digest("hex");
}

function nextEntryDigest(previous: string, byteLength: number, digest: string): string {
	return createHash("sha256")
		.update("pi-worker-session-entry-chain-v1")
		.update("\0")
		.update(previous)
		.update("\0")
		.update(String(byteLength))
		.update("\0")
		.update(digest)
		.digest("hex");
}

function verifyOwnedAppend(
	sessionFile: string,
	previousRevision: WorkerConversationFileRevision,
	serialized: string,
): { revision: WorkerConversationFileRevision; serializedBytes: number; digest: string } {
	const expected = Buffer.from(`${serialized}\n`, "utf8");
	const position = Number(previousRevision.size);
	if (!Number.isSafeInteger(position)) {
		throw new WorkerConversationOwnershipError("Worker conversation changed during its owned append.");
	}
	const fd = openSync(sessionFile, "r");
	try {
		const startRevision = revisionFromStats(fstatSync(fd, { bigint: true }));
		if (
			startRevision.dev !== previousRevision.dev ||
			startRevision.ino !== previousRevision.ino ||
			startRevision.size !== previousRevision.size + BigInt(expected.length)
		) {
			throw new WorkerConversationOwnershipError("Worker conversation changed during its owned append.");
		}
		const actual = Buffer.allocUnsafe(expected.length);
		let bytesRead = 0;
		while (bytesRead < actual.length) {
			const count = readSync(fd, actual, bytesRead, actual.length - bytesRead, position + bytesRead);
			if (count === 0) {
				throw new WorkerConversationOwnershipError("Worker conversation changed during its owned append.");
			}
			bytesRead += count;
		}
		const endRevision = revisionFromStats(fstatSync(fd, { bigint: true }));
		const pathRevision = readWorkerConversationFileRevision(sessionFile);
		if (
			!sameWorkerConversationFileRevision(startRevision, endRevision) ||
			!sameWorkerConversationFileRevision(endRevision, pathRevision) ||
			!actual.equals(expected)
		) {
			throw new WorkerConversationOwnershipError("Worker conversation changed during its owned append.");
		}
		const serializedBytes = actual.length - 1;
		return {
			revision: pathRevision,
			serializedBytes,
			digest: lineDigest(actual.subarray(0, serializedBytes)),
		};
	} finally {
		closeSync(fd);
	}
}

/**
 * Verify the exact bytes appended by SessionManager and advance the trusted raw-file head once.
 *
 * The caller must hold the canonical conversation lock. That advisory lock excludes every
 * supported writer, while revision/digest scans detect changes made between owned critical
 * sections and during cold opens. This bounded append check intentionally reads only the new
 * suffix: it cannot detect a noncooperating process rewriting an equal-length prefix inside the
 * locked append window without reintroducing an O(n) prefix scan or a second durable authority.
 */
export function advanceWorkerSessionHeadAfterOwnedAppend(
	sessionFile: string,
	previousHead: WorkerSessionFileHead,
	serializedEntry: string,
): WorkerSessionFileHead {
	const append = verifyOwnedAppend(sessionFile, previousHead.revision, serializedEntry);
	return {
		revision: append.revision,
		headerDigest: previousHead.headerDigest,
		entryDigest: nextEntryDigest(previousHead.entryDigest, append.serializedBytes, append.digest),
		entryCount: previousHead.entryCount + 1,
	};
}

export function scanWorkerSessionFile(
	sessionFile: string,
	expectedSessionId: string,
	expectedCwd: string,
	prefixEntryCount?: number,
): WorkerSessionFileHead {
	const fd = openSync(sessionFile, "r");
	try {
		return scanOpenWorkerSessionFile(fd, sessionFile, expectedSessionId, expectedCwd, prefixEntryCount);
	} finally {
		closeSync(fd);
	}
}

function scanOpenWorkerSessionFile(
	fd: number,
	sessionFile: string,
	expectedSessionId: string,
	expectedCwd: string,
	prefixEntryCount?: number,
): WorkerSessionFileHead {
	const startRevision = revisionFromStats(fstatSync(fd, { bigint: true }));
	const buffer = Buffer.allocUnsafe(64 * 1024);
	let position = 0;
	let lineBytes = 0;
	let lineHash = createHash("sha256").update("pi-worker-session-line-v1").update("\0");
	let lineIndex = 0;
	let entryDigest = WORKER_SESSION_ENTRY_DIGEST_SEED;
	let prefixDigest = prefixEntryCount === 0 ? entryDigest : undefined;
	let headerDigest = "";
	const headerParts: Buffer[] = [];
	let headerBytes = 0;

	const finishLine = (): void => {
		const digest = lineHash.digest("hex");
		if (lineIndex === 0) {
			headerDigest = digest;
		} else {
			entryDigest = nextEntryDigest(entryDigest, lineBytes, digest);
			if (lineIndex === prefixEntryCount) prefixDigest = entryDigest;
		}
		lineIndex += 1;
		lineBytes = 0;
		lineHash = createHash("sha256").update("pi-worker-session-line-v1").update("\0");
	};

	while (true) {
		const bytesRead = readSync(fd, buffer, 0, buffer.length, position);
		if (bytesRead === 0) break;
		position += bytesRead;
		let segmentStart = 0;
		while (segmentStart < bytesRead) {
			const newlineIndex = buffer.indexOf(0x0a, segmentStart);
			const segmentEnd = newlineIndex < 0 || newlineIndex >= bytesRead ? bytesRead : newlineIndex;
			const segment = buffer.subarray(segmentStart, segmentEnd);
			lineHash.update(segment);
			lineBytes += segment.length;
			if (lineIndex === 0 && segment.length > 0) {
				headerBytes += segment.length;
				if (headerBytes > MAX_WORKER_SESSION_HEADER_BYTES) {
					throw new WorkerConversationOwnershipError("Worker conversation session header exceeds its bound.");
				}
				headerParts.push(Buffer.from(segment));
			}
			if (newlineIndex < 0 || newlineIndex >= bytesRead) break;
			finishLine();
			segmentStart = newlineIndex + 1;
		}
	}
	const endRevision = revisionFromStats(fstatSync(fd, { bigint: true }));
	if (!sameWorkerConversationFileRevision(startRevision, endRevision)) {
		throw new WorkerConversationOwnershipError("Worker conversation session file changed while it was verified.");
	}
	if (lineBytes !== 0) {
		throw new WorkerConversationOwnershipError("Worker conversation session file ends with a partial entry.");
	}
	if (lineIndex === 0) throw new WorkerConversationOwnershipError("Worker conversation session header is missing.");
	let header: unknown;
	try {
		header = JSON.parse(Buffer.concat(headerParts, headerBytes).toString("utf8"));
	} catch {
		throw new WorkerConversationOwnershipError("Worker conversation session header is invalid.");
	}
	if (
		!header ||
		typeof header !== "object" ||
		Array.isArray(header) ||
		(header as { type?: unknown }).type !== "session" ||
		(header as { version?: unknown }).version !== CURRENT_SESSION_VERSION ||
		(header as { id?: unknown }).id !== expectedSessionId ||
		typeof (header as { cwd?: unknown }).cwd !== "string" ||
		resolve((header as { cwd: string }).cwd) !== resolve(expectedCwd)
	) {
		throw new WorkerConversationOwnershipError("Worker conversation session header changed identity.");
	}
	const revision = readWorkerConversationFileRevision(sessionFile);
	if (!sameWorkerConversationFileRevision(revision, endRevision) || revision.size !== BigInt(position)) {
		throw new WorkerConversationOwnershipError("Worker conversation session file changed while it was verified.");
	}
	return {
		revision,
		headerDigest,
		entryDigest,
		entryCount: lineIndex - 1,
		...(prefixDigest ? { prefixDigest } : {}),
	};
}
