/**
 * A bot's spend windows: one per outside input that woke its session (the owner's message, a message its inbox took, a
 * watch's wake, a host event), holding what the session spent itself (its foreground: its priced answers and the
 * compactions its turns ran) and naming the workers it started while serving that input. The bot's turns and its workers'
 * runs share the window's dollar bound, so a request's whole spend is held to one bound however many handoffs it takes.
 *
 * Which window an entry of the transcript belongs to is read from the transcript itself, walking back from the entry to
 * the input that opened its window. A turn a worker's handoff opened belongs to the window of the attempt that woke it,
 * and an attempt belongs to the window of the transcript leaf it was dispatched from (its receipt origin, which its
 * retries, its verifier and the children it starts carry). An entry that is no outside input (a continuation, a host
 * steer, a notice) belongs to the window before it; the transcript's first entry opens one when nothing later did.
 *
 * Kept beside the bot's transcript in `bots/<id>/spend-windows.json`, the newest windows only, written atomically and
 * private (0600): a reopened session resumes a window's foreground spend. A worker's spend is never copied: it is read
 * from the delegation ledger's per-attempt usage each time. A record that does not read is set aside (`.unreadable`) and
 * the owner told; the windows then start empty.
 */

import { existsSync, readFileSync, renameSync } from "node:fs";
import type { SessionEntry } from "../../kernel/session/session-entries.ts";
import type { SessionManager } from "../../kernel/session/session-manager.ts";
import type { TurnOriginKind } from "../../kernel/turn-origin-stamp.ts";
import { projectAttemptUsage } from "../orchestration/attempt-usage.ts";
import type { AttemptRuntimeState, TaskRuntimeProjection } from "../orchestration/task-runtime-state.ts";
import { entryTurnOrigin } from "../turn-origin.ts";
import { writeFileAtomicSync } from "../util/atomic-file.ts";
import { isPlainRecord } from "../util/value-guards.ts";

/** Windows kept, the newest: the current request's, and enough before it for a late worker's handoff to find its own. */
const MAX_WINDOWS_KEPT = 64;

/** Entries whose window is remembered, the most recent; past it the memory starts over (a walk reads the transcript again). */
const MAX_ENTRIES_REMEMBERED = 4096;

/** The inputs that open a window: words or a wake from outside the session's own work. */
const OPENING_KINDS: ReadonlySet<TurnOriginKind> = new Set<TurnOriginKind>([
	"owner-typed",
	"owner-channel",
	"inbound-channel",
	"peer-agent",
	"routine",
	"host-event",
	"proactive-review",
]);

/** One window as it is kept. */
interface SpendWindowRecord {
	/** `<session id>/<entry id>`: the window's identity, and the run id its workers' spend bound shares. */
	readonly id: string;
	/** The input that opened it: the owner input id it delivered, else its transcript entry's id. */
	readonly input: string;
	/** What kind of input opened it (`TurnOriginKind`), or `transcript` for the transcript's first entry. */
	readonly kind: string;
	/** The session's own spend while serving it, in dollars. */
	foregroundUsd: number;
	/** The attempts found to serve it (their spend is read from the delegation ledger, never kept here). */
	attemptIds: string[];
	/** When it last changed (ms since the epoch): the oldest windows are dropped first. */
	updatedAt: number;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function parseWindow(value: unknown): SpendWindowRecord | undefined {
	if (!isPlainRecord(value)) return undefined;
	const { id, input, kind, foregroundUsd, attemptIds, updatedAt } = value;
	if (typeof id !== "string" || typeof input !== "string" || typeof kind !== "string") return undefined;
	if (typeof foregroundUsd !== "number" || !Number.isFinite(foregroundUsd) || foregroundUsd < 0) return undefined;
	if (typeof updatedAt !== "number" || !Array.isArray(attemptIds)) return undefined;
	if (!attemptIds.every((attemptId) => typeof attemptId === "string")) return undefined;
	return { id, input, kind, foregroundUsd, attemptIds: [...attemptIds], updatedAt };
}

/** The attempt ids a worker-result entry delivers (`records[].attemptId` of its details, a parent input's unwrapped). */
function deliveredAttemptIds(entry: SessionEntry): string[] {
	const raw =
		entry.type === "custom_message"
			? entry.details
			: entry.type === "message" && entry.message.role === "custom"
				? entry.message.details
				: undefined;
	const details = isPlainRecord(raw) && "parentInput" in raw ? raw.originalDetails : raw;
	if (!isPlainRecord(details) || !Array.isArray(details.records)) return [];
	return details.records.flatMap((record) =>
		isPlainRecord(record) && typeof record.attemptId === "string" ? [record.attemptId] : [],
	);
}

/** What the windows read of the bot's session, and tell the owner. */
export interface BotSpendWindowPorts {
	/** The delegation ledger's projection of the session's workers; undefined before the session started any. */
	snapshot(): TaskRuntimeProjection | undefined;
	now(): number;
	/** A record that could not be read or written, in the owner's words. */
	notRead(reason: string): void;
	notWritten(reason: string): void;
}

/** The bot's spend windows over its session's transcript (see the module comment). */
export class BotSpendWindows {
	private readonly windows = new Map<string, SpendWindowRecord>();
	/** The window an attempt serves (`null`: none of this session's), as found from its receipt origin. */
	private readonly attemptWindows = new Map<string, string | null>();
	/** The window id each walked entry belongs to. */
	private readonly entryWindows = new Map<string, string>();
	/** A change not yet written. */
	private dirty = false;
	/** A write failed and the owner was told; told again only after a write succeeds. */
	private writeFailed = false;

