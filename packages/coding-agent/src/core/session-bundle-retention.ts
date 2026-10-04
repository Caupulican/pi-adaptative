import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import {
	orchestrationSessionDeletionFile,
	orchestrationSessionDir,
	orchestrationSessionsDir,
	sessionRootMailboxFile,
	sessionsDir,
} from "./agent-paths.ts";
import { OBLIGATION_LEDGER_NAME, recordDiscardedObligations } from "./delegation/obligation-ledger.ts";
import { SessionRootMailbox, sessionRootMailboxHasMandatoryReply } from "./delegation/session-root-mailbox.ts";
import { WorkerAgentMailbox, workerMailboxHasOpenObligation } from "./delegation/worker-agent-control.ts";
import { WorkerConversationStore } from "./delegation/worker-conversation-store.ts";
import { readWorkerMailboxRecord, workerMailboxPath } from "./delegation/worker-mailbox-record.ts";
import { releaseSessionBundleDeletion } from "./orchestration/session-bundle-lifecycle.ts";
import { listEntries } from "./process-matrix/store.ts";
import { isPlainRecord } from "./util/value-guards.ts";

/**
 * Startup retention for the per-session control-plane bundles under
 * `<agentDir>/state/orchestration/sessions/<session-key>/` (see `agent-paths.ts`).
 *
 * A bundle is removed only when every gate holds:
 * - no live or resumable process-matrix entry (and not this process's own session) names its session;
 * - its newest file is older than {@link SESSION_BUNDLE_QUIET_FLOOR_MS}, which also protects sessions whose
 *   transcript lives outside `<agentDir>/sessions` or has not been written yet;
 * - its parent session transcript is gone, or both the transcript and the bundle are older than
 *   {@link SESSION_BUNDLE_RESUMABLE_MAX_AGE_MS} (a paused session that can still be resumed keeps its
 *   persistent-worker context for that long);
 * - `WorkerConversationStore.reserveBundleDeletion` (fail-closed: live claim, busy or enrolled
 *   specialist context, unreadable transcript) accepts, and no worker or session-root mailbox owes work.
 *
 * An obligation older than {@link SESSION_BUNDLE_MAX_AGE_MS} can never be answered, because the session that
 * owed it is long gone. Before a bundle is refused for one, it is settled as failed with
 * {@link SESSION_BUNDLE_OBLIGATION_EXPIRED_REASON} through the mailbox's own state machine (never marked
 * delivered, replied or acknowledged), and a bounded attributed record is appended to the expiry ledger
 * before the mailbox is written. Settlement is all or nothing per bundle, decided read-only before any
 * write: when one obligation is younger than the age, or one cannot be settled (a project-bound mailbox,
 * an unreadable one), the whole bundle is untouched and refused. A partial settlement would write the
 * mailboxes, refresh the bundle's newest file time and postpone its removal by the full retention age.
 *
 * Work per run is bounded by the constants below; the remainder is left for the next startup, which starts
 * its scan at a different bundle so permanently refused bundles cannot starve later ones. Failures are
 * returned as bounded diagnostics and never thrown.
 */

/** A mailbox obligation older than this can never be answered and is settled as expired. */
export const SESSION_BUNDLE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/**
 * A bundle whose session transcript still exists is kept until both are older than this: the session can
 * still be resumed, and its persistent workers' context must survive a long pause. A bundle whose transcript
 * is gone is not held by it (only {@link SESSION_BUNDLE_QUIET_FLOOR_MS} and the other gates apply).
 */
export const SESSION_BUNDLE_RESUMABLE_MAX_AGE_MS = 180 * 24 * 60 * 60 * 1000;
/** No bundle with a file newer than this is ever touched, whatever its session's state. */
export const SESSION_BUNDLE_QUIET_FLOOR_MS = 24 * 60 * 60 * 1000;
/** The failure reason an expired obligation is settled with. */
export const SESSION_BUNDLE_OBLIGATION_EXPIRED_REASON = "obligation_expired";
/** Bundles removed per startup. */
export const SESSION_BUNDLE_MAX_REMOVALS_PER_RUN = 8;
/** No further bundle is started once this many bytes were removed in one run (the last one may overshoot). */
export const SESSION_BUNDLE_MAX_BYTES_PER_RUN = 256 * 1024 * 1024;

