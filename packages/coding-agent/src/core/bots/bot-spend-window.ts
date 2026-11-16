/**
 * A bot's spend windows: one per outside input that woke its session (the owner's message, a message its inbox took, a
 * watch's wake, a host event), holding what the session spent itself (its foreground: its priced answers and the
 * compactions its turns ran) and naming the workers it started while serving that input. The bot's turns and its workers'
 * runs share the window's dollar bounds, so a request's whole spend is held to one bound however many handoffs it takes:
 * a ceiling on all spend counts all of it, a metered-only ceiling the part of it made on metered models.
 *
 * Which window an entry of the transcript belongs to is read from the transcript itself, walking back from the entry to
 * the input that opened its window. A turn a worker's handoff opened belongs to the window of the attempt that woke it,
 * and an attempt belongs to the window of the transcript leaf it was dispatched from (its receipt origin, which its
 * retries, its verifier and the children it starts carry; a plan step's is the leaf of the plan call that stated it). A
 * plan update belongs to the window of the input its plan serves (`details.served`, the leaf its steps' origins name). An entry that is no outside input (a continuation, a host
 * steer, a notice) belongs to the window before it; the transcript's first entry opens one when nothing later did.
 *
 * Kept in the bot's spend ledger (`BotSpendLedger`, `bots/<id>/spend.json`): a reopened session resumes a window's
 * foreground spend. A window is dropped only once no worker serving it can still run (every attempt it names has ended,
 * or the delegation ledger shows none of them a week after the window last changed), the oldest first, and only past
 * the newest 64; the window the transcript is in now and every window a run bound handed out still serves are never
 * dropped, so a turn or a worker is never counted against a window opened again at nothing. A worker's spend is never copied: it is read from the delegation ledger's per-attempt usage each time.
 */

import type { SessionEntry } from "../../kernel/session/session-entries.ts";
import type { SessionManager } from "../../kernel/session/session-manager.ts";
import type { AgentMessage } from "../../kernel/types.ts";
import { ACTIVE_ATTEMPT_STATUSES } from "../delegation/delegation-spend.ts";
import type { RunCostBound } from "../delegation/parent-execution-context.ts";
import { projectAttemptUsage } from "../orchestration/attempt-usage.ts";
import type { AttemptRuntimeState, TaskRuntimeProjection } from "../orchestration/task-runtime-state.ts";
import { entryTurnOrigin, isOutsideInputKind, turnOriginOf } from "../turn-origin.ts";
import { isPlainRecord } from "../util/value-guards.ts";
import type { BotSpendCeiling } from "./bot-session-turns.ts";
import type { BotSpendLedger, SpendWindowRecord } from "./bot-spend-ledger.ts";

/** Windows kept however old: past this many, the oldest no worker can still serve are dropped. */
const MAX_WINDOWS_KEPT = 64;

/**
 * How long after it last changed a window is kept for an attempt the delegation ledger does not show (an attempt of the
 * bot's earlier session file, whose ledger this session does not read, or one its projection no longer holds; a reopened
 * session's projection is read back as the session is built, `BackgroundLaneController.signalWorkerReceiptDelivery`):
 * such an attempt may still run, so its window stays this long.
 */
const UNSEEN_ATTEMPT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** Entries whose window is remembered, the most recent; past it the memory starts over (a walk reads the transcript again). */
const MAX_ENTRIES_REMEMBERED = 4096;

/** The window of an entry, and whether it is final: unsettled when the walk passed a handoff whose attempts it could not place. */
interface EntryWindow {
	readonly windowId: string;
	readonly settled: boolean;
}

/** How many attempts the projection holds: an unsettled answer is asked again once it holds more. */
function attemptCount(snapshot: TaskRuntimeProjection | undefined): number {
	return snapshot ? Object.keys(snapshot.attempts).length : -1;
}