	private readonly file: string;
	private readonly transcript: Pick<SessionManager, "getEntry" | "getLeafId" | "getSessionId">;
	private readonly ports: BotSpendWindowPorts;

	constructor(
		file: string,
		transcript: Pick<SessionManager, "getEntry" | "getLeafId" | "getSessionId">,
		ports: BotSpendWindowPorts,
	) {
		this.file = file;
		this.transcript = transcript;
		this.ports = ports;
		try {
			for (const window of this.read()) {
				this.windows.set(window.id, window);
				for (const attemptId of window.attemptIds) this.attemptWindows.set(attemptId, window.id);
			}
		} catch (error) {
			ports.notRead(errorText(error));
		}
	}

	/**
	 * Counts `addedUsd` the session just spent to the window its transcript is in now and returns that window's whole
	 * spend: its foreground and every worker serving it. `turnUsd` (the turn's own spend) is the answer only while the
	 * transcript holds nothing yet.
	 */
	count(turnUsd: number, addedUsd: number): number {
		const leafId = this.transcript.getLeafId();
		const snapshot = this.ports.snapshot();
		const windowId = leafId === null ? undefined : this.windowOfEntry(leafId, snapshot);
		if (windowId === undefined) return turnUsd;
		const window = this.windowFor(windowId);
		if (addedUsd > 0) {
			window.foregroundUsd += addedUsd;
			window.updatedAt = this.ports.now();
			this.dirty = true;
		}
		const spentUsd = window.foregroundUsd + this.workerSpend(window, snapshot);
		this.flush();
		return spentUsd;
	}

	/**
	 * The bound of one run of the window `attempt` serves: `boundUsd` (the bound on its model's spend) less what the
	 * session itself spent in that window, never below zero. The window's workers share it as one run (`runId`), whose
	 * spend the run budget counts from their own usage. Undefined when the attempt serves no window of this session or no
	 * bound applies to its model.
	 */
	runCostBound(
		attempt: AttemptRuntimeState,
		snapshot: TaskRuntimeProjection,
		boundUsd: number | undefined,
	): { readonly runId: string; readonly maxCostUsd: number } | undefined {
		if (boundUsd === undefined) return undefined;
		const windowId = this.windowOfAttempt(attempt, snapshot);
		if (windowId === undefined) return undefined;
		const foregroundUsd = this.windows.get(windowId)?.foregroundUsd ?? 0;
		this.flush();
		return { runId: windowId, maxCostUsd: Math.max(0, boundUsd - foregroundUsd) };
	}

	/** The spend of the workers serving `window`, as the delegation ledger counts each attempt's usage. */
	private workerSpend(window: SpendWindowRecord, snapshot: TaskRuntimeProjection | undefined): number {
		if (!snapshot) return 0;
		let usd = 0;
		for (const attempt of Object.values(snapshot.attempts)) {
			if (this.windowOfAttempt(attempt, snapshot) !== window.id) continue;
			usd += projectAttemptUsage(attempt, snapshot.checkpoints)?.costUsd ?? 0;
		}
		return usd;
	}

	/** The window an attempt serves: the one its receipt origin's leaf belongs to, when that leaf is this session's. */
	private windowOfAttempt(
		attempt: AttemptRuntimeState,
		snapshot: TaskRuntimeProjection | undefined,
	): string | undefined {
		const known = this.attemptWindows.get(attempt.attemptId);
		if (known !== undefined) return known ?? undefined;
		const origin = attempt.dispatch.receiptOrigin;
		const windowId =
			origin && origin.sessionId === this.transcript.getSessionId()
				? this.windowOfEntry(origin.leafId, snapshot)
				: undefined;
		this.attemptWindows.set(attempt.attemptId, windowId ?? null);
		const window = windowId === undefined ? undefined : this.windows.get(windowId);
		if (window && !window.attemptIds.includes(attempt.attemptId)) {
			window.attemptIds.push(attempt.attemptId);
			this.dirty = true;
		}
		return windowId;
	}