const MAX_BUNDLES_INSPECTED = 1024;
const MAX_SESSION_FILE_NAMES = 100_000;
const MAX_WALK_ENTRIES = 50_000;
const MAX_WALK_DEPTH = 16;
const MAX_MAILBOX_FILES = 512;
const MAX_MAILBOX_BYTES = 16 * 1024 * 1024;
const MAX_DIAGNOSTICS = 8;
const MAX_DIAGNOSTIC_CHARS = 240;
const KEY_DIGEST_SUFFIX = /-[0-9a-f]{16}$/;
const KEY_DIGEST_SUFFIX_LENGTH = 17;
const SESSION_FILE_SUFFIX = ".jsonl";

export interface SessionBundleRetentionOptions {
	agentDir: string;
	/** The session this process owns; its bundle is never removed. */
	currentSessionId: string;
	now?: number;
}

export interface SessionBundleRetentionResult {
	inspected: number;
	removed: number;
	removedBytes: number;
	/** Obligations older than {@link SESSION_BUNDLE_MAX_AGE_MS} settled as expired this run. */
	expiredObligations: number;
	/** At most {@link MAX_DIAGNOSTICS} short messages; empty when nothing went wrong. */
	diagnostics: string[];
}

interface BundleWalk {
	bytes: number;
	newestMtimeMs: number;
	complete: boolean;
}

function describe(error: unknown): string {
	return (error instanceof Error ? error.message : String(error)).slice(0, MAX_DIAGNOSTIC_CHARS);
}

/** Bounded depth-first walk; an exhausted budget reports `complete: false` so the caller fails closed. */
function walkBundle(root: string): BundleWalk {
	const walk: BundleWalk = { bytes: 0, newestMtimeMs: 0, complete: true };
	let remaining = MAX_WALK_ENTRIES;
	const pending: { path: string; depth: number }[] = [{ path: root, depth: 0 }];
	const visit = (path: string): boolean => {
		const stats = lstatSync(path);
		walk.bytes += stats.size;
		walk.newestMtimeMs = Math.max(walk.newestMtimeMs, stats.mtimeMs);
		return stats.isDirectory();
	};
	try {
		visit(root);
		for (let next = pending.pop(); next; next = pending.pop()) {
			if (next.depth > MAX_WALK_DEPTH) {
				walk.complete = false;
				continue;
			}
			for (const entry of readdirSync(next.path, { withFileTypes: true })) {
				if (remaining-- <= 0) {
					walk.complete = false;
					return walk;
				}
				const child = join(next.path, entry.name);
				if (visit(child) && !entry.isSymbolicLink()) pending.push({ path: child, depth: next.depth + 1 });
			}
		}
	} catch {
		walk.complete = false;
	}
	return walk;
}

/** Sessions that a live, winding-down, or resumable process-matrix entry still refers to. */
async function protectedSessionIds(agentDir: string, currentSessionId: string): Promise<Set<string>> {
	const protectedIds = new Set<string>([currentSessionId]);
	for (const entry of await listEntries(agentDir)) {
		if (entry.status === "closed") continue;
		protectedIds.add(entry.agent.resumeContext.sessionId);
		if (entry.parentSessionId) protectedIds.add(entry.parentSessionId);
	}
	return protectedIds;
}

/** Session id -> transcript paths, from file names alone (`<timestamp>_<session-id>.jsonl`); undefined when over budget. */
function indexSessionTranscripts(agentDir: string): Map<string, string[]> | undefined {
	const index = new Map<string, string[]>();
	const root = sessionsDir(agentDir);
	if (!existsSync(root)) return index;
	let names = 0;
	for (const directory of readdirSync(root, { withFileTypes: true })) {
		if (!directory.isDirectory()) continue;
		for (const name of readdirSync(join(root, directory.name))) {
			if (++names > MAX_SESSION_FILE_NAMES) return undefined;
			const separator = name.indexOf("_");
			if (separator < 0 || !name.endsWith(SESSION_FILE_SUFFIX)) continue;
			const id = name.slice(separator + 1, -SESSION_FILE_SUFFIX.length);
			const paths = index.get(id);
			const path = join(root, directory.name, name);
			if (paths) paths.push(path);
			else index.set(id, [path]);
		}
	}
	return index;
}

