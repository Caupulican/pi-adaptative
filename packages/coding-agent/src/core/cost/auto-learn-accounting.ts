import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, realpathSync, renameSync, rmSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { setImmediate } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import type { Usage } from "@caupulican/pi-ai";
import { readHostIdentity } from "../../kernel/reliability/host-identity.ts";
import {
	isOwnerMachineIdField,
	isOwnerProvenDead,
	isProcessOwnerRecord,
	ownProcessOwner,
	type ProcessOwner,
} from "../../kernel/reliability/owner-identity.ts";
import { isPositiveSafePid } from "../../kernel/reliability/process-tree.ts";
import { holdWorkRun, releaseWorkRunHold, type WorkRunHold, type WorkRunLease } from "../../utils/work-directory.ts";
import { validateProviderUsage } from "../orchestration/attempt-usage.ts";
import { isMissingFileError, withFileLockSync, writeFileAtomicSync } from "../util/atomic-file.ts";
import { readBoundedDirectoryNamesSync, readBoundedTextFileSync } from "../util/bounded-file.ts";
import { isPlainRecord } from "../util/value-guards.ts";
import {
	type AutoLearnUsageSnapshot,
	assertAutoLearnUsageSourceCurrent,
	readAutoLearnUsageSnapshot,
} from "./auto-learn-usage.ts";
import type { SpawnedUsageReceiptDisposition, SpawnedUsageReceiptOptions } from "./spawned-usage-receipt.ts";

const MAX_OBLIGATIONS = 64;
const MAX_RECORD_BYTES = 16 * 1024;
const FAILED_EVIDENCE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** How long an obligation whose owning session process is proven dead stays open for that session to reopen. */
const ABANDONED_OBLIGATION_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;
/** Expired obligations are kept as receipts in this subdirectory, outside the counted obligation namespace. */
const EXPIRED_DIRECTORY = "expired";
/** Bound on the expired-receipt ledger; the oldest receipt is dropped (and announced) to admit a new one. */
const MAX_EXPIRED_RECEIPTS = 256;
const PHASES = ["registering", "prepared", "not_spawned", "running", "terminal", "captured", "confirmed", "expired"];
const EXPIRABLE_PHASES = ["prepared", "running", "terminal", "captured", "confirmed"] as const;
type ExpirablePhase = (typeof EXPIRABLE_PHASES)[number];

function isExpirablePhase(value: unknown): value is ExpirablePhase {
	return (EXPIRABLE_PHASES as readonly unknown[]).includes(value);
}

export interface AutoLearnAccountingOwner {
	sessionId: string;
	sessionFile: string | undefined;
	isCurrent(): boolean;
	deliver(usage: Usage, options: SpawnedUsageReceiptOptions): SpawnedUsageReceiptDisposition;
}

/**
 * Why and how an obligation ended without its session settling it. `usage` keeps the accounting honest: only an
 * obligation that expired after its usage was confirmed into the session is `delivered`; every other one is
 * `unaccounted`, and its `snapshot` (when one was captured) is the usage that was never charged.
 */
interface ObligationExpiry {
	at: number;
	from: ExpirablePhase;
	usage: "delivered" | "unaccounted";
	reason: string;
}

/**
 * One learner run's charge to its parent session. Two processes are named:
 * - the learner child, `pid` on the registering host (`host` is its hostname, `machineId` its machine id when
 *   readable). Records written before `machineId` was recorded are judged by hostname alone.
 * - `owner`, the session process that registered the obligation or adopted it when its session reopened, with
 *   `ownedAt` the time it took custody. Records written before the owner was recorded carry neither until adopted,
 *   and cannot expire before then.
 */
interface Obligation {
	version: 1;
	runId: string;
	tenant: string;
	parentSessionId: string;
	parentSessionFile: string | null;
	childSessionId: string;
	workRunPath: string;
	hold: WorkRunHold;
	phase: "registering" | "prepared" | "not_spawned" | ExpirablePhase | "expired";
	host: string;
	machineId?: string;
	pid?: number;
	owner?: ProcessOwner;
	ownedAt?: number;
	handoffPersisted: boolean;
	cleanupAfter: number;
	snapshot?: AutoLearnUsageSnapshot;
	expiry?: ObligationExpiry;
}

function isExpiry(value: unknown): value is ObligationExpiry {
	return (
		isPlainRecord(value) &&
		Number.isFinite(value.at) &&
		isExpirablePhase(value.from) &&
		(value.usage === "delivered" || value.usage === "unaccounted") &&
		typeof value.reason === "string"
	);
}