	/**
	 * The window an entry belongs to: walking back from it to the input that opened its window. A worker's handoff
	 * belongs to the window of the first attempt it delivers that serves one; a handoff whose attempts serve none, and
	 * every entry that is no outside input, belong to the window before it. The earliest entry the walk reaches (the
	 * transcript's first) opens the window nothing later opened. Undefined only for an entry the transcript does not hold.
	 */
	private windowOfEntry(entryId: string, snapshot: TaskRuntimeProjection | undefined, depth = 0): string | undefined {
		const walked: string[] = [];
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
			const entry = this.transcript.getEntry(id);
			if (!entry || walked.includes(id)) break;
			walked.push(id);
			last = entry;
			const kind = entryTurnOrigin(entry)?.k;
			if (kind !== undefined && OPENING_KINDS.has(kind)) windowId = this.windowIdOf(entry.id);
			else if (kind === "worker-result" && depth < 8) {
				const attemptIds = deliveredAttemptIds(entry);
				windowId = this.windowOfDelivered(attemptIds, snapshot, depth);
				if (windowId === undefined && attemptIds.length > 0) settled = false;
			}
			id = entry.parentId;
		}
		if (windowId === undefined && last) windowId = this.windowIdOf(last.id);
		if (windowId !== undefined && settled) this.remember(walked, windowId);
		return windowId;
	}

	/** The window of the first delivered attempt that serves one of this session's. */
	private windowOfDelivered(
		attemptIds: readonly string[],
		snapshot: TaskRuntimeProjection | undefined,
		depth: number,
	): string | undefined {
		for (const attemptId of attemptIds) {
			const known = this.attemptWindows.get(attemptId);
			if (known) return known;
			const attempt = snapshot?.attempts[attemptId];
			const origin = attempt?.dispatch.receiptOrigin;
			if (!origin || origin.sessionId !== this.transcript.getSessionId()) continue;
			const windowId = this.windowOfEntry(origin.leafId, snapshot, depth + 1);
			if (windowId !== undefined) return windowId;
		}
		return undefined;
	}

	private remember(entryIds: readonly string[], windowId: string): void {
		if (this.entryWindows.size + entryIds.length > MAX_ENTRIES_REMEMBERED) this.entryWindows.clear();
		for (const entryId of entryIds) this.entryWindows.set(entryId, windowId);
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
			attemptIds: [],
			updatedAt: this.ports.now(),
		};
		this.windows.set(windowId, window);
		return window;
	}

	/**
	 * The windows kept, oldest first. A record that is not a list of windows is set aside (renamed `.unreadable`) and
	 * thrown, so it is reported once and the next write starts a new one; a file that cannot be read is thrown and kept.
	 */
	private read(): SpendWindowRecord[] {
		if (!existsSync(this.file)) return [];
		const text = readFileSync(this.file, "utf8");
		try {
			const value: unknown = JSON.parse(text);
			if (!isPlainRecord(value) || value.v !== 1 || !Array.isArray(value.windows))
				throw new Error("not a record of spend windows");
			return value.windows.map((item) => {
				const window = parseWindow(item);
				if (!window) throw new Error("a spend window does not read");
				return window;
			});
		} catch (error) {
			renameSync(this.file, `${this.file}.unreadable`);
			throw new Error(`${this.file} was set aside as ${this.file}.unreadable: ${errorText(error)}`);
		}
	}

	/**
	 * Writes the changes, keeping the newest windows and dropping the oldest beyond the kept many; a failure is told once
	 * until a write succeeds, and the changes stay to be written with the next.
	 */
	private flush(): void {
		if (!this.dirty) return;
		const kept = [...this.windows.values()].sort((a, b) => a.updatedAt - b.updatedAt).slice(-MAX_WINDOWS_KEPT);
		if (kept.length < this.windows.size) {
			const keptIds = new Set(kept.map((window) => window.id));
			for (const id of this.windows.keys()) if (!keptIds.has(id)) this.windows.delete(id);
			for (const [attemptId, windowId] of this.attemptWindows)
				if (windowId !== null && !keptIds.has(windowId)) this.attemptWindows.delete(attemptId);
		}
		try {
			writeFileAtomicSync(this.file, `${JSON.stringify({ v: 1, windows: kept })}\n`, { mode: 0o600 });
			this.dirty = false;
			this.writeFailed = false;
		} catch (error) {
			if (!this.writeFailed) this.ports.notWritten(errorText(error));
			this.writeFailed = true;
		}
	}
}