/** The directory name is `<readable prefix>-<digest>`; only ids that round-trip exactly can be reserved. */
function recoverParentSessionId(agentDir: string, bundleName: string): string | undefined {
	if (!KEY_DIGEST_SUFFIX.test(bundleName)) return undefined;
	const candidate = bundleName.slice(0, -KEY_DIGEST_SUFFIX_LENGTH);
	try {
		return basename(orchestrationSessionDir(agentDir, candidate)) === bundleName ? candidate : undefined;
	} catch {
		return undefined;
	}
}

function readBoundedJson(file: string): unknown {
	if (statSync(file).size > MAX_MAILBOX_BYTES) throw new Error("mailbox exceeds the inspection bound");
	return JSON.parse(readFileSync(file, "utf8")) as unknown;
}

/** Fail-closed: anything unreadable, oversized, or unrecognized counts as owing work. */
function bundleOwesMailboxWork(agentDir: string, parentSessionId: string, bundleDir: string): boolean {
	try {
		const rootMailbox = sessionRootMailboxFile(agentDir, parentSessionId);
		if (existsSync(rootMailbox)) {
			const state = readBoundedJson(rootMailbox);
			if (!isPlainRecord(state) || !Array.isArray(state.replies)) return true;
			if (sessionRootMailboxHasMandatoryReply({ replies: state.replies })) return true;
		}
		const mailboxDir = join(bundleDir, "worker-mailboxes");
		if (!existsSync(mailboxDir)) return false;
		const names = readdirSync(mailboxDir);
		if (names.length > MAX_MAILBOX_FILES) return true;
		for (const name of names) {
			const file = join(mailboxDir, name);
			// A lock directory or temporary file means a writer is active: unknown state.
			if (!name.endsWith(".json") || statSync(file).size > MAX_MAILBOX_BYTES) return true;
			const { mailbox } = readWorkerMailboxRecord(file);
			if (
				!isPlainRecord(mailbox) ||
				!Array.isArray(mailbox.messages) ||
				!Array.isArray(mailbox.replyAcknowledgements)
			)
				return true;
			if (
				workerMailboxHasOpenObligation({
					messages: mailbox.messages,
					replyAcknowledgements: mailbox.replyAcknowledgements,
				})
			)
				return true;
		}
		return false;
	} catch {
		return true;
	}
}

/**
 * Read-only: whether settling at the retention age would leave this bundle owing nothing, every open
 * obligation expired and settleable by the mailbox's own rule. Fail-closed like {@link bundleOwesMailboxWork}.
 */
function everyOpenObligationExpires(
	agentDir: string,
	parentSessionId: string,
	bundleDir: string,
	now: number,
): boolean {
	const cutoffMs = now - SESSION_BUNDLE_MAX_AGE_MS;
	try {
		if (
			existsSync(sessionRootMailboxFile(agentDir, parentSessionId)) &&
			!new SessionRootMailbox({ agentDir, parentSessionId }).expiresEveryMandatoryReply(cutoffMs)
		)
			return false;
		const mailboxDir = join(bundleDir, "worker-mailboxes");
		if (!existsSync(mailboxDir)) return true;
		const names = readdirSync(mailboxDir);
		if (names.length > MAX_MAILBOX_FILES) return false;
		for (const name of names) {
			const file = join(mailboxDir, name);
			if (!name.endsWith(".json") || statSync(file).size > MAX_MAILBOX_BYTES) return false;
			const { reference, mailbox } = readWorkerMailboxRecord(file);
			if (
				!isPlainRecord(mailbox) ||
				!Array.isArray(mailbox.messages) ||
				!Array.isArray(mailbox.replyAcknowledgements)
			)
				return false;
			if (
				!workerMailboxHasOpenObligation({
					messages: mailbox.messages,
					replyAcknowledgements: mailbox.replyAcknowledgements,
				})
			)
				continue;
			const agentId = mailbox.agentId;
			if (reference || typeof agentId !== "string" || workerMailboxPath(agentDir, parentSessionId, agentId) !== file)
				return false;
			if (
				!new WorkerAgentMailbox({ agentDir, parentSessionId, agentId }).settlesEveryOpenObligation(
					cutoffMs,
					SESSION_BUNDLE_OBLIGATION_EXPIRED_REASON,
				)
			)
				return false;
		}
		return true;
	} catch {
		return false;
	}
}