/** The details of a custom message an entry holds; undefined for any other entry. */
function entryDetails(entry: SessionEntry): unknown {
	return entry.type === "custom_message"
		? entry.details
		: entry.type === "message" && entry.message.role === "custom"
			? entry.message.details
			: undefined;
}

/** The attempt ids a worker result delivers (`records[].attemptId` of its details, a parent input's unwrapped). */
function deliveredAttemptIds(raw: unknown): string[] {
	const details = isPlainRecord(raw) && "parentInput" in raw ? raw.originalDetails : raw;
	if (!isPlainRecord(details) || !Array.isArray(details.records)) return [];
	return details.records.flatMap((record) =>
		isPlainRecord(record) && typeof record.attemptId === "string" ? [record.attemptId] : [],
	);
}

/** The input a worker result serves when it delivers no attempt: a plan update's `details.served`, a parent input's unwrapped. */
function servedInput(raw: unknown): { readonly sessionId: string; readonly leafId: string } | undefined {
	const details = isPlainRecord(raw) && "parentInput" in raw ? raw.originalDetails : raw;
	const served = isPlainRecord(details) ? details.served : undefined;
	if (!isPlainRecord(served) || typeof served.sessionId !== "string" || typeof served.leafId !== "string")
		return undefined;
	return { sessionId: served.sessionId, leafId: served.leafId };
}

/** What the windows read of the bot's session. */
export interface BotSpendWindowPorts {
	/** The delegation ledger's projection of the session's workers; undefined before the session started any. */
	snapshot(): TaskRuntimeProjection | undefined;
	/** Whether an attempt's spend is metered (`RequestCostBounds.isMeteredAttempt`, as its run budget reads it). */
	attemptMetered(attempt: AttemptRuntimeState): boolean;
	now(): number;
}

/** A window's spend: all of it, and the part of it made on metered models. */
export interface WindowSpend {
	readonly usd: number;
	readonly meteredUsd: number;
}

/** The bot's spend windows over its session's transcript (see the module comment). */
export class BotSpendWindows {
	/** The windows kept, the ledger's own. */
	private readonly windows: Map<string, SpendWindowRecord>;
	/**
	 * The window an attempt serves (`null`: none of this session's, as its receipt origin names none here), once that is
	 * final: an attempt whose origin leaf the transcript does not hold, or whose window rests on a handoff not yet placed,
	 * is asked again.
	 */
	private readonly attemptWindows = new Map<string, string | null>();
	/** The window id each walked entry belongs to, where the walk settled it. */
	private readonly entryWindows = new Map<string, string>();
	/**
	 * The attempts handed a run bound in this process (`runCostBound`), with the window each bound serves: kept until the
	 * projection shows the attempt ended, and their windows never dropped meanwhile.
	 */
	private readonly bounded = new Map<string, string>();
	/** An unsettled walk's window for each entry it passed, with the projection's attempt count it was read at. */
	private readonly unsettledWindows = new Map<string, { readonly windowId: string; readonly attempts: number }>();
	private readonly ledger: BotSpendLedger;
	private readonly transcript: Pick<SessionManager, "getEntry" | "getLeafId" | "getSessionId">;
	private readonly ports: BotSpendWindowPorts;

	constructor(
		ledger: BotSpendLedger,
		transcript: Pick<SessionManager, "getEntry" | "getLeafId" | "getSessionId">,
		ports: BotSpendWindowPorts,
	) {
		this.ledger = ledger;
		this.windows = ledger.windows;
		this.transcript = transcript;
		this.ports = ports;
		for (const window of this.windows.values())
			for (const attemptId of window.attemptIds) this.attemptWindows.set(attemptId, window.id);
	}

