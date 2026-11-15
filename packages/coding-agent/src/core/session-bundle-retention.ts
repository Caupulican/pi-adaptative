import { existsSync, lstatSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { basename, dirname, join, posix, relative, resolve, sep } from "node:path";
import { harnessLog } from "../kernel/harness-log.ts";
import { isValidSessionId } from "../kernel/session/session-identity.ts";
import {
	BOTS_DIR_NAME,
	capabilityArtifactsDir,
	type OrchestrationHome,
	orchestrationSessionDir,
	orchestrationSessionsDir,
	ownerOrchestrationHome,
	sessionRootMailboxFile,
	sessionsDir,
} from "./agent-paths.ts";
import { historyReferencedSessionIds } from "./bots/bot-history.ts";
import {
	type BotHomeHold,
	type BotHomeUnknown,
	type BotSessionHolds,
	readBotSessionHolds,
} from "./bots/bot-session-holds.ts";
import { obligationLedgerFile, recordDiscardedObligations } from "./delegation/obligation-ledger.ts";
import { PersistentBotTeamStore } from "./delegation/persistent-bot-team-store.ts";
import { SessionRootMailbox, sessionRootMailboxHasMandatoryReply } from "./delegation/session-root-mailbox.ts";
import { WorkerAgentMailbox, workerMailboxHasOpenObligation } from "./delegation/worker-agent-control.ts";
import { reserveWorkerBundleDeletion } from "./delegation/worker-bundle-deletion.ts";
import { readWorkerMailboxRecord, workerMailboxPath } from "./delegation/worker-mailbox-record.ts";
import {
	earlierAwayFleetQueueMetadataFile,
	earlierAwayFleetQueueSetAsideFiles,
	sessionFleetQueueMetadataPaths,
} from "./fleet/fleet-queue-store.ts";
import { interfaceText } from "./language/interface-text.ts";
import { OrchestrationEventStore } from "./orchestration/event-store.ts";
import {
	inspectSessionBundleRetention,
	markSessionBundleRemoving,
	pendingSessionBundleRetention,
	type SessionBundleDeletionPhase,
	type SessionBundleDeletionReservation,
	sessionBundleRetentionsInFlight,
	settleSessionBundleDeletion,
	withSessionBundleRetention,
} from "./orchestration/session-bundle-lifecycle.ts";
import { readTaskRuntimeProjection } from "./orchestration/task-runtime-reader.ts";
import { workerReceiptPublicationPending } from "./orchestration/worker-receipt-publication.ts";
import { listEntries } from "./process-matrix/store.ts";
import { type GoneSessionSettlement, settleGoneSessionRoutines } from "./routines/routine-origin-settlement.ts";
import { isPlainRecord } from "./util/value-guards.ts";

/**
 * Startup retention for the per-session control-plane bundles of every orchestration home: the
 * owner's, `<agentDir>/state/orchestration/sessions/<session-key>/`, then each bot home's,
 * `bots/<id>/orchestration/sessions/<session-key>/` (see `agent-paths.ts`), with or without its profile. Retention
 * removes bundles only: a bot home itself, its session files and its other state are never removed here (deleting a
 * bot is its own action). Each home is swept by the same gates; the bot homes are read once per run
 * (`readBotSessionHolds`), and each home's session files are listed on their own. In a home whose sessions cannot be
 * told, or whose session files do not list (reported; a symbolic link that does not resolve fails the listing), no
 * bundle is reserved: only the reservations an earlier run made are resumed, so none is stranded, and every session
 * such a home has a file of is held; while a bot home's files do not list, no owner-home bundle whose session has no
 * listed file is reserved either (it may be that bot's). A home whose bundles or deletion records do not list is
 * reported and left; the others are swept.
 *
 * A bundle is removed only when every gate holds:
 * - no live or resumable process-matrix entry (and not this process's own session) names its session;
- it is not a bot home's current session (its pointer's, `bot-session-pointer.ts`) nor the session a live bot host
 *   holds (`host.lock` held by a process not proven dead, its session read from `host-state.json`); one of those whose
 *   retention an earlier run left in flight is resumed rather than kept, since no lease is admitted to a reserved bundle
 *   (its bot could not open it again) until the removal settles;
 * - its newest file is older than {@link SESSION_BUNDLE_QUIET_FLOOR_MS}, which also protects sessions whose
 *   transcript lives outside `<agentDir>/sessions` and the bot homes or has not been written yet;
 * - its parent session transcript (under `<agentDir>/sessions`, or a bot's own under `bots/<id>/sessions`) is
 *   gone, or both the transcript and the bundle are older than {@link SESSION_BUNDLE_RESUMABLE_MAX_AGE_MS} (a
 *   paused session that can still be resumed keeps its persistent-worker context for that long);
 * - `reserveWorkerBundleDeletion` (fail-closed: live claim, busy or enrolled
 *   specialist context, unreadable transcript) accepts, and no worker or session-root mailbox owes work;
 * - no durable usage or accepted-worker receipt is waiting for parent delivery;
 * - no bot's history references a run of its session (`historyReferencedSessionIds`, over every home the run's one
 *   listing of `bots/` found, a symlinked one included): a bot's chat reads its earlier worker conversations from the
 *   bundle. While a bot index that exists does not read, or a home's link does not resolve (each reported), which of
 *   the owner's sessions it holds is unknown: no bundle of the owner's home is newly reserved, and a retention there
 *   resumed before its removal began takes only the exits that release it (below) or waits, named; the bot homes,
 *   whose sessions no history names, are swept as usual.
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
 * Before the bundles, the same run settles the routine work of a session that was deleted (its transcript gone, no
 * process holding it, quiet for {@link SESSION_BUNDLE_QUIET_FLOOR_MS}), since that session never opens again to settle it
 * itself: its dispatched runs are settled as uncertain when the process matrix proves nothing runs them, its pending
 * results are settled undeliverable and its routines retired as `origin-lost`
 * (`settleGoneSessionRoutines`). It needs the owner's session files listed, so an owner listing that fails or exceeds its
 * bound skips it; work whose origin session file lies in a bot home whose files did not list, or where a live host may
 * hold a session no id names, is left.
 *
* Each removal is reserved in its home's tombstone (`session-bundle-lifecycle.ts`) and marked `removing` there just
 * before anything is removed (the bundle's side files, its fleet queue and capability artifacts, first): a deferral
 * before that releases a tombstone this run created (the bundle is whole), and a resumed removal marked begun skips the
 * gates its bundle already passed and finishes, also when the bundle itself is already gone. A tombstone an earlier
 * build wrote, or one whose remover settled what the bundle owed, does not record how far its removal went
 * (`unrecorded`): it is resumed through the gates; refused by one only the open session settles (receipts awaiting
 * delivery, a younger or project-bound obligation), or held by a process or a bot's history, it is released, told
 * naming the session, and it stays only while its bundle does not read. Opening its session releases it as well, and a
 * removal that began and stopped too (`session-bundle-lifecycle.ts`, admission mode `open`).
 *
* Work per run is bounded by the constants below; the remainder is left for the next startup. Each run first takes the
 * retentions earlier runs left in flight, from each home's in-flight index (permanent tombstones are never read):
 * releases, and removals that began, before the bot history is read; the others once it reads; all within the removal
 * budget and from a window the clock rotates across the homes. Then it scans every home's bundles as one list, starting
 * at a different bundle each time, so permanently refused bundles cannot starve later ones in any home. Failures are
 * returned as bounded diagnostics and never thrown; warnings about single homes take at most
 * {@link MAX_HOME_DIAGNOSTICS} of them.
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
/** Bundles removed per startup, across every home. */
export const SESSION_BUNDLE_MAX_REMOVALS_PER_RUN = 8;
/** No further bundle is started once this many bytes were removed in one run (the last one may overshoot). */
export const SESSION_BUNDLE_MAX_BYTES_PER_RUN = 256 * 1024 * 1024;

/** Bundles inspected per run, across every home. */
const MAX_BUNDLES_INSPECTED = 1024;
/** File names listed per home's session files. */
const MAX_SESSION_FILE_NAMES = 100_000;
const MAX_WALK_ENTRIES = 50_000;
const MAX_WALK_DEPTH = 16;
const MAX_MAILBOX_FILES = 512;
const MAX_MAILBOX_BYTES = 16 * 1024 * 1024;
const MAX_DIAGNOSTICS = 8;
const MAX_DIAGNOSTIC_CHARS = 240;
/** Warnings about single homes shown per run; the rest are counted in one line (each is in the harness log). */
const MAX_HOME_DIAGNOSTICS = 4;
/** A bot's name in a warning, at most this many characters. */
const MAX_NAME_CHARS = 48;
/** Retentions in flight (`sessionBundleRetentionsInFlight`) inspected per run, across every home. */
const MAX_RESUMES_PER_RUN = 64;
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
	/** Routine results addressed to a deleted session settled undeliverable this run (`settleGoneSessionRoutines`). */
	settledRoutineResults: number;
	/** Routines of a deleted session retired as `origin-lost` this run. */
	retiredRoutines: number;
	/** Dispatched routine runs of a deleted session settled as uncertain this run. */
	uncertainRoutineRuns: number;
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

/**
 * Sessions that a live, winding-down, or resumable process-matrix entry still refers to (`processHeld`), and with them
 * (`ids`) the sessions the bot homes hold (`botHeldSessionIds`): a bot's session runs inside its host's process, which
 * the matrix names by its own session only, so each bot's current session and each live host's session are counted
 * beside the matrix's. `tracked`: this process's own session has a live entry, so processes register here and a session
 * neither names is held by no process and runs no worker (process tracking off, or this process's registration failed,
 * proves nothing).
 */
async function protectedSessionIds(
	agentDir: string,
	currentSessionId: string,
	botHeld: ReadonlySet<string>,
): Promise<{
	readonly ids: ReadonlySet<string>;
	readonly processHeld: ReadonlySet<string>;
	readonly tracked: boolean;
}> {
	const processHeld = new Set<string>([currentSessionId]);
	let tracked = false;
	for (const entry of await listEntries(agentDir)) {
		if (entry.status === "closed") continue;
		processHeld.add(entry.agent.resumeContext.sessionId);
		if (entry.parentSessionId) processHeld.add(entry.parentSessionId);
		if (entry.agent.resumeContext.sessionId === currentSessionId) tracked = true;
	}
	return {
		ids: new Set([...processHeld, ...botHeld]),
		processHeld,
		tracked,
	};
}

/**
 * The sessions the bot homes hold (`readBotSessionHolds`), and in a home whose holds cannot be told, every session that
 * home has a file of: its current session, or a live host's, is one of them (or one it is creating, which has no
 * routine work yet and no bundle the sweep would reserve).
 */
function botHeldSessionIds(
	bots: BotSessionHolds,
	transcripts: ReadonlyMap<string, readonly string[]>,
): ReadonlySet<string> {
	const held = new Set(bots.heldSessionIds);
	const unknownDirs = bots.homes.flatMap((hold) =>
		hold.kind === "undetermined" ? [resolve(hold.home.sessionsDir)] : [],
	);
	if (unknownDirs.length === 0) return held;
	for (const [sessionId, paths] of transcripts)
		if (paths.some((path) => unknownDirs.includes(dirname(resolve(path))))) held.add(sessionId);
	return held;
}

/** The session files of every home, listed once per run, each home on its own. */
interface SessionFileIndex {
	/** Session id -> transcript paths, across the homes whose files were listed. */
	readonly files: ReadonlyMap<string, readonly string[]>;
	/** Whether the owner's session files were listed. */
	readonly ownerListed: boolean;
	/** The bot homes whose session files were not listed (unreadable, or over the bound): their sessions are unknown. */
	readonly unlistedBots: ReadonlySet<BotHomeHold>;
	/** Whether any bot home's files were not listed, an unresolved one's included: a session's file may be among them. */
	readonly someBotUnlisted: boolean;
}

/**
 * Adds the session files in `directories` to `files`, from file names alone (`<timestamp>_<session-id>.jsonl`), at most
 * {@link MAX_SESSION_FILE_NAMES} names; why they could not all be listed, when they could not (nothing is added then).
 */
function listSessionFiles(directories: () => readonly string[], files: Map<string, string[]>): string | undefined {
	const found: [string, string][] = [];
	let names = 0;
	try {
		for (const directory of directories()) {
			if (!existsSync(directory)) continue;
			for (const name of readdirSync(directory)) {
				if (++names > MAX_SESSION_FILE_NAMES) return `more than ${MAX_SESSION_FILE_NAMES} file names`;
				const separator = name.indexOf("_");
				if (separator < 0 || !name.endsWith(SESSION_FILE_SUFFIX)) continue;
				found.push([name.slice(separator + 1, -SESSION_FILE_SUFFIX.length), join(directory, name)]);
			}
		}
	} catch (error) {
		return describe(error);
	}
	for (const [id, path] of found) {
		const paths = files.get(id);
		if (paths) paths.push(path);
		else files.set(id, [path]);
	}
	return undefined;
}

/**
 * Lists every home's session files, each home within its own bound: one home whose files do not list (reported) leaves
 * the others listed. A main session's files sit in one directory per working directory; a bot's own sit in its home.
 */
function indexSessionFiles(
	agentDir: string,
	bots: BotSessionHolds,
	reportHome: (message: string) => void,
): SessionFileIndex {
	const files = new Map<string, string[]>();
	const ownerRoot = sessionsDir(agentDir);
	const ownerFailure = listSessionFiles(
		() =>
			existsSync(ownerRoot)
				? readdirSync(ownerRoot, { withFileTypes: true }).flatMap((entry) => {
						const dir = join(ownerRoot, entry.name);
						if (entry.isDirectory()) return [dir];
						// A symlinked directory holds session files as a directory does; a link that does not resolve may
						// hold some, so it fails the listing (thrown by the stat).
						return entry.isSymbolicLink() && statSync(dir).isDirectory() ? [dir] : [];
					})
				: [],
		files,
	);
	if (ownerFailure !== undefined) {
		harnessLog.warn("sessions", "the owner's session files do not list", { detail: ownerFailure });
		reportHome(interfaceText().sessions.retention.ownerFilesUnlisted);
	}
	const unlistedBots = new Set<BotHomeHold>();
	for (const hold of bots.homes) {
		const failure = listSessionFiles(() => [hold.home.sessionsDir], files);
		if (failure === undefined) continue;
		unlistedBots.add(hold);
		harnessLog.warn("bots", "a bot home's session files do not list", { home: hold.home.dir, detail: failure });
		reportHome(interfaceText().botTeam.botHomeRetentionFailed(boundedName(hold.displayName)));
	}
	// What such a home holds is unknown, its history included, so the run's cleanup past what is in flight waits for it.
	for (const { name } of bots.unresolvedHomes)
		reportHome(interfaceText().botTeam.botHomeLinkUnresolved(boundedName(name)));
	return {
		files,
		ownerListed: ownerFailure === undefined,
		unlistedBots,
		someBotUnlisted: unlistedBots.size > 0 || bots.unresolvedHomes.length > 0,
	};
}

/** A name told to the owner, cut to {@link MAX_NAME_CHARS} characters. */
function boundedName(name: string): string {
	const characters = [...name];
	return characters.length <= MAX_NAME_CHARS ? name : `${characters.slice(0, MAX_NAME_CHARS - 1).join("")}…`;
}

/**
 * Settles the routine work of deleted sessions, which never open again to settle it. Its own step: a routine store that
 * cannot be read is logged and leaves the bundle retention to run.
 */
function settleRoutinesOfGoneSessions(
	agentDir: string,
	matrix: { readonly ids: ReadonlySet<string>; readonly tracked: boolean },
	transcripts: ReadonlyMap<string, readonly string[]>,
	heldSessionDirs: ReadonlySet<string>,
	nowMs: number,
): GoneSessionSettlement {
	const warn = (message: string): void => harnessLog.warn("routines", message);
	try {
		return settleGoneSessionRoutines({
			store: new PersistentBotTeamStore(agentDir, warn),
			protectedSessionIds: matrix.ids,
			processTracked: matrix.tracked,
			heldSessionDirs,
			sessionFiles: (sessionId) => transcripts.get(sessionId) ?? [],
			nowMs,
			quietFloorMs: SESSION_BUNDLE_QUIET_FLOOR_MS,
		});
	} catch (error) {
		warn(`the routine work of deleted sessions was not settled: ${describe(error)}`);
		return { uncertainRuns: 0, settledResults: 0, retiredRoutines: 0 };
	}
}

/**
 * The directory name is `<readable prefix>-<digest>`; only a session id whose bundle name round-trips exactly can be
 * reserved.
 */
function recoverParentSessionId(home: OrchestrationHome, bundleName: string): string | undefined {
	if (!KEY_DIGEST_SUFFIX.test(bundleName)) return undefined;
	const candidate = bundleName.slice(0, -KEY_DIGEST_SUFFIX_LENGTH);
	if (!isValidSessionId(candidate)) return undefined;
	return basename(orchestrationSessionDir(home, candidate)) === bundleName ? candidate : undefined;
}

function readBoundedJson(file: string): unknown {
	if (statSync(file).size > MAX_MAILBOX_BYTES) throw new Error("mailbox exceeds the inspection bound");
	return JSON.parse(readFileSync(file, "utf8")) as unknown;
}

/** Fail-closed: anything unreadable, oversized, or unrecognized counts as owing work. */
function bundleOwesMailboxWork(home: OrchestrationHome, parentSessionId: string, bundleDir: string): boolean {
	try {
		const rootMailbox = sessionRootMailboxFile(home, parentSessionId);
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
 * What the bundle's open obligations ask of its expiry, read-only: `expires` when settling at the retention age would
 * leave it owing nothing (every open obligation expired and settleable by the mailbox's own rule); `younger` or
 * `project-bound` when one is the session's to answer (younger than the age, or in a mailbox only its specialist
 * context's claim may change); `unreadable` when one could not be read, which wins over the others. Fail-closed like
 * {@link bundleOwesMailboxWork}.
 */
type ObligationVerdict = "expires" | "younger" | "project-bound" | "unreadable";

function openObligationsVerdict(
	agentDir: string,
	home: OrchestrationHome,
	parentSessionId: string,
	bundleDir: string,
	now: number,
): ObligationVerdict {
	const cutoffMs = now - SESSION_BUNDLE_MAX_AGE_MS;
	let verdict: ObligationVerdict = "expires";
	try {
		if (
			existsSync(sessionRootMailboxFile(home, parentSessionId)) &&
			!new SessionRootMailbox({ orchestrationHome: home, parentSessionId }).expiresEveryMandatoryReply(cutoffMs)
		)
			verdict = "younger";
		const mailboxDir = join(bundleDir, "worker-mailboxes");
		if (!existsSync(mailboxDir)) return verdict;
		const names = readdirSync(mailboxDir);
		if (names.length > MAX_MAILBOX_FILES) return "unreadable";
		for (const name of names) {
			const file = join(mailboxDir, name);
			if (!name.endsWith(".json") || statSync(file).size > MAX_MAILBOX_BYTES) return "unreadable";
			const { reference, mailbox } = readWorkerMailboxRecord(file);
			if (
				!isPlainRecord(mailbox) ||
				!Array.isArray(mailbox.messages) ||
				!Array.isArray(mailbox.replyAcknowledgements)
			)
				return "unreadable";
			if (
				!workerMailboxHasOpenObligation({
					messages: mailbox.messages,
					replyAcknowledgements: mailbox.replyAcknowledgements,
				})
			)
				continue;
			if (reference) {
				verdict = "project-bound";
				continue;
			}
			const agentId = mailbox.agentId;
			if (typeof agentId !== "string" || workerMailboxPath(home, parentSessionId, agentId) !== file)
				return "unreadable";
			if (
				!new WorkerAgentMailbox({
					agentDir,
					orchestrationHome: home,
					parentSessionId,
					agentId,
				}).settlesEveryOpenObligation(cutoffMs, SESSION_BUNDLE_OBLIGATION_EXPIRED_REASON)
			)
				verdict = "younger";
		}
		return verdict;
	} catch {
		return "unreadable";
	}
}

/**
 * Settle every obligation in this bundle older than the retention age. Each settlement writes its ledger
 * record first, inside the mailbox transaction, so an unwritable ledger settles nothing. Failures are
 * reported and leave the obligation in place; the caller re-checks and stays fail-closed.
 */
function settleExpiredObligations(
	agentDir: string,
	home: OrchestrationHome,
	parentSessionId: string,
	bundleName: string,
	bundleDir: string,
	now: number,
	report: (message: string) => void,
	reservation: SessionBundleDeletionReservation,
): number {
	const cutoffMs = now - SESSION_BUNDLE_MAX_AGE_MS;
	const at = new Date(now).toISOString();
	const record = (kind: string, agentId: string | undefined, settled: readonly object[]): void =>
		recordDiscardedObligations({
			orchestrationHome: home,
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
		if (existsSync(sessionRootMailboxFile(home, parentSessionId))) {
			settledCount += new SessionRootMailbox({ orchestrationHome: home, parentSessionId }).expireMandatoryReplies(
				cutoffMs,
				SESSION_BUNDLE_OBLIGATION_EXPIRED_REASON,
				(settled) => record("session_root_mailbox", undefined, settled),
				reservation,
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
				if (workerMailboxPath(home, parentSessionId, agentId) !== file) continue;
				settledCount += new WorkerAgentMailbox({
					agentDir,
					orchestrationHome: home,
					parentSessionId,
					agentId,
				}).expireOpenObligations(
					cutoffMs,
					SESSION_BUNDLE_OBLIGATION_EXPIRED_REASON,
					(settled) => record("worker_mailbox", agentId, settled),
					reservation,
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

/** Whether this run removed as much as it may: no further bundle is started in any home. */
function budgetSpent(result: SessionBundleRetentionResult): boolean {
	return (
		result.removed >= SESSION_BUNDLE_MAX_REMOVALS_PER_RUN || result.removedBytes >= SESSION_BUNDLE_MAX_BYTES_PER_RUN
	);
}

/** What one run reads once and every home's sweep shares. */
interface SweepRun {
	readonly agentDir: string;
	readonly now: number;
	/** Sessions the process matrix names: their bundles are never reserved. */
	readonly processHeld: ReadonlySet<string>;
	/**
	 * Those and the sessions the bot homes hold: their bundles are not reserved, but one an earlier run already reserved
	 * is resumed, since no lease is admitted to it (its bot cannot open it) until its removal settles.
	 */
	readonly protectedIds: ReadonlySet<string>;
	readonly historyHeld: ReadonlySet<string>;
	/**
	 * Some bot's history does not read, or some bot home's link does not resolve: which of the owner's sessions a bot's
	 * history holds is not known (`HomeSweep.rootSessions`).
	 */
	readonly historyUnknown: boolean;
	readonly transcripts: ReadonlyMap<string, readonly string[]>;
	readonly result: SessionBundleRetentionResult;
	/** The obligation ledgers this sweep recorded expiries in, one per home that settled any. */
	readonly obligationLedgers: Set<string>;
	report(message: string): void;
}

/** One home's part of a run. */
interface HomeSweep {
	readonly home: OrchestrationHome;
	/**
	 * The owner's home: its sessions are the root sessions a bot's history references (`historyReferencedSessionIds`), so
	 * while those references are unknown (`SweepRun.historyUnknown`) no bundle of it is newly reserved, and a retention of
	 * it resumed before its removal began takes only the exits that release it, which read no history.
	 */
	readonly rootSessions: boolean;
	/** The bundle directory names under its `sessions/`. */
	readonly names: readonly string[];
	/** The sessions whose retention its in-flight index names (`sessionBundleRetentionsInFlight`). */
	readonly inFlight: readonly string[];
	/** Its deletion records that did not read this run: index entries, and tombstones inspected. */
	unreadable: number;
	/** The warning that `count` of its deletion records do not read. */
	unreadableText(count: number): string;
	/** How the harness log names the home. */
	readonly logName: string;
	/** How a bundle is named in the run's diagnostics and in the expiry ledger. */
	labelOf(name: string): string;
	/**
	 * The home's sessions cannot be told (a bot home's current or live session unknown, or its session files not listed):
	 * no bundle is reserved, only the reservations an earlier run made are resumed.
	 */
	readonly resumeOnly: boolean;
	/**
	 * Some other home's session files were not listed, and a session of this home may have its files there: a bundle whose
	 * session has no listed file is not reserved (the owner's home, which may still hold a bot session's bundle).
	 */
	readonly unfiledHeld: boolean;
}

/** The startup warning for a bot home whose sessions cannot be told. */
function botHomeUnknownText(name: string, unknown: BotHomeUnknown): string {
	const text = interfaceText().botTeam;
	switch (unknown.kind) {
		case "host-state-unreadable":
			return text.botHomeHostStateUnreadable(name);
		case "current-session-unknown":
			return text.botHomeCurrentSessionUnknown(name);
		case "host-session-unnamed":
			return text.botHomeHostSessionUnnamed(name);
	}
}

/**
 * The session's files outside its bundle that name only what the bundle held, removed under the bundle's reservation
 * once the bundle is gone: its fleet queue files (they order and stop attempts the bundle's ledger held), the away
 * controller's an earlier build named `<id>.away.json` among them when it is the session's
 * (`earlierAwayFleetQueueMetadataFile`) and the ones its away runs set aside under that name
 * (`earlierAwayFleetQueueSetAsideFiles`), and its capability artifacts.
 */
function sessionSideFiles(home: OrchestrationHome, sessionId: string): string[] {
	const earlier = earlierAwayFleetQueueMetadataFile(home, sessionId);
	return [
		...sessionFleetQueueMetadataPaths(home, sessionId),
		...(earlier !== undefined ? [earlier] : []),
		...earlierAwayFleetQueueSetAsideFiles(home, sessionId),
		capabilityArtifactsDir(home, sessionId),
	];
}

function removeSessionSideFiles(paths: readonly string[]): void {
	for (const path of paths) rmSync(path, { recursive: true, force: true });
}

/** The walk of a bundle already gone: nothing to measure, nothing newer than any age. */
const GONE_BUNDLE_WALK: BundleWalk = { bytes: 0, newestMtimeMs: 0, complete: true };

/**
 * Sweeps one bundle of one orchestration home through every gate; the run's removal and byte budget is shared by every
 * home and checked by the caller. `resume`: the phase of its retention in flight, when the caller inspected it;
 * otherwise its tombstone is read here.
 */
async function sweepBundle(
	run: SweepRun,
	sweep: HomeSweep,
	name: string,
	resume?: Exclude<SessionBundleDeletionPhase, "reserved">,
): Promise<void> {
	const { agentDir, now, processHeld, protectedIds, historyHeld, transcripts, result, report } = run;
	const { home, labelOf, resumeOnly, unfiledHeld } = sweep;
	const root = orchestrationSessionsDir(home);
	// Yield between bundles: the walk and the reservation are synchronous.
	await new Promise<void>((resolve) => setImmediate(resolve));
	result.inspected++;
	const label = labelOf(name);
	try {
		const parentSessionId = recoverParentSessionId(home, name);
		if (!parentSessionId) return;
		const pending = resume ?? pendingSessionBundleRetention(home, parentSessionId);
		const resumingDeletion = pending !== undefined;
		// Held by a process, or by a bot history (which a removal that began, having passed every gate, no longer reads):
		// never removed. An `unrecorded` tombstone of such a session is still taken below, to be released.
		const held = processHeld.has(parentSessionId) || (pending !== "removing" && historyHeld.has(parentSessionId));
		if (held && pending !== "unrecorded") return;
		const historyUnknown = run.historyUnknown && sweep.rootSessions;
		if (!resumingDeletion && (resumeOnly || historyUnknown || protectedIds.has(parentSessionId))) return;
		// Its session's files may be in a home whose files were not listed, which would hold it.
		if (!resumingDeletion && unfiledHeld && !transcripts.has(parentSessionId)) return;
		const sessionMtimeMs = latestMtimeMs(transcripts.get(parentSessionId) ?? []);
		if (
			!resumingDeletion &&
			sessionMtimeMs !== undefined &&
			now - sessionMtimeMs <= SESSION_BUNDLE_RESUMABLE_MAX_AGE_MS
		)
			return;
		const bundleDir = join(root, name);
		// A resumed retention whose bundle is already gone settles under its reservation below.
		const walk = resumingDeletion && !existsSync(bundleDir) ? GONE_BUNDLE_WALK : walkBundle(bundleDir);
		// A removal that began finishes whatever is left of its bundle; the walk only measures it then.
		if (!walk.complete && pending !== "removing") return;
		const quietMs = now - walk.newestMtimeMs;
		if (!resumingDeletion && quietMs <= SESSION_BUNDLE_QUIET_FLOOR_MS) return;
		if (!resumingDeletion && sessionMtimeMs !== undefined && quietMs <= SESSION_BUNDLE_RESUMABLE_MAX_AGE_MS) return;

		// The tombstone excludes new worker contexts for this session while the checks and removal run.
		const reservation = reserveWorkerBundleDeletion(agentDir, home, parentSessionId, "retention", resumingDeletion);
		if (!reservation) return;
		// A deferral before anything of the bundle is touched releases a `reserved` tombstone (the bundle is whole) and
		// keeps an `unrecorded` one: how far an earlier removal went is not known.
		let outcome: "removed" | "deferred" | "retained" | "released" = "deferred";
		// A release of a retention that did not record how far it went, over what is left of its bundle, is told.
		let overRemains = false;
		// Without the bot histories, a removal that has not begun waits, named, before anything of the bundle is written.
		const awaitsHistory = (): boolean => {
			if (!historyUnknown || reservation.phase === "removing") return false;
			report(interfaceText().sessions.retention.removalAwaitsBotHistory(label));
			return true;
		};
		try {
			if (!existsSync(bundleDir)) {
				// Gone before this reservation: a removal that may have begun finishes with the side files; a bundle gone
				// any other way (moved to another home, or deleted), or a held session's, is released and nothing else is
				// touched.
				if (held && reservation.phase !== "removing") outcome = "released";
				else if (reservation.phase !== "reserved") {
					removeSessionSideFiles(sessionSideFiles(home, parentSessionId));
					outcome = "removed";
				}
				return;
			}
			overRemains = reservation.phase === "unrecorded";
			if (held) {
				// The session is the open one's: its tombstone goes, unless its removal began meanwhile (the session's next
				// open releases that one) or its bundle does not read (evidence that does not read throws: a deferral, which
				// keeps an `unrecorded` tombstone).
				if (reservation.phase === "removing") return;
				receiptsAwaitDelivery(home, parentSessionId, reservation);
				if (
					bundleOwesMailboxWork(home, parentSessionId, bundleDir) &&
					openObligationsVerdict(agentDir, home, parentSessionId, bundleDir, now) === "unreadable"
				)
					return;
				outcome = "released";
				return;
			}
			// A removal this build marked begun passed every gate before it began, and what is left of its bundle proves
			// nothing; a tombstone an earlier build left (`unrecorded`) goes through the gates again.
			if (reservation.phase !== "removing") {
				// Evidence that does not read throws: a deferral.
				if (receiptsAwaitDelivery(home, parentSessionId, reservation)) {
					// Only the open session delivers them: the tombstone goes, whatever its phase, so the session opens.
					outcome = "released";
					report(`session bundle ${label} retained: worker receipts await parent delivery`);
					return;
				}
				if (bundleOwesMailboxWork(home, parentSessionId, bundleDir)) {
					// Obligations older than the retention age can never be answered: settle them, then re-check.
					// Only when every one of them expires: a bundle that keeps a younger or project-bound obligation is
					// the open session's to answer, so it is refused untouched and its tombstone goes (settling part of
					// it would only postpone its removal); one that does not read keeps the tombstone's barrier.
					const verdict = openObligationsVerdict(agentDir, home, parentSessionId, bundleDir, now);
					if (verdict !== "expires") {
						if (verdict !== "unreadable") outcome = "released";
						return;
					}
					if (awaitsHistory()) return;
					// Settling writes the mailboxes: from here a refusal keeps the tombstone, so the next run resumes
					// the expiry past the age those writes refreshed.
					outcome = "retained";
					const settled = settleExpiredObligations(
						agentDir,
						home,
						parentSessionId,
						label,
						bundleDir,
						now,
						report,
						reservation,
					);
					result.expiredObligations += settled;
					if (settled > 0) run.obligationLedgers.add(obligationLedgerFile(home));
					if (settled === 0 || bundleOwesMailboxWork(home, parentSessionId, bundleDir)) return;
				}
			}
			if (awaitsHistory()) return;
			outcome = "retained";
			// Decided before the removal is marked begun, removed after it.
			const sideFiles = sessionSideFiles(home, parentSessionId);
			markSessionBundleRemoving(home, reservation);
			// The side files name only what the bundle held: they go first, so a removal left partial strands none.
			removeSessionSideFiles(sideFiles);
			await rm(bundleDir, { recursive: true, force: true });
			if (existsSync(bundleDir)) {
				report(`session bundle ${label} was only partly removed; it stays reserved for the next startup`);
				return;
			}
			outcome = "removed";
		} finally {
			settleSessionBundleDeletion(home, reservation, outcome);
			if (outcome === "released" && overRemains) {
				const words = interfaceText().sessions.retention;
				report(words.interruptedRetentionReleased(label, words.releasedByStartup));
			}
		}
		result.removed++;
		result.removedBytes += walk.bytes;
	} catch (error) {
		report(`session bundle ${label} retained: ${describe(error)}`);
	}
}

/**
 * Whether worker usage or accepted-worker receipts of the session wait for parent delivery, read under its retention
 * reservation; a projection that does not read throws.
 */
function receiptsAwaitDelivery(
	home: OrchestrationHome,
	parentSessionId: string,
	reservation: SessionBundleDeletionReservation,
): boolean {
	return withSessionBundleRetention(home, parentSessionId, reservation, () => {
		const state = readTaskRuntimeProjection(
			new OrchestrationEventStore({ orchestrationHome: home, sessionId: parentSessionId }),
		);
		return Object.values(state.attempts).some(
			(attempt) =>
				Object.keys(attempt.usageReceipts ?? {}).length > 0 || workerReceiptPublicationPending(state, attempt),
		);
	});
}

/** The bundle directory names of a home's `sessions/`, sorted; none when it has no `sessions/`. */
async function bundleNames(home: OrchestrationHome): Promise<string[]> {
	const root = orchestrationSessionsDir(home);
	if (!existsSync(root)) return [];
	return (await readdir(root, { withFileTypes: true }))
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.sort();
}
/** Lists one home's bundles and retentions in flight; why it could not, told to the owner, when it could not. */
async function homeSweep(
	base: Omit<HomeSweep, "names" | "inFlight" | "unreadable">,
	failureText: string,
	reportHome: (message: string) => void,
): Promise<HomeSweep | undefined> {
	try {
		const names = await bundleNames(base.home);
		const inFlight = await sessionBundleRetentionsInFlight(base.home);
		return { ...base, names, inFlight: inFlight.sessionIds, unreadable: inFlight.unreadable };
	} catch (error) {
		harnessLog.warn("sessions", "a home's session bundles or deletion records do not list", {
			home: base.logName,
			detail: describe(error),
		});
		reportHome(failureText);
		return undefined;
	}
}

/**
 * Inspects the retentions in flight of every home (`inspectSessionBundleRetention`), at most
 * {@link MAX_RESUMES_PER_RUN} per run from a window the clock rotates across the homes: a `reserved` one no live remover
 * holds is released there (its bundle whole), one whose removal began (`removing`) is finished now, within the run's
 * budget, and the `unrecorded` ones are returned to go through the gates. Each bundle inspected is added to `seen`.
 */
async function resumeRetentionsInFlight(
	run: SweepRun,
	homes: readonly HomeSweep[],
	seen: Set<string>,
): Promise<{ sweep: HomeSweep; name: string }[]> {
	const entries = homes.flatMap((sweep) => sweep.inFlight.map((sessionId) => ({ sweep, sessionId })));
	const start = entries.length > 0 ? Math.floor(run.now / 1000) % entries.length : 0;
	const window = [...entries.slice(start), ...entries.slice(0, start)].slice(0, MAX_RESUMES_PER_RUN);
	const gated: { sweep: HomeSweep; name: string }[] = [];
	for (const { sweep, sessionId } of window) {
		let state: ReturnType<typeof inspectSessionBundleRetention>;
		try {
			state = inspectSessionBundleRetention(sweep.home, sessionId);
		} catch (error) {
			sweep.unreadable++;
			harnessLog.warn("sessions", "a session bundle's deletion record does not read", {
				home: sweep.logName,
				session: sessionId,
				detail: describe(error),
			});
			continue;
		}
		if (state.kind !== "pending") continue;
		const name = basename(orchestrationSessionDir(sweep.home, sessionId));
		seen.add(bundleKey(sweep, name));
		if (state.phase === "unrecorded") gated.push({ sweep, name });
		else if (!budgetSpent(run.result) && run.result.inspected < MAX_BUNDLES_INSPECTED)
			await sweepBundle(run, sweep, name, state.phase);
	}
	return gated;
}

function bundleKey(sweep: HomeSweep, name: string): string {
	return join(sweep.home.root, name);
}

/** The evidence line of a run that settled expired obligations, its ledgers counted rather than cut. */
function expiredObligationsLine(agentDir: string, settled: number, ledgers: ReadonlySet<string>): string {
	const head = `settled ${settled} expired mailbox obligation(s) in old session bundles as ${SESSION_BUNDLE_OBLIGATION_EXPIRED_REASON}; evidence: `;
	const paths = [...ledgers].map((ledger) => `<agentDir>/${relative(agentDir, ledger).split(sep).join(posix.sep)}`);
	const more = (count: number): string => (count > 0 ? ` (+${count} more)` : "");
	let shown = 0;
	while (
		shown < paths.length &&
		`${head}${paths.slice(0, shown + 1).join(", ")}${more(paths.length - shown - 1)}`.length <= MAX_DIAGNOSTIC_CHARS
	)
		shown++;
	return `${head}${paths.slice(0, shown).join(", ")}${more(paths.length - shown)}`;
}

/**
 * Remove expired session bundles through the existing reservation protocol, in every orchestration home: the owner's
 * first, then each bot home's, from one read of `bots/`. Event-driven: call it once from the main session's startup,
 * never from a worker and never on a timer.
 */
export async function sweepSessionBundles(
	options: SessionBundleRetentionOptions,
): Promise<SessionBundleRetentionResult> {
	const { agentDir, currentSessionId } = options;
	const owner = ownerOrchestrationHome(agentDir);
	const now = options.now ?? Date.now();
	const result: SessionBundleRetentionResult = {
		inspected: 0,
		removed: 0,
		removedBytes: 0,
		expiredObligations: 0,
		settledRoutineResults: 0,
		retiredRoutines: 0,
		uncertainRoutineRuns: 0,
		diagnostics: [],
	};
	const obligationLedgers = new Set<string>();
	const report = (message: string): void => {
		if (result.diagnostics.length < MAX_DIAGNOSTICS) result.diagnostics.push(message.slice(0, MAX_DIAGNOSTIC_CHARS));
	};
	// Warnings about single homes take at most MAX_HOME_DIAGNOSTICS slots; the rest are counted.
	let homeWarnings = 0;
	let omittedHomeWarnings = 0;
	const reportHome = (message: string): void => {
		if (homeWarnings++ < MAX_HOME_DIAGNOSTICS) report(message);
		else {
			omittedHomeWarnings++;
			harnessLog.warn("sessions", message);
		}
	};
	try {
		// The bot homes are read once per run: their sessions, which homes exist and which session files they hold.
		const bots = readBotSessionHolds(agentDir);
		const index = indexSessionFiles(agentDir, bots, reportHome);
		const transcripts = index.files;
		const matrix = await protectedSessionIds(agentDir, currentSessionId, botHeldSessionIds(bots, transcripts));
		// A home whose holds cannot be told may hold any session of its home, file or none; so may a home not listed.
		const heldSessionDirs = new Set([
			...bots.homes.flatMap((hold) =>
				hold.kind === "undetermined" || index.unlistedBots.has(hold) ? [resolve(hold.home.sessionsDir)] : [],
			),
			...bots.unresolvedHomes.map(({ home }) => resolve(home.sessionsDir)),
		]);
		if (index.ownerListed) {
			const settled = settleRoutinesOfGoneSessions(agentDir, matrix, transcripts, heldSessionDirs, now);
			result.uncertainRoutineRuns = settled.uncertainRuns;
			result.settledRoutineResults = settled.settledResults;
			result.retiredRoutines = settled.retiredRoutines;
		}
		const text = interfaceText();
		const homes: HomeSweep[] = [];
		const ownerSweep = await homeSweep(
			{
				home: owner,
				rootSessions: true,
				labelOf: (name) => name,
				resumeOnly: !index.ownerListed,
				unfiledHeld: index.someBotUnlisted,
				unreadableText: (count) => text.sessions.retention.ownerDeletionRecordsUnreadable(count),
				logName: owner.root,
			},
			text.sessions.retention.ownerStateUnreadable,
			reportHome,
		);
		if (ownerSweep) homes.push(ownerSweep);
		for (const hold of bots.homes) {
			const botName = boundedName(hold.displayName);
			const sweep = await homeSweep(
				{
					home: hold.home.orchestrationHome,
					rootSessions: false,
					labelOf: (name) => `${BOTS_DIR_NAME}/${hold.name}/${name}`,
					resumeOnly: hold.kind === "undetermined" || index.unlistedBots.has(hold),
					unfiledHeld: false,
					unreadableText: (count) => text.botTeam.botDeletionRecordsUnreadable(botName, count),
					logName: hold.home.dir,
				},
				text.botTeam.botHomeRetentionFailed(botName),
				reportHome,
			);
			if (!sweep || (sweep.names.length === 0 && sweep.inFlight.length === 0 && sweep.unreadable === 0)) continue;
			if (hold.kind === "undetermined") reportHome(botHomeUnknownText(botName, hold.unknown));
			homes.push(sweep);
		}
		const history = historyReferencedSessionIds(bots);
		const run: SweepRun = {
			agentDir,
			now,
			processHeld: matrix.processHeld,
			protectedIds: matrix.ids,
			historyHeld: history.sessionIds,
			historyUnknown: history.unreadable.length > 0 || history.unresolvedHomes,
			transcripts,
			result,
			obligationLedgers,
			report,
		};
		// First the retentions earlier runs left in flight, ahead of the rest: until a removal that began settles, its
		// session cannot open. Releases and removals that began need no bot history; the others go through the gates below,
		// where a removal in the owner's home waits for the histories (`HomeSweep.rootSessions`).
		const seen = new Set<string>();
		const gated = await resumeRetentionsInFlight(run, homes, seen);
		for (const sweep of homes) if (sweep.unreadable > 0) reportHome(sweep.unreadableText(sweep.unreadable));
		// A home whose link does not resolve was told when the session files were listed (`botHomeLinkUnresolved`).
		for (const agentId of history.unreadable)
			reportHome(text.botTeam.botHistoryIndexUnreadable(boundedName(agentId)));
		for (const { sweep, name } of gated) {
			if (result.inspected >= MAX_BUNDLES_INSPECTED || budgetSpent(result)) break;
			await sweepBundle(run, sweep, name, "unrecorded");
		}
		// Then every home's bundles as one list, in home order (the owner's first). Remembering nothing: the window starts
		// at a different bundle each startup (the clock picks it), so bundles that stay refused at the head of the order
		// cannot starve the ones behind them, in any home. A retention an earlier build left without an index entry is
		// resumed here, by its tombstone.
		const bundles = homes.flatMap((sweep) => sweep.names.map((name) => ({ sweep, name })));
		const start = bundles.length > 0 ? Math.floor(now / 1000) % bundles.length : 0;
		for (const { sweep, name } of [...bundles.slice(start), ...bundles.slice(0, start)]) {
			if (result.inspected >= MAX_BUNDLES_INSPECTED || budgetSpent(result)) break;
			if (seen.has(bundleKey(sweep, name))) continue;
			await sweepBundle(run, sweep, name);
		}
	} catch (error) {
		report(`session bundle retention failed: ${describe(error)}`);
	} finally {
		const leading =
			result.expiredObligations > 0
				? [expiredObligationsLine(agentDir, result.expiredObligations, obligationLedgers)]
				: [];
		const trailing =
			omittedHomeWarnings > 0 ? [interfaceText().sessions.retention.homeWarningsOmitted(omittedHomeWarnings)] : [];
		result.diagnostics = [
			...leading,
			...result.diagnostics.slice(0, MAX_DIAGNOSTICS - leading.length - trailing.length),
			...trailing,
		];
	}
	return result;
}