/**
 * Settle every obligation in this bundle older than the retention age. Each settlement writes its ledger
 * record first, inside the mailbox transaction, so an unwritable ledger settles nothing. Failures are
 * reported and leave the obligation in place; the caller re-checks and stays fail-closed.
 */
function settleExpiredObligations(
	agentDir: string,
	parentSessionId: string,
	bundleName: string,
	bundleDir: string,
	now: number,
	report: (message: string) => void,
): number {
	const cutoffMs = now - SESSION_BUNDLE_MAX_AGE_MS;
	const at = new Date(now).toISOString();
	const record = (kind: string, agentId: string | undefined, settled: readonly object[]): void =>
		recordDiscardedObligations({
			agentDir,
			parentSessionId,
			kind,
			...(agentId ? { agentId } : {}),
			bundle: bundleName,
			reason: SESSION_BUNDLE_OBLIGATION_EXPIRED_REASON,
			settled,
			at,
		});
	let settledCount = 0;
	try {
		if (existsSync(sessionRootMailboxFile(agentDir, parentSessionId))) {
			settledCount += new SessionRootMailbox({ agentDir, parentSessionId }).expireMandatoryReplies(
				cutoffMs,
				SESSION_BUNDLE_OBLIGATION_EXPIRED_REASON,
				(settled) => record("session_root_mailbox", undefined, settled),
			).length;
		}
	} catch (error) {
		report(`session bundle ${bundleName} root mailbox obligations not settled: ${describe(error)}`);
	}
	try {
		const mailboxDir = join(bundleDir, "worker-mailboxes");
		if (!existsSync(mailboxDir)) return settledCount;
		const names = readdirSync(mailboxDir);
		if (names.length > MAX_MAILBOX_FILES) return settledCount;
		for (const name of names) {
			if (!name.endsWith(".json")) continue;
			try {
				const file = join(mailboxDir, name);
				if (statSync(file).size > MAX_MAILBOX_BYTES) continue;
				const { reference, mailbox } = readWorkerMailboxRecord(file);
				// A project-bound mailbox is mutable only under its specialist context's claim, which retention never holds.
				if (reference || !isPlainRecord(mailbox) || typeof mailbox.agentId !== "string") continue;
				const agentId = mailbox.agentId;
				if (workerMailboxPath(agentDir, parentSessionId, agentId) !== file) continue;
				settledCount += new WorkerAgentMailbox({ agentDir, parentSessionId, agentId }).expireOpenObligations(
					cutoffMs,
					SESSION_BUNDLE_OBLIGATION_EXPIRED_REASON,
					(settled) => record("worker_mailbox", agentId, settled),
				).length;
			} catch (error) {
				report(`session bundle ${bundleName} mailbox ${name} obligations not settled: ${describe(error)}`);
			}
		}
	} catch (error) {
		report(`session bundle ${bundleName} worker mailboxes not settled: ${describe(error)}`);
	}
	return settledCount;
}

function latestMtimeMs(paths: readonly string[]): number | undefined {
	let latest = 0;
	for (const path of paths) latest = Math.max(latest, statSync(path).mtimeMs);
	return paths.length > 0 ? latest : undefined;
}

/**
 * Remove expired session bundles through the existing reservation protocol. Event-driven: call it once
 * from the main session's startup, never from a worker and never on a timer.
 */