	/**
	 * Counts `addedUsd` the session just spent (on a metered model when `metered`) to the window its transcript is in now
	 * and returns that window's spend: its foreground and every worker serving it. Undefined while the transcript holds
	 * nothing yet.
	 */
	count(addedUsd: number, metered: boolean): WindowSpend | undefined {
		const leafId = this.transcript.getLeafId();
		const snapshot = this.ports.snapshot();
		const windowId = leafId === null ? undefined : this.windowOfEntry(leafId, snapshot)?.windowId;
		if (windowId === undefined) return undefined;
		const window = this.windowFor(windowId);
		if (addedUsd > 0) {
			window.foregroundUsd += addedUsd;
			if (metered) window.meteredForegroundUsd += addedUsd;
			window.updatedAt = this.ports.now();
			this.ledger.touch();
		}
		const workers = this.workerSpend(window.id, snapshot);
		this.flush(snapshot);
		return {
			usd: window.foregroundUsd + workers.usd,
			meteredUsd: window.meteredForegroundUsd + workers.meteredUsd,
		};
	}

	/**
	 * The metered spend of the window the transcript entry `entryId` belongs to (the outside input that opened it, as a
	 * mail): the session's own metered spend there and its metered workers'. Zero when it belongs to no window kept.
	 */
	meteredSpendOfEntry(entryId: string): number {
		const snapshot = this.ports.snapshot();
		const windowId = this.windowOfEntry(entryId, snapshot)?.windowId;
		if (windowId === undefined) return 0;
		return (this.windows.get(windowId)?.meteredForegroundUsd ?? 0) + this.workerSpend(windowId, snapshot).meteredUsd;
	}

	/**
	 * The bounds of one run of the window `attempt` serves, which the window's workers share as one run (`runId`, whose
	 * spend the run budgets count from the workers' own usage): the lowest of `ceilings` on all spend less the session's
	 * own spend in that window (`maxCostUsd`), and the lowest of the metered-only ones less the session's own metered spend
	 * there (`maxMeteredCostUsd`, which holds the run's metered attempts only). A remainder at or below zero is zero: the
	 * run's next request is refused as a run whose bound is spent. The attempt, starting now, is counted to its window
	 * first, whatever bounds apply (a window not kept opens again, and stays among the newest while it serves); the bound
	 * includes every attempt serving the same window. Undefined when it serves no window of this session or no ceiling
	 * applies.
	 */
	runCostBound(
		attempt: AttemptRuntimeState,
		snapshot: TaskRuntimeProjection,
		ceilings: readonly BotSpendCeiling[],
	): RunCostBound | undefined {
		const windowId = this.windowOfAttempt(attempt, snapshot);
		const window = windowId === undefined ? undefined : this.windowFor(windowId);
		if (window) {
			this.serve(window, attempt.attemptId);
			this.bounded.set(attempt.attemptId, window.id);
		}
		this.flush(snapshot);
		if (!window || ceilings.length === 0) return undefined;
		const remainder = (meteredOnly: boolean, spentUsd: number): number | undefined => {
			const usd = ceilings.filter((ceiling) => ceiling.meteredOnly === meteredOnly).map((ceiling) => ceiling.usd);
			return usd.length === 0 ? undefined : Math.max(0, Math.min(...usd) - spentUsd);
		};
		const maxCostUsd = remainder(false, window.foregroundUsd);
		const maxMeteredCostUsd = remainder(true, window.meteredForegroundUsd);
		return {
			runId: window.id,
			...(maxCostUsd !== undefined ? { maxCostUsd } : {}),
			...(maxMeteredCostUsd !== undefined ? { maxMeteredCostUsd } : {}),
			includes: (candidate) => this.windowOfAttempt(candidate, snapshot) === window.id,
			// A subscription model with no published price gets no dollar run bound (its usage windows hold it); a metered one
			// is priced against the bound, which refuses it, as the root's workers under a metered ceiling are.
			unpriced: "unbounded",
		};
	}