function validId(value: unknown): value is string {
	return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value);
}

function recordNames(directory: string): string[] {
	return readBoundedDirectoryNamesSync(directory, MAX_OBLIGATIONS + 16, "Auto Learn accounting").filter((name) =>
		name.endsWith(".json"),
	);
}

/** Registration and ordinary history pruning serialize on the same durable obligation directory. */
export function withAutoLearnAccountingProtection<T>(
	directory: string,
	operation: (runIds: ReadonlySet<string>) => T,
): T {
	mkdirSync(directory, { recursive: true });
	return withFileLockSync(
		directory,
		() => {
			const ids = new Set<string>();
			for (const name of recordNames(directory)) {
				const id = name.slice(0, -5);
				if (!validId(id)) throw new Error("Invalid Auto Learn accounting identity");
				ids.add(id);
			}
			return operation(ids);
		},
		{ retries: 0, realpath: true },
	);
}

/** An immutable charge receipt outlives its learner, UI session and transient process lease. */
export class AutoLearnAccounting {
	readonly directory: string;
	private readonly workRun: WorkRunLease;
	private readonly warn: (message: string) => void;
	private readonly hasPublishedHandoff: (origin: {
		tenant: string;
		runId: string;
		sessionId: string;
		childSessionId: string;
	}) => boolean;

	constructor(
		directory: string,
		workRun: WorkRunLease,
		warn: (message: string) => void,
		hasPublishedHandoff: AutoLearnAccounting["hasPublishedHandoff"],
	) {
		mkdirSync(directory, { recursive: true });
		this.directory = realpathSync(directory);
		this.workRun = workRun;
		this.warn = warn;
		this.hasPublishedHandoff = hasPublishedHandoff;
	}

	private file(runId: string): string {
		if (!validId(runId)) throw new Error("Invalid Auto Learn accounting run");
		return join(this.directory, `${runId}.json`);
	}

	private read(runId: string): Obligation {
		const value: unknown = JSON.parse(
			readBoundedTextFileSync(this.file(runId), MAX_RECORD_BYTES, "Auto Learn obligation"),
		);
		if (
			!isPlainRecord(value) ||
			value.version !== 1 ||
			value.runId !== runId ||
			!validId(value.tenant) ||
			typeof value.parentSessionId !== "string" ||
			(value.parentSessionFile !== null && typeof value.parentSessionFile !== "string") ||
			typeof value.childSessionId !== "string" ||
			value.workRunPath !== resolve(this.workRun.path) ||
			!isPlainRecord(value.hold) ||
			value.hold.id !== runId ||
			typeof value.hold.token !== "string" ||
			!PHASES.includes(String(value.phase)) ||
			typeof value.host !== "string" ||
			!isOwnerMachineIdField(value.machineId) ||
			(value.pid !== undefined && !isPositiveSafePid(value.pid)) ||
			(value.owner !== undefined && !isProcessOwnerRecord(value.owner)) ||
			(value.ownedAt !== undefined && !Number.isFinite(value.ownedAt)) ||
			(value.phase === "expired" ? !isExpiry(value.expiry) : value.expiry !== undefined) ||
			typeof value.handoffPersisted !== "boolean" ||
			!Number.isFinite(value.cleanupAfter) ||
			Number(value.cleanupAfter) < 0
		)
			throw new Error("Invalid Auto Learn obligation");
		// An expired obligation keeps the shape of the phase it expired from.
		const shape = value.phase === "expired" && isExpiry(value.expiry) ? value.expiry.from : String(value.phase);
		if (!["registering", "prepared", "not_spawned"].includes(shape) && value.pid === undefined)
			throw new Error("Invalid Auto Learn obligation");
		if (shape === "captured" || shape === "confirmed" || value.snapshot !== undefined) {
			if (
				!isPlainRecord(value.snapshot) ||
				typeof value.snapshot.sourceFile !== "string" ||
				dirname(resolve(value.snapshot.sourceFile)) !== this.sessionDirectory(value as unknown as Obligation) ||
				typeof value.snapshot.sourceDigest !== "string" ||
				!/^[a-f0-9]{64}$/.test(value.snapshot.sourceDigest)
			)
				throw new Error("Invalid Auto Learn usage snapshot");
			validateProviderUsage(value.snapshot.usage);
		}
		return value as unknown as Obligation;
	}

