/**
 * Adaptive concurrency per provider account (AIMD): how many fleet workers one account serves at once is learned from
 * the provider's own answers, never configured. Each settled request of the account (every lane: the foreground teaches
 * too) is one of the ordered exits below, `t_s` being the time the request was dispatched:
 *
 * 1. aborted: no change;
 * 2. a used-up subscription usage window: the account is blocked until the stated reset, W unchanged (quota, not
 *    congestion);
 * 3. a 429, 529 or rate-limit/overload refusal of a request dispatched after the last decrease: W and ssthresh halve
 *    (never below 1) and the account is blocked until a stated reset; one decrease per congestion episode;
 * 4. a transport failure or a server error that is not an overload, or any other failure: no change;
 * 5. a success dispatched while the window was in use (fleet workers on the account >= floor(W) - 1): W grows by one
 *    below ssthresh (slow start) and by 1/W above it;
 * 6. a success with the window under-used: no change.
 *
 * W stays within 1 and the running ceiling; the owner's `providerAdmission.limits[provider]` clamps it further. The seed
 * W0 = 4 and ssthresh0 = the ceiling are starting values, not measurements.
 *
 * When a blocked window reopens, it releases at most max(1, floor(W/2)) workers until the first success on the account
 * proves it serves again (thundering herd), and the fleet's wake for the reopen is jittered (`reopenJitterMs`).
 *
 * The windows are one per agent directory per process and machine-wide through `state/fleet/accounts.json`: a write
 * merges into the file, where the record with the later decrease wins and, between equal decreases, the later update,
 * so a process that never saw a refusal cannot restore a halved window. The running counts are machine-wide too: every
 * process writes its live workers there (`workers`), and a worker of a process that no longer runs stops counting at once.
 */

import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { harnessLog } from "../../../kernel/harness-log.ts";
import { describeProviderAccountKey } from "../../provider-admission/account-key.ts";
import type { ProviderRequestOutcome } from "../../provider-admission/request-outcome.ts";
import { isPlainRecord } from "../../util/value-guards.ts";
import { FleetSharedState } from "../fleet-shared-state.ts";
import type { RoomTerm } from "../fleet-types.ts";
import { addLiveHolder, type HolderRecord, holderAlive } from "../shared-holder.ts";
import { allowanceWaitKey } from "./allowance-room.ts";

/** The starting window of an account never seen refusing. */
export const ACCOUNT_WINDOW_SEED = 4;
/** Accounts kept in the shared file; the least recently updated beyond it are dropped. */
const MAX_ACCOUNT_RECORDS = 256;
/** Live fleet workers kept in the shared file. */
const MAX_WORKER_RECORDS = 4096;
/** The longest a fleet worker is counted for its account by the other processes (a hung holder, or a reused pid). */
const MAX_WORKER_AGE_MS = 6 * 60 * 60_000;
/** The jitter bound of a window reopen whose length is unknown, and the cap of every reopen's jitter. */
const REOPEN_JITTER_UNKNOWN_MS = 10_000;
const REOPEN_JITTER_CAP_MS = 30_000;

interface WindowRecord {
	w: number;
	ssthresh: number;
	lastDecreaseAt: number;
	updatedAt: number;
	blockedUntil?: number;
	/** When the current block was recorded; its length bounds the reopen jitter. */
	blockedAt?: number;
}

/** A live fleet worker on an account, as a process wrote it: its claim's account and the holder that claimed it. */
interface WorkerRecord extends HolderRecord {
	readonly account: string;
}

interface AccountsFile {
	readonly v: 1;
	readonly accounts: Readonly<Record<string, WindowRecord>>;
	/** Live fleet workers of every process on the machine, keyed by claim id. */
	readonly workers?: Readonly<Record<string, WorkerRecord>>;
}

export interface AccountWindowSnapshot {
	readonly accountKey: string;
	readonly window: number;
	readonly ssthresh: number;
	readonly running: number;
	readonly blockedUntil?: number;
}

/**
 * The clock and running ceiling of the caller that asks. The windows hold no caller's closure: a fleet passes its own
 * settings and timers into each read, and each observed request passes its own into its settlement.
 */
export interface AccountWindowCaller {
	now(): number;
	/** The running ceiling: the most any window grows to. */
	ceiling(): number;
}

function finiteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function parseAccountsFile(value: unknown): AccountsFile | undefined {
	if (!isPlainRecord(value) || value.v !== 1 || !isPlainRecord(value.accounts)) return undefined;
	const accounts: Record<string, WindowRecord> = {};
	for (const [key, raw] of Object.entries(value.accounts)) {
		if (!isPlainRecord(raw)) continue;
		const { w, ssthresh, lastDecreaseAt, updatedAt, blockedUntil, blockedAt } = raw;
		if (!finiteNumber(w) || !finiteNumber(ssthresh) || !finiteNumber(lastDecreaseAt) || !finiteNumber(updatedAt))
			continue;
		accounts[key] = {
			w: Math.max(1, w),
			ssthresh: Math.max(1, ssthresh),
			lastDecreaseAt,
			updatedAt,
			...(finiteNumber(blockedUntil) ? { blockedUntil } : {}),
			...(finiteNumber(blockedAt) ? { blockedAt } : {}),
		};
	}
	const workers: Record<string, WorkerRecord> = {};
	if (isPlainRecord(value.workers))
		for (const [claimId, raw] of Object.entries(value.workers)) {
			if (!isPlainRecord(raw)) continue;
			const { account, holder, pid, at } = raw;
			if (typeof account === "string" && typeof holder === "string" && finiteNumber(pid) && finiteNumber(at))
				workers[claimId] = { account, holder, pid, at };
		}
	return { v: 1, accounts, workers };
}

/** The later decrease wins; between equal decreases, the later update. */
function newer(a: WindowRecord, b: WindowRecord): WindowRecord {
	if (a.lastDecreaseAt !== b.lastDecreaseAt) return a.lastDecreaseAt > b.lastDecreaseAt ? a : b;
	return a.updatedAt >= b.updatedAt ? a : b;
}

/** One account's merged record: the newer window, and the later block while it still holds at `now`. */
function mergeRecord(a: WindowRecord | undefined, b: WindowRecord | undefined, now: number): WindowRecord | undefined {
	const winner = a && b ? newer(a, b) : (a ?? b);
	if (!winner) return undefined;
	const { blockedUntil: _until, blockedAt: _at, ...open } = winner;
	const block = [a, b]
		.filter((record): record is WindowRecord => record?.blockedUntil !== undefined && record.blockedUntil > now)
		.sort((x, y) => (y.blockedUntil ?? 0) - (x.blockedUntil ?? 0))[0];
	return block?.blockedUntil !== undefined
		? {
				...open,
				blockedUntil: block.blockedUntil,
				...(block.blockedAt !== undefined ? { blockedAt: block.blockedAt } : {}),
			}
		: open;
}

/** A uniform fraction in [0, 1) seeded by this process, the account and the episode: no two processes reopen in step. */
function seededFraction(accountKey: string, episode: number): number {
	const digest = createHash("sha256").update(`${process.pid}:${accountKey}:${episode}`).digest();
	return digest.readUInt32BE(0) / 2 ** 32;
}

export class AccountWindows {
	private readonly file: FleetSharedState<AccountsFile>;
	private readonly records = new Map<string, WindowRecord>();
	/** This process's fleet workers running per account. */
	private readonly running = new Map<string, number>();
	/** This process's live claims by claim id: written to the shared file, so every process counts them. */
	private readonly claims = new Map<string, { readonly account: string; readonly at: number }>();
	/** The machine-wide worker records as the shared file last held them. */
	private diskWorkers: Readonly<Record<string, WorkerRecord>> = {};
	/** Identifies this instance's claims in the shared file; alive while the process runs. */
	private readonly holder = randomUUID();
	/** Workers a reopened window still releases before a success proves it serves again. */
	private readonly ramps = new Map<string, number>();
	/** Accounts last seen blocked; the first look after their block ended reopens them. */
	private readonly blocked = new Set<string>();
	private readonly listeners = new Set<(accountKey: string) => void>();

	constructor(agentDir: string) {
		this.file = new FleetSharedState(
			join(agentDir, "state", "fleet", "accounts.json"),
			"accounts",
			parseAccountsFile,
		);
		addLiveHolder(this.holder);
		this.adoptDisk(Date.now());
	}