	/**
	 * The spend of the window a run opening with `opening` serves, read before the transcript holds those messages: the
	 * newest of them that places one decides (an outside input opens a fresh window, which holds nothing yet; a worker's
	 * handoff belongs to the window of the attempts it delivers, a plan update to that of the input it serves); when none does (a continuation, a host steer, a handoff
	 * whose attempts serve no window here), the window the transcript is in now. Nothing is counted and no window opened.
	 * Undefined while nothing places one (an empty transcript).
	 */
	openingSpend(opening: readonly AgentMessage[]): WindowSpend | undefined {
		const snapshot = this.ports.snapshot();
		let windowId: string | undefined;
		for (let index = opening.length - 1; index >= 0 && windowId === undefined; index--) {
			const message = opening[index];
			const kind = turnOriginOf(message)?.k;
			if (kind !== undefined && isOutsideInputKind(kind)) return { usd: 0, meteredUsd: 0 };
			if (kind === "worker-result" && message.role === "custom")
				windowId = (
					this.windowOfDelivered(deliveredAttemptIds(message.details), snapshot, 0) ??
					this.windowOfServed(servedInput(message.details), snapshot, 0)
				)?.windowId;
		}
		const leafId = this.transcript.getLeafId();
		windowId ??= leafId === null ? undefined : this.windowOfEntry(leafId, snapshot)?.windowId;
		if (windowId === undefined) return undefined;
		const kept = this.windows.get(windowId);
		const workers = this.workerSpend(windowId, snapshot);
		return {
			usd: (kept?.foregroundUsd ?? 0) + workers.usd,
			meteredUsd: (kept?.meteredForegroundUsd ?? 0) + workers.meteredUsd,
		};
	}

	/** The spend of the workers serving the window `windowId`, as the delegation ledger counts each attempt's usage. */
	private workerSpend(windowId: string, snapshot: TaskRuntimeProjection | undefined): WindowSpend {
		let usd = 0;
		let meteredUsd = 0;
		for (const attempt of Object.values(snapshot?.attempts ?? {})) {
			if (!snapshot || this.windowOfAttempt(attempt, snapshot) !== windowId) continue;
			// A managed lane runs out of process and is metered by no generation: its cost is the one its terminal result reports.
			const costUsd =
				projectAttemptUsage(attempt, snapshot.checkpoints)?.costUsd ?? attempt.result?.usage.costUsd ?? 0;
			usd += costUsd;
			if (this.ports.attemptMetered(attempt)) meteredUsd += costUsd;
		}
		return { usd, meteredUsd };
	}

	/**
	 * The window an attempt serves: the one its receipt origin's leaf belongs to, when that leaf is this session's. Finding
	 * it opens no window: an attempt read from the ledger's history whose window was dropped leaves it dropped (only an
	 * attempt starting now opens its window, `runCostBound`); a kept window records the attempt. Only a final answer is
	 * remembered (`attemptWindows`).
	 */
	private windowOfAttempt(
		attempt: AttemptRuntimeState,
		snapshot: TaskRuntimeProjection | undefined,
	): string | undefined {
		const known = this.attemptWindows.get(attempt.attemptId);
		if (known !== undefined) return known ?? undefined;
		const origin = attempt.dispatch.receiptOrigin;
		if (!origin || origin.sessionId !== this.transcript.getSessionId()) {
			this.attemptWindows.set(attempt.attemptId, null);
			return undefined;
		}
		const found = this.windowOfEntry(origin.leafId, snapshot);
		if (!found) return undefined;
		if (found.settled) this.attemptWindows.set(attempt.attemptId, found.windowId);
		const kept = this.windows.get(found.windowId);
		if (kept && !kept.attemptIds.includes(attempt.attemptId)) {
			kept.attemptIds.push(attempt.attemptId);
			this.ledger.touch();
		}
		return found.windowId;
	}

	/** An attempt starts serving `window`: it is recorded there, and the window is as recent as the attempt. */
	private serve(window: SpendWindowRecord, attemptId: string): void {
		if (!window.attemptIds.includes(attemptId)) window.attemptIds.push(attemptId);
		window.updatedAt = this.ports.now();
		this.ledger.touch();
	}