	private write(record: Obligation): void {
		const text = JSON.stringify(record);
		if (Buffer.byteLength(text) > MAX_RECORD_BYTES) throw new Error("Auto Learn accounting record exceeds its bound");
		writeFileAtomicSync(this.file(record.runId), text, { mode: 0o600 });
		if (JSON.stringify(this.read(record.runId)) !== text)
			throw new Error("Auto Learn accounting publication changed");
	}

	private locked<T>(operation: () => T): T {
		return withFileLockSync(this.directory, operation, { retries: 0, realpath: true });
	}

	register(input: {
		runId: string;
		tenant: string;
		parentSessionId: string;
		parentSessionFile?: string;
		childSessionId: string;
	}): void {
		this.locked(() => {
			if (!validId(input.tenant) || existsSync(this.file(input.runId)))
				throw new Error("Auto Learn obligation already exists or has invalid identity");
			if (recordNames(this.directory).length >= MAX_OBLIGATIONS)
				throw new Error("Auto Learn accounting capacity reached");
			const hold: WorkRunHold = { id: input.runId, token: randomUUID() };
			// The learner runs on this host: its pid is judged against this host's identity.
			const host = readHostIdentity();
			const record: Obligation = {
				version: 1,
				...input,
				parentSessionFile: input.parentSessionFile ? resolve(input.parentSessionFile) : null,
				workRunPath: resolve(this.workRun.path),
				hold,
				phase: "registering",
				host: host.hostname,
				...(host.machineId !== undefined ? { machineId: host.machineId } : {}),
				owner: ownProcessOwner(),
				ownedAt: Date.now(),
				handoffPersisted: false,
				cleanupAfter: 0,
			};
			// The exact hold identity is durable before any hold is admitted. Registering cannot spawn.
			this.write(record);
			try {
				holdWorkRun(this.workRun, hold);
				this.write({ ...record, phase: "prepared" });
			} catch (error) {
				try {
					this.cancelRecord(this.read(input.runId));
				} catch (cleanupError) {
					throw new AggregateError([error, cleanupError], "Auto Learn registration cleanup remains pending");
				}
				throw error;
			}
		});
	}

	started(runId: string, pid: number): void {
		this.locked(() => {
			const record = this.read(runId);
			if (record.phase !== "prepared" || !Number.isSafeInteger(pid) || pid <= 0)
				throw new Error("Invalid Auto Learn launch transition");
			this.write({ ...record, pid, phase: "running" });
		});
	}

	terminal(runId: string, pid: number, code: number | null): void {
		this.locked(() => {
			const record = this.read(runId);
			if (record.pid !== undefined && record.pid !== pid)
				throw new Error("Auto Learn terminal belongs to another process");
			if (record.phase === "terminal" || record.phase === "captured" || record.phase === "confirmed") return;
			if (record.phase !== "prepared" && record.phase !== "running")
				throw new Error("Auto Learn terminal requires an admitted launch");
			this.write({
				...record,
				pid,
				phase: "terminal",
				cleanupAfter: code === 0 ? 0 : Date.now() + FAILED_EVIDENCE_RETENTION_MS,
			});
		});
	}

	handoffPersisted(runId: string): void {
		this.locked(() => {
			let record: Obligation;
			try {
				record = this.read(runId);
			} catch (error) {
				if (isMissingFileError(error)) return;
				throw error;
			}
			if (!record.handoffPersisted) this.write({ ...record, handoffPersisted: true });
		});
	}

	cancelBeforeSpawn(runId: string): void {
		this.locked(() => {
			const record = this.read(runId);
			if (record.phase !== "prepared" && record.phase !== "registering")
				throw new Error("Cannot cancel a launched accounting obligation");
			this.cancelRecord(record);
		});
	}

	private cancelRecord(record: Obligation): void {
		if (record.phase !== "not_spawned") this.write({ ...record, phase: "not_spawned" });
		releaseWorkRunHold(this.workRun, record.hold);
		unlinkSync(this.file(record.runId));
	}

	async recover(owner: AutoLearnAccountingOwner): Promise<void> {
		let names: string[];
		try {
			names = this.locked(() => recordNames(this.directory));
		} catch (error) {
			this.warn(`Auto Learn accounting remains pending: ${String(error).slice(0, 512)}`);
			return;
		}
		for (const name of names) {
			await setImmediate();
			if (!owner.isCurrent()) return;
			this.deliver(name.slice(0, -5), owner);
		}
	}