	/** Calls `listener` with the account whose window grew or reopened, so waiters on it can be woken. */
	subscribe(listener: (accountKey: string) => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	/** One fleet worker started on the account; the returned release ends its claim (idempotent). */
	acquireWorker(accountKey: string): () => void {
		this.running.set(accountKey, (this.running.get(accountKey) ?? 0) + 1);
		const ramp = this.ramps.get(accountKey);
		if (ramp !== undefined) this.ramps.set(accountKey, Math.max(0, ramp - 1));
		const claimId = randomUUID();
		this.claims.set(claimId, { account: accountKey, at: Date.now() });
		this.persistWorkers();
		let released = false;
		return () => {
			if (released) return;
			released = true;
			const left = (this.running.get(accountKey) ?? 1) - 1;
			if (left > 0) this.running.set(accountKey, left);
			else this.running.delete(accountKey);
			this.claims.delete(claimId);
			this.persistWorkers();
		};
	}

	/** One request on the account was dispatched; the returned settle folds how it ended into the window. */
	begin(accountKey: string, caller: AccountWindowCaller): (outcome: ProviderRequestOutcome) => void {
		const startedAt = caller.now();
		this.adoptDisk(startedAt);
		const record = this.record(accountKey, caller);
		const inUse = this.runningOf(accountKey) >= Math.floor(record.w) - 1;
		return (outcome) => this.settle(accountKey, outcome, startedAt, inUse, caller);
	}

	/**
	 * The account term of the room formula: 0 while a stated reset blocks the account (with `retryAt`), otherwise the
	 * window less the fleet workers running on the account, capped by a reopened window's release budget.
	 */
	term(accountKey: string, providerLimit: number | undefined, caller: AccountWindowCaller): RoomTerm {
		this.adoptDisk(caller.now());
		const record = this.record(accountKey, caller);
		const now = caller.now();
		const waitKey = allowanceWaitKey(accountKey);
		if (record.blockedUntil !== undefined && record.blockedUntil > now) {
			this.blocked.add(accountKey);
			return {
				reason: "account_window",
				room: 0,
				waitKey,
				retryAt: record.blockedUntil,
				detail: `the provider refused more requests on this account until ${new Date(record.blockedUntil).toISOString()}`,
			};
		}
		if (this.blocked.delete(accountKey)) this.reopen(accountKey, record);
		const window = Math.floor(this.cap(record.w, providerLimit, caller));
		const running = this.runningOf(accountKey);
		// A reopened window's release budget never holds this process at zero with none of its own running: a probe whose
		// request ended without a verdict (aborted, transport) must not leave it waiting for a success that cannot come.
		const stored = this.ramps.get(accountKey);
		const ramp = stored !== undefined && (this.running.get(accountKey) ?? 0) === 0 ? Math.max(1, stored) : stored;
		const room = Math.max(0, Math.min(window - running, ramp ?? Number.POSITIVE_INFINITY));
		return {
			reason: "provider_room",
			room,
			waitKey,
			detail:
				ramp !== undefined && ramp < window - running
					? `the account's limit just reset; ${running} worker(s) started on it wait for its first success before more start`
					: `${running} of ${window} worker(s) the account serves at once are running`,
		};
	}

	/** The jitter added to a reopen at `retryAt`: uniform in [0, J), J = min(30 s, a tenth of the block's length). */
	reopenJitterMs(accountKey: string, retryAt: number): number {
		const record = this.records.get(accountKey);
		const length = record?.blockedAt !== undefined ? retryAt - record.blockedAt : undefined;
		const bound =
			length !== undefined && length > 0 ? Math.min(REOPEN_JITTER_CAP_MS, length / 10) : REOPEN_JITTER_UNKNOWN_MS;
		return Math.floor(seededFraction(accountKey, retryAt) * bound);
	}

	/** Every account the fleet started work on, or that holds a block or a learned window. */
	snapshot(caller: AccountWindowCaller): AccountWindowSnapshot[] {
		this.adoptDisk(caller.now());
		const keys = new Set([
			...this.records.keys(),
			...this.running.keys(),
			...this.liveOthers(Date.now()).map((worker) => worker.account),
		]);
		return [...keys].map((accountKey) => {
			const record = this.record(accountKey, caller);
			return {
				accountKey,
				window: Math.floor(record.w),
				ssthresh: record.ssthresh,
				running: this.runningOf(accountKey),
				...(record.blockedUntil !== undefined ? { blockedUntil: record.blockedUntil } : {}),
			};
		});
	}

	/** After a resume or a restart every window releases half of itself until its first success (thundering herd). */
	rampAll(): void {
		for (const [accountKey, record] of this.records)
			this.ramps.set(accountKey, Math.max(1, Math.floor(record.w / 2)));
	}

	/** The fleet workers running on the account machine-wide: this process's own, and the live claims of the other processes. */
	private runningOf(accountKey: string): number {
		return (
			(this.running.get(accountKey) ?? 0) +
			this.liveOthers(Date.now()).filter((worker) => worker.account === accountKey).length
		);
	}

	/** The worker records of the other processes that still hold: their process runs and the claim is within its age bound. */
	private liveOthers(now: number): WorkerRecord[] {
		return Object.values(this.diskWorkers).filter(
			(worker) => worker.holder !== this.holder && holderAlive(worker, now, MAX_WORKER_AGE_MS),
		);
	}

	private cap(w: number, providerLimit: number | undefined, caller: AccountWindowCaller): number {
		const ceiling = Math.max(1, caller.ceiling());
		return Math.max(
			1,
			Math.min(w, ceiling, providerLimit !== undefined && providerLimit > 0 ? providerLimit : ceiling),
		);
	}

	private record(accountKey: string, caller: AccountWindowCaller): WindowRecord {
		return (
			this.records.get(accountKey) ?? {
				w: ACCOUNT_WINDOW_SEED,
				ssthresh: Math.max(1, caller.ceiling()),
				lastDecreaseAt: 0,
				updatedAt: 0,
			}
		);
	}

	private reopen(accountKey: string, record: WindowRecord): void {
		const { blockedUntil: _blockedUntil, blockedAt: _blockedAt, ...open } = record;
		this.records.set(accountKey, open);
		this.ramps.set(accountKey, Math.max(1, Math.floor(record.w / 2)));
		harnessLog.info("fleet", "an account's window reopened", () => ({
			account: describeProviderAccountKey(accountKey),
			window: Math.floor(record.w),
		}));
		this.notify(accountKey);
	}

	private settle(
		accountKey: string,
		outcome: ProviderRequestOutcome,
		startedAt: number,
		inUse: boolean,
		caller: AccountWindowCaller,
	): void {
		const now = caller.now();
		const record = this.record(accountKey, caller);
		switch (outcome.kind) {
			case "aborted":
			case "transport":
			case "other":
				return;
			case "usage_window":
				if (outcome.resetAt === undefined || outcome.resetAt <= now) return;
				this.update(
					accountKey,
					{
						...record,
						blockedUntil: Math.max(record.blockedUntil ?? 0, outcome.resetAt),
						blockedAt: now,
					},
					now,
				);
				harnessLog.info("fleet", "an account is blocked until its usage window resets", () => ({
					account: describeProviderAccountKey(accountKey),
					retryAfterMs: (outcome.resetAt ?? now) - now,
				}));
				return;
			case "congestion": {
				if (startedAt <= record.lastDecreaseAt) return;
				const halved = Math.max(1, Math.floor(record.w / 2));
				const blocked =
					outcome.resetAt !== undefined && outcome.resetAt > now
						? { blockedUntil: Math.max(record.blockedUntil ?? 0, outcome.resetAt), blockedAt: now }
						: {};
				this.update(accountKey, { ...record, w: halved, ssthresh: halved, lastDecreaseAt: now, ...blocked }, now);
				this.ramps.delete(accountKey);
				harnessLog.info("fleet", "an account's window halved after a provider refusal", () => ({
					account: describeProviderAccountKey(accountKey),
					window: halved,
				}));
				return;
			}
			case "success": {
				const reopened = this.ramps.delete(accountKey);
				if (!inUse) {
					if (reopened) this.notify(accountKey);
					return;
				}
				const ceiling = Math.max(1, caller.ceiling());
				const w = Math.min(ceiling, record.w < record.ssthresh ? record.w + 1 : record.w + 1 / record.w);
				if (w === record.w) {
					if (reopened) this.notify(accountKey);
					return;
				}
				this.update(accountKey, { ...record, w }, now);
				const before = Math.floor(record.w);
				const after = Math.floor(w);
				if (after > before) {
					if ((after & (after - 1)) === 0)
						harnessLog.info("fleet", "an account's window grew", () => ({
							account: describeProviderAccountKey(accountKey),
							window: after,
						}));
					this.notify(accountKey);
				} else if (reopened) this.notify(accountKey);
				return;
			}
		}
	}

	private update(accountKey: string, record: WindowRecord, now: number): void {
		this.records.set(accountKey, { ...record, updatedAt: now });
		this.file.schedule((disk) => this.mergeFile(disk, now));
	}

	/**
	 * Writes this instance's live claims. It is the same merge as a window write: the scheduler keeps one pending merge per
	 * tick, so a claim written in the same tick as a window record must carry that record too.
	 */
	private persistWorkers(): void {
		this.file.schedule((disk) => this.mergeFile(disk, Date.now()));
	}

	/** The shared file's merge under its lock: this instance's window records and live claims over what the file holds. */
	private mergeFile(disk: AccountsFile | undefined, now: number): AccountsFile {
		const merged = new Map<string, WindowRecord>(Object.entries(disk?.accounts ?? {}));
		for (const [key, mine] of this.records) {
			const next = mergeRecord(merged.get(key), mine, now);
			if (next) merged.set(key, next);
		}
		const kept = [...merged.entries()].sort((a, b) => b[1].updatedAt - a[1].updatedAt).slice(0, MAX_ACCOUNT_RECORDS);
		for (const [key, record] of kept) this.records.set(key, record);
		const workers = disk?.workers ?? {};
		this.diskWorkers = workers;
		return { v: 1, accounts: Object.fromEntries(kept), workers: this.mergedWorkers(workers) };
	}

	/**
	 * The worker records to write: this instance's live claims, then the other processes' records that still hold. Worker
	 * liveness is the system clock (the claims' `at` and the other processes' reads use it), whatever clock the caller has.
	 */
	private mergedWorkers(disk: Readonly<Record<string, WorkerRecord>>): Record<string, WorkerRecord> {
		const own: [string, WorkerRecord][] = [...this.claims].map(([claimId, claim]) => [
			claimId,
			{ account: claim.account, holder: this.holder, pid: process.pid, at: claim.at },
		]);
		const others = Object.entries(disk)
			.filter(([, worker]) => worker.holder !== this.holder && holderAlive(worker, Date.now(), MAX_WORKER_AGE_MS))
			.sort((a, b) => b[1].at - a[1].at);
		return Object.fromEntries([...own, ...others].slice(0, MAX_WORKER_RECORDS));
	}

	/** Takes the shared file's newer facts when it changed since the last read. */
	private adoptDisk(now: number): void {
		const disk = this.file.readIfChanged();
		if (!disk) return;
		for (const [key, theirs] of Object.entries(disk.accounts)) {
			const next = mergeRecord(this.records.get(key), theirs, now);
			if (next) this.records.set(key, next);
		}
		this.diskWorkers = disk.workers ?? {};
		// A file another build rewrote may have dropped this process's live claims: write them again.
		if ([...this.claims.keys()].some((claimId) => this.diskWorkers[claimId] === undefined)) this.persistWorkers();
	}

	private notify(accountKey: string): void {
		for (const listener of [...this.listeners]) {
			try {
				listener(accountKey);
			} catch {
				// A listener's failure never stops the others from hearing the window change.
			}
		}
	}
}

const windowsByAgentDir = new Map<string, AccountWindows>();

/**
 * The process's account windows of `agentDir`. One object per agent directory, so every session on it shares the learned
 * windows and their reopen state; each lookup rebinds the clock and ceiling to the caller's, so a later session never
 * reads the closures of a session that was created before it.
 */
export function accountWindowsFor(agentDir: string): AccountWindows {
	let windows = windowsByAgentDir.get(agentDir);
	if (!windows) {
		windows = new AccountWindows(agentDir);
		windowsByAgentDir.set(agentDir, windows);
	}
	return windows;
}