export async function sweepSessionBundles(
	options: SessionBundleRetentionOptions,
): Promise<SessionBundleRetentionResult> {
	const { agentDir, currentSessionId } = options;
	const now = options.now ?? Date.now();
	const result: SessionBundleRetentionResult = {
		inspected: 0,
		removed: 0,
		removedBytes: 0,
		expiredObligations: 0,
		diagnostics: [],
	};
	const report = (message: string): void => {
		if (result.diagnostics.length < MAX_DIAGNOSTICS) result.diagnostics.push(message.slice(0, MAX_DIAGNOSTIC_CHARS));
	};
	try {
		const root = orchestrationSessionsDir(agentDir);
		if (!existsSync(root)) return result;
		const names = (await readdir(root, { withFileTypes: true }))
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.sort();
		// Remembering nothing: the window starts at a different bundle each startup (the clock picks it), so
		// bundles that stay refused at the head of the order cannot starve the ones behind them.
		const start = names.length > 0 ? Math.floor(now / 1000) % names.length : 0;
		const bundles = [...names.slice(start), ...names.slice(0, start)].slice(0, MAX_BUNDLES_INSPECTED);
		const protectedIds = await protectedSessionIds(agentDir, currentSessionId);
		const transcripts = indexSessionTranscripts(agentDir);
		if (!transcripts) {
			report("session bundle retention skipped: the session transcript index exceeded its bound");
			return result;
		}
		for (const name of bundles) {
			if (
				result.removed >= SESSION_BUNDLE_MAX_REMOVALS_PER_RUN ||
				result.removedBytes >= SESSION_BUNDLE_MAX_BYTES_PER_RUN
			)
				break;
			// Yield between bundles: the walk and the reservation are synchronous.
			await new Promise<void>((resolve) => setImmediate(resolve));
			result.inspected++;
			try {
				const parentSessionId = recoverParentSessionId(agentDir, name);
				if (!parentSessionId || protectedIds.has(parentSessionId)) continue;
				const sessionMtimeMs = latestMtimeMs(transcripts.get(parentSessionId) ?? []);
				if (sessionMtimeMs !== undefined && now - sessionMtimeMs <= SESSION_BUNDLE_RESUMABLE_MAX_AGE_MS) continue;
				const bundleDir = join(root, name);
				const walk = walkBundle(bundleDir);
				if (!walk.complete) continue;
				const quietMs = now - walk.newestMtimeMs;
				if (quietMs <= SESSION_BUNDLE_QUIET_FLOOR_MS) continue;
				if (sessionMtimeMs !== undefined && quietMs <= SESSION_BUNDLE_RESUMABLE_MAX_AGE_MS) continue;

				const hadTombstone = existsSync(orchestrationSessionDeletionFile(agentDir, parentSessionId));
				// The tombstone excludes new worker contexts for this session while the checks and removal run.
				if (!WorkerConversationStore.reserveBundleDeletion(agentDir, parentSessionId)) continue;
				if (bundleOwesMailboxWork(agentDir, parentSessionId, bundleDir)) {
					// Obligations older than the retention age can never be answered: settle them, then re-check.
					// Only when every one of them expires: a bundle that keeps a younger or unsettleable obligation
					// is refused untouched, because settling part of it would only postpone its removal.
					if (!everyOpenObligationExpires(agentDir, parentSessionId, bundleDir, now)) {
						if (!hadTombstone) releaseSessionBundleDeletion(agentDir, parentSessionId);
						continue;
					}
					const settled = settleExpiredObligations(agentDir, parentSessionId, name, bundleDir, now, report);
					result.expiredObligations += settled;
					if (settled === 0 || bundleOwesMailboxWork(agentDir, parentSessionId, bundleDir)) {
						if (!hadTombstone) releaseSessionBundleDeletion(agentDir, parentSessionId);
						continue;
					}
				}
				await rm(bundleDir, { recursive: true, force: true });
				if (existsSync(bundleDir)) {
					report(`session bundle ${name} was only partly removed; it stays reserved for the next startup`);
					continue;
				}
				releaseSessionBundleDeletion(agentDir, parentSessionId);
				result.removed++;
				result.removedBytes += walk.bytes;
			} catch (error) {
				report(`session bundle ${name} retained: ${describe(error)}`);
			}
		}
	} catch (error) {
		report(`session bundle retention failed: ${describe(error)}`);
	}
	if (result.expiredObligations > 0) {
		result.diagnostics = [
			`settled ${result.expiredObligations} expired mailbox obligation(s) in old session bundles as ${SESSION_BUNDLE_OBLIGATION_EXPIRED_REASON}; evidence: <agentDir>/state/orchestration/${OBLIGATION_LEDGER_NAME}`,
			...result.diagnostics,
		].slice(0, MAX_DIAGNOSTICS);
	}
	return result;
}