	deliver(runId: string, owner: AutoLearnAccountingOwner): void {
		try {
			let record = this.locked(() => this.read(runId));
			if (record.phase === "registering" || record.phase === "not_spawned") {
				this.locked(() => {
					const current = this.read(runId);
					if (current.phase === "registering" || current.phase === "not_spawned") this.cancelRecord(current);
				});
				return;
			}
			if (record.phase === "expired") {
				// A previous expiry stopped after recording it; finish moving it out of the counted namespace.
				this.locked(() => this.settleExpired(this.read(runId)));
				return;
			}
			if (record.parentSessionId !== owner.sessionId) {
				this.expireIfAbandoned(runId);
				return;
			}
			if (record.parentSessionFile !== (owner.sessionFile ? resolve(owner.sessionFile) : null) || !owner.isCurrent())
				return;
			record = this.adopt(runId);
			if (record.phase === "expired") return;
			if (record.phase === "prepared") {
				this.warn(`Auto Learn accounting ${runId} requires launch reconciliation; evidence retained.`);
				return;
			}
			record = this.settleExitedLearner(runId, record);
			if (record.phase === "running") return;
			if (record.phase === "terminal") {
				const snapshot = readAutoLearnUsageSnapshot(this.sessionDirectory(record), record.childSessionId);
				record = this.locked(() => {
					const current = this.read(runId);
					if (current.phase === "terminal") this.write({ ...current, phase: "captured", snapshot });
					return this.read(runId);
				});
			}
			if (record.phase === "captured") {
				if (!owner.isCurrent() || !record.snapshot) return;
				const disposition = owner.deliver(record.snapshot.usage, {
					parentSessionId: record.parentSessionId,
					label: "auto-learn",
					sourceSessionId: record.childSessionId,
					reportId: `auto-learn:${runId}:${record.childSessionId}`,
				});
				if (disposition !== "persisted" || !owner.isCurrent()) return;
				record = this.locked(() => {
					const current = this.read(runId);
					if (current.phase === "captured") this.write({ ...current, phase: "confirmed" });
					return this.read(runId);
				});
			}
			if (
				record.phase === "confirmed" &&
				!record.handoffPersisted &&
				this.hasPublishedHandoff({
					tenant: record.tenant,
					runId,
					sessionId: record.parentSessionId,
					childSessionId: record.childSessionId,
				})
			) {
				this.handoffPersisted(runId);
				record = this.locked(() => this.read(runId));
			}
			if (record.phase === "confirmed" && record.handoffPersisted && Date.now() >= record.cleanupAfter) {
				this.locked(() => {
					const current = this.read(runId);
					if (current.phase !== "confirmed" || !current.handoffPersisted || !owner.isCurrent()) return;
					if (current.snapshot && existsSync(current.snapshot.sourceFile))
						assertAutoLearnUsageSourceCurrent(current.snapshot);
					const tenant = join(this.workRun.path, "tenants", current.tenant);
					for (const artifact of [
						this.sessionDirectory(current),
						join(tenant, `${runId}.log`),
						join(tenant, `${runId}.prompt.md`),
					])
						rmSync(artifact, { force: true, recursive: true });
					releaseWorkRunHold(this.workRun, current.hold);
					unlinkSync(this.file(runId));
				});
			}
		} catch (error) {
			if (!isMissingFileError(error) || existsSync(this.file(runId)))
				this.warn(`Auto Learn accounting ${runId} remains pending: ${String(error).slice(0, 512)}`);
		}
	}

	/**
	 * The live owning session takes custody of its obligation: it becomes `owner` from now on, so no other session can
	 * judge the obligation abandoned while this process lives. Custody is taken under the lock before any delivery, and
	 * an obligation that expired first stays expired.
	 */
	private adopt(runId: string): Obligation {
		return this.locked(() => {
			const current = this.read(runId);
			const self = ownProcessOwner();
			if (current.phase === "expired" || isDeepStrictEqual(current.owner, self)) return current;
			this.write({ ...current, owner: self, ownedAt: Date.now() });
			return this.read(runId);
		});
	}

	/** A `running` learner proven gone (its exit event was lost with its parent) becomes `terminal`. */
	private settleExitedLearner(runId: string, record: Obligation): Obligation {
		if (record.phase !== "running" || record.pid === undefined) return record;
		const learner: ProcessOwner = { pid: record.pid, hostname: record.host, machineId: record.machineId };
		if (!isOwnerProvenDead(learner)) return record;
		this.terminal(runId, record.pid, null);
		return this.locked(() => this.read(runId));
	}