	/**
	 * The window an entry belongs to: walking back from it to the input that opened its window. A worker's handoff
	 * belongs to the window of the first attempt it delivers that serves one (a plan update, which delivers none, to the
	 * window of the input it serves); a handoff whose attempts serve none, and
	 * every entry that is no outside input, belong to the window before it. The earliest entry the walk reaches (the
	 * transcript's first) opens the window nothing later opened. Undefined only for an entry the transcript does not hold.
	 * A settled answer is remembered for every entry the walk passed; an unsettled one (a handoff whose attempts the
	 * projection does not hold yet was passed) only until the projection holds more attempts.
	 */
	private windowOfEntry(
		entryId: string,
		snapshot: TaskRuntimeProjection | undefined,
		depth = 0,
	): EntryWindow | undefined {
		const attempts = attemptCount(snapshot);
		const walked = new Set<string>();
		let settled = true;
		let windowId: string | undefined;
		let id: string | null = entryId;
		let last: SessionEntry | undefined;
		while (id !== null && windowId === undefined) {
			const remembered = this.entryWindows.get(id);
			if (remembered !== undefined) {
				windowId = remembered;
				break;
			}
			const unsettled = this.unsettledWindows.get(id);
			if (unsettled?.attempts === attempts) {
				windowId = unsettled.windowId;
				settled = false;
				break;
			}
			const entry = this.transcript.getEntry(id);
			if (!entry || walked.has(id)) break;
			walked.add(id);
			last = entry;
			const kind = entryTurnOrigin(entry)?.k;
			if (kind !== undefined && isOutsideInputKind(kind)) windowId = this.windowIdOf(entry.id);
			else if (kind === "worker-result" && depth < 8) {
				const details = entryDetails(entry);
				const attemptIds = deliveredAttemptIds(details);
				const delivered =
					this.windowOfDelivered(attemptIds, snapshot, depth) ??
					this.windowOfServed(servedInput(details), snapshot, depth);
				windowId = delivered?.windowId;
				// A window found is as settled as its answer; none found is unsettled while attempts it names are not placed yet.
				if (delivered ? !delivered.settled : attemptIds.length > 0) settled = false;
			}
			id = entry.parentId;
		}
		if (windowId === undefined && last) windowId = this.windowIdOf(last.id);
		if (windowId === undefined) return undefined;
		this.remember(walked, windowId, settled ? undefined : attempts);
		return { windowId, settled };
	}

	/** The window of the first delivered attempt that serves one of this session's. */
	private windowOfDelivered(
		attemptIds: readonly string[],
		snapshot: TaskRuntimeProjection | undefined,
		depth: number,
	): EntryWindow | undefined {
		for (const attemptId of attemptIds) {
			const known = this.attemptWindows.get(attemptId);
			if (known === null) continue;
			if (known !== undefined) return { windowId: known, settled: true };
			const attempt = snapshot?.attempts[attemptId];
			const origin = attempt?.dispatch.receiptOrigin;
			if (!origin || origin.sessionId !== this.transcript.getSessionId()) continue;
			const found = this.windowOfEntry(origin.leafId, snapshot, depth + 1);
			if (found !== undefined) return found;
		}
		return undefined;
	}

	/** The window of the input a plan update serves, when that input is in this session's transcript. */
	private windowOfServed(
		served: { readonly sessionId: string; readonly leafId: string } | undefined,
		snapshot: TaskRuntimeProjection | undefined,
		depth: number,
	): EntryWindow | undefined {
		if (!served || served.sessionId !== this.transcript.getSessionId()) return undefined;
		return this.windowOfEntry(served.leafId, snapshot, depth + 1);
	}

