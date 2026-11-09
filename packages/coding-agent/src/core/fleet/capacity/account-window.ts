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
 * so a process that never saw a refusal cannot restore a halved window. The worker counts are this process's own.
 */

import { createHash } from "node:crypto";
import { join } from "node:path";
import { harnessLog } from "../../../kernel/harness-log.ts";
import { describeProviderAccountKey } from "../../provider-admission/account-key.ts";
import type { ProviderRequestOutcome } from "../../provider-admission/request-outcome.ts";
import { isPlainRecord } from "../../util/value-guards.ts";
import { FleetSharedState } from "../fleet-shared-state.ts";
import type { RoomTerm } from "../fleet-types.ts";
import { allowanceWaitKey } from "./allowance-room.ts";

/** The starting window of an account never seen refusing. */
export const ACCOUNT_WINDOW_SEED = 4;
/** Accounts kept in the shared file; the least recently updated beyond it are dropped. */
const MAX_ACCOUNT_RECORDS = 256;
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

interface AccountsFile {
	readonly v: 1;
	readonly accounts: Readonly<Record<string, WindowRecord>>;
}

export interface AccountWindowSnapshot {
	readonly accountKey: string;
	readonly window: number;
	readonly ssthresh: number;
	readonly running: number;
	readonly blockedUntil?: number;
}

export interface AccountWindowsOptions {
	readonly agentDir: string;
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
	return { v: 1, accounts };
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
	private readonly options: AccountWindowsOptions;
	private readonly file: FleetSharedState<AccountsFile>;
	private readonly records = new Map<string, WindowRecord>();
	private readonly running = new Map<string, number>();
	/** Workers a reopened window still releases before a success proves it serves again. */
	private readonly ramps = new Map<string, number>();
	/** Accounts last seen blocked; the first look after their block ended reopens them. */
	private readonly blocked = new Set<string>();
	private readonly listeners = new Set<(accountKey: string) => void>();

	constructor(options: AccountWindowsOptions) {
		this.options = options;
		this.file = new FleetSharedState(
			join(options.agentDir, "state", "fleet", "accounts.json"),
			"accounts",
			parseAccountsFile,
		);
		this.adoptDisk();
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
		let released = false;
		return () => {
			if (released) return;
			released = true;
			const left = (this.running.get(accountKey) ?? 1) - 1;
			if (left > 0) this.running.set(accountKey, left);
			else this.running.delete(accountKey);
		};
	}

	/** One request on the account was dispatched; the returned settle folds how it ended into the window. */
	begin(accountKey: string): (outcome: ProviderRequestOutcome) => void {
		const startedAt = this.options.now();
		const record = this.record(accountKey);
		const inUse = (this.running.get(accountKey) ?? 0) >= Math.floor(record.w) - 1;
		return (outcome) => this.settle(accountKey, outcome, startedAt, inUse);
	}

	/**
	 * The account term of the room formula: 0 while a stated reset blocks the account (with `retryAt`), otherwise the
	 * window less the fleet workers running on the account, capped by a reopened window's release budget.
	 */
	term(accountKey: string, providerLimit: number | undefined): RoomTerm {
		this.adoptDisk();
		const record = this.record(accountKey);
		const now = this.options.now();
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
		const window = Math.floor(this.cap(record.w, providerLimit));
		const running = this.running.get(accountKey) ?? 0;
		// A reopened window's release budget never holds the account at zero with nothing running: a probe whose request
		// ended without a verdict (aborted, transport) must not leave the account waiting for a success that cannot come.
		const stored = this.ramps.get(accountKey);
		const ramp = stored !== undefined && running === 0 ? Math.max(1, stored) : stored;
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
	snapshot(): AccountWindowSnapshot[] {
		const keys = new Set([...this.records.keys(), ...this.running.keys()]);
		return [...keys].map((accountKey) => {
			const record = this.record(accountKey);
			return {
				accountKey,
				window: Math.floor(record.w),
				ssthresh: record.ssthresh,
				running: this.running.get(accountKey) ?? 0,
				...(record.blockedUntil !== undefined ? { blockedUntil: record.blockedUntil } : {}),
			};
		});
	}

	/** After a resume or a restart every window releases half of itself until its first success (thundering herd). */
	rampAll(): void {
		for (const [accountKey, record] of this.records)
			this.ramps.set(accountKey, Math.max(1, Math.floor(record.w / 2)));
	}

	private cap(w: number, providerLimit: number | undefined): number {
		const ceiling = Math.max(1, this.options.ceiling());
		return Math.max(
			1,
			Math.min(w, ceiling, providerLimit !== undefined && providerLimit > 0 ? providerLimit : ceiling),
		);
	}

	private record(accountKey: string): WindowRecord {
		return (
			this.records.get(accountKey) ?? {
				w: ACCOUNT_WINDOW_SEED,
				ssthresh: Math.max(1, this.options.ceiling()),
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

	private settle(accountKey: string, outcome: ProviderRequestOutcome, startedAt: number, inUse: boolean): void {
		const now = this.options.now();
		const record = this.record(accountKey);
		switch (outcome.kind) {
			case "aborted":
			case "transport":
			case "other":
				return;
			case "usage_window":
				if (outcome.resetAt === undefined || outcome.resetAt <= now) return;
				this.update(accountKey, {
					...record,
					blockedUntil: Math.max(record.blockedUntil ?? 0, outcome.resetAt),
					blockedAt: now,
				});
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
				this.update(accountKey, { ...record, w: halved, ssthresh: halved, lastDecreaseAt: now, ...blocked });
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
				const ceiling = Math.max(1, this.options.ceiling());
				const w = Math.min(ceiling, record.w < record.ssthresh ? record.w + 1 : record.w + 1 / record.w);
				if (w === record.w) {
					if (reopened) this.notify(accountKey);
					return;
				}
				this.update(accountKey, { ...record, w });
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

	private update(accountKey: string, record: WindowRecord): void {
		this.records.set(accountKey, { ...record, updatedAt: this.options.now() });
		this.file.schedule((disk) => {
			const merged = new Map<string, WindowRecord>(Object.entries(disk?.accounts ?? {}));
			for (const [key, mine] of this.records) {
				const next = mergeRecord(merged.get(key), mine, this.options.now());
				if (next) merged.set(key, next);
			}
			const kept = [...merged.entries()]
				.sort((a, b) => b[1].updatedAt - a[1].updatedAt)
				.slice(0, MAX_ACCOUNT_RECORDS);
			for (const [key, record] of kept) this.records.set(key, record);
			return { v: 1, accounts: Object.fromEntries(kept) };
		});
	}

	/** Takes the shared file's newer facts when it changed since the last read. */
	private adoptDisk(): void {
		const disk = this.file.readIfChanged();
		if (!disk) return;
		for (const [key, theirs] of Object.entries(disk.accounts)) {
			const next = mergeRecord(this.records.get(key), theirs, this.options.now());
			if (next) this.records.set(key, next);
		}
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

/** The process's account windows of `agentDir`; the first caller's clock and ceiling serve every later one. */
export function accountWindowsFor(options: AccountWindowsOptions): AccountWindows {
	let windows = windowsByAgentDir.get(options.agentDir);
	if (!windows) {
		windows = new AccountWindows(options);
		windowsByAgentDir.set(options.agentDir, windows);
	}
	return windows;
}