	/**
	 * Abandoned: the session that owns this obligation is gone, so it can never be delivered and must not pin the
	 * obligation capacity. That requires all of: an owner was recorded (or adopted) and is proven dead on this host
	 * (`foreign` and `unknown` keep it), it took custody at least {@link ABANDONED_OBLIGATION_EXPIRY_MS} ago, and the
	 * obligation is in a phase that only its session could still settle.
	 */
	private isAbandoned(record: Obligation, now: number): boolean {
		return (
			isExpirablePhase(record.phase) &&
			record.owner !== undefined &&
			record.ownedAt !== undefined &&
			now - record.ownedAt >= ABANDONED_OBLIGATION_EXPIRY_MS &&
			isOwnerProvenDead(record.owner)
		);
	}

	/**
	 * Settles an abandoned obligation as expired, with its reason and accounting outcome recorded, and moves the receipt
	 * out of the counted namespace. A learner still running (or whose state is unprovable) keeps the obligation open;
	 * a learner that ended has its usage captured first, so the receipt states what went unaccounted.
	 */
	private expireIfAbandoned(runId: string): void {
		let record = this.locked(() => this.read(runId));
		if (!this.isAbandoned(record, Date.now())) return;
		record = this.settleExitedLearner(runId, record);
		if (record.phase === "running") return;
		// The learner ended: its own session file states the usage that will go unaccounted. Evidence that cannot be
		// read is recorded as the reason, never replaced by a guess.
		let snapshot: AutoLearnUsageSnapshot | undefined;
		let captureFailure: string | undefined;
		if (record.phase === "terminal") {
			try {
				snapshot = readAutoLearnUsageSnapshot(this.sessionDirectory(record), record.childSessionId);
			} catch (error) {
				captureFailure = String(error).slice(0, 512);
			}
		}
		this.locked(() => {
			let current = this.read(runId);
			const now = Date.now();
			if (!this.isAbandoned(current, now) || current.phase === "running") return;
			if (current.phase === "terminal") {
				// It became terminal after the evidence read above; the next recovery reads it.
				if (!snapshot && captureFailure === undefined) return;
				if (snapshot) current = { ...current, phase: "captured", snapshot };
			}
			const from = current.phase;
			if (!isExpirablePhase(from)) return;
			const reasons: Record<ExpirablePhase, string> = {
				prepared: "the owning session ended before the learner launch was reconciled",
				running: "the owning session ended while the learner ran",
				terminal: `the owning session ended and the learner usage is unreadable (${captureFailure ?? "no evidence"})`,
				captured: "the owning session ended before the captured learner usage was charged to it",
				confirmed: "the owning session ended before the handoff and cleanup completed",
			};
			const expired: Obligation = {
				...current,
				phase: "expired",
				expiry: { at: now, from, usage: from === "confirmed" ? "delivered" : "unaccounted", reason: reasons[from] },
			};
			this.write(expired);
			this.settleExpired(expired);
		});
	}

	/**
	 * Under the lock: releases an expired obligation's work-run hold and moves its receipt into the bounded expired
	 * ledger. Both steps are idempotent, so an interrupted settlement is finished by the next reader.
	 */
	private settleExpired(record: Obligation): void {
		if (record.phase !== "expired" || !record.expiry) throw new Error("Only an expired obligation can be settled");
		releaseWorkRunHold(this.workRun, record.hold);
		const ledger = join(this.directory, EXPIRED_DIRECTORY);
		mkdirSync(ledger, { recursive: true });
		const receipts = readBoundedDirectoryNamesSync(
			ledger,
			MAX_EXPIRED_RECEIPTS + 16,
			"Auto Learn expired obligations",
		)
			.filter((name) => name.endsWith(".json"))
			.map((name) => ({ name, at: lstatSync(join(ledger, name)).mtimeMs }))
			.sort((left, right) => left.at - right.at);
		for (const oldest of receipts.slice(0, Math.max(0, receipts.length - MAX_EXPIRED_RECEIPTS + 1))) {
			unlinkSync(join(ledger, oldest.name));
			this.warn(
				`Auto Learn expired obligation receipt ${oldest.name.slice(0, -5)} dropped from its bounded ledger.`,
			);
		}
		renameSync(this.file(record.runId), join(ledger, `${record.runId}.json`));
		this.warn(
			`Auto Learn accounting ${record.runId} expired (${record.expiry.usage}): ${record.expiry.reason}. Receipt kept in ${ledger}.`,
		);
	}

	private sessionDirectory(record: Obligation): string {
		return join(this.workRun.path, "tenants", record.tenant, "sessions", record.runId);
	}
}