	/** Remembers `windowId` for each walked entry: settled, or unsettled at the projection's `attempts` count. */
	private remember(entryIds: ReadonlySet<string>, windowId: string, attempts: number | undefined): void {
		const memory = attempts === undefined ? this.entryWindows : this.unsettledWindows;
		if (memory.size + entryIds.size > MAX_ENTRIES_REMEMBERED) memory.clear();
		for (const entryId of entryIds) {
			if (attempts === undefined) this.entryWindows.set(entryId, windowId);
			else this.unsettledWindows.set(entryId, { windowId, attempts });
		}
	}

	private windowIdOf(entryId: string): string {
		return `${this.transcript.getSessionId()}/${entryId}`;
	}

	/** The kept window `windowId`, opened now when it is not kept (its opening entry read from the transcript). */
	private windowFor(windowId: string): SpendWindowRecord {
		const kept = this.windows.get(windowId);
		if (kept) return kept;
		const entryId = windowId.slice(this.transcript.getSessionId().length + 1);
		const entry = this.transcript.getEntry(entryId);
		const ownerInputId = entry?.type === "message" ? entry.ownerInputId : undefined;
		const window: SpendWindowRecord = {
			id: windowId,
			input: ownerInputId ?? entryId,
			kind: (entry && entryTurnOrigin(entry)?.k) ?? "transcript",
			foregroundUsd: 0,
			meteredForegroundUsd: 0,
			attemptIds: [],
			updatedAt: this.ports.now(),
		};
		this.windows.set(windowId, window);
		return window;
	}

	/**
	 * Writes the changes with the ledger. Past the kept many, the oldest windows no worker can still serve are dropped
	 * until the kept many remain or none such is left: a window a live worker serves is never dropped, nor the window the
	 * transcript is in now (the one the session's turn counts to) nor one a run bound handed out here still serves, so
	 * a window being counted or bounded is never dropped and opened again at nothing, whatever the others hold.
	 */
	private flush(snapshot: TaskRuntimeProjection | undefined): void {
		const held = this.heldWindows(snapshot);
		const excess = this.windows.size - MAX_WINDOWS_KEPT;
		if (excess > 0) {
			const now = this.ports.now();
			const done = [...this.windows.values()]
				.filter((window) => !held.has(window.id) && !this.mayStillServe(window, snapshot, now))
				.sort((a, b) => a.updatedAt - b.updatedAt)
				.slice(0, excess);
			for (const window of done) this.windows.delete(window.id);
			if (done.length > 0) this.ledger.touch();
		}
		this.ledger.flush();
	}

	/**
	 * The windows dropping must leave whatever the workers hold: the one the transcript's leaf is in, and those the run
	 * bounds handed out serve while their attempts have not ended (a bound whose attempt the projection shows ended is
	 * forgotten).
	 */
	private heldWindows(snapshot: TaskRuntimeProjection | undefined): Set<string> {
		const held = new Set<string>();
		const leafId = this.transcript.getLeafId();
		const leafWindow = leafId === null ? undefined : this.windowOfEntry(leafId, snapshot)?.windowId;
		if (leafWindow !== undefined) held.add(leafWindow);
		for (const [attemptId, windowId] of this.bounded) {
			const attempt = snapshot?.attempts[attemptId];
			if (attempt && !ACTIVE_ATTEMPT_STATUSES.has(attempt.status)) this.bounded.delete(attemptId);
			else held.add(windowId);
		}
		return held;
	}

	/**
	 * Whether a worker serving `window` may still run: one of its attempts has not ended, or the projection does not show
	 * it (`UNSEEN_ATTEMPT_RETENTION_MS`) and the window changed within the unseen retention.
	 */
	private mayStillServe(window: SpendWindowRecord, snapshot: TaskRuntimeProjection | undefined, now: number): boolean {
		return window.attemptIds.some((attemptId) => {
			const attempt = snapshot?.attempts[attemptId];
			return attempt
				? ACTIVE_ATTEMPT_STATUSES.has(attempt.status)
				: now - window.updatedAt < UNSEEN_ATTEMPT_RETENTION_MS;
		});
	}
}
