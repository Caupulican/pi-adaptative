import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, realpathSync, rmSync, unlinkSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setImmediate } from "node:timers/promises";
import type { Usage } from "@caupulican/pi-ai";
import { probeProcessLiveness } from "../../kernel/reliability/process-tree.ts";
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

export interface AutoLearnAccountingOwner {
	sessionId: string;
	sessionFile: string | undefined;
	isCurrent(): boolean;
	deliver(usage: Usage, options: SpawnedUsageReceiptOptions): SpawnedUsageReceiptDisposition;
}

interface Obligation {
	version: 1;
	runId: string;
	tenant: string;
	parentSessionId: string;
	parentSessionFile: string | null;
	childSessionId: string;
	workRunPath: string;
	hold: WorkRunHold;
	phase: "registering" | "prepared" | "not_spawned" | "running" | "terminal" | "captured" | "confirmed";
	host: string;
	pid?: number;
	handoffPersisted: boolean;
	cleanupAfter: number;
	snapshot?: AutoLearnUsageSnapshot;
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
			!["registering", "prepared", "not_spawned", "running", "terminal", "captured", "confirmed"].includes(
				String(value.phase),
			) ||
			typeof value.host !== "string" ||
			(value.pid !== undefined && (!Number.isSafeInteger(value.pid) || Number(value.pid) <= 0)) ||
			(!["registering", "prepared", "not_spawned"].includes(String(value.phase)) && value.pid === undefined) ||
			typeof value.handoffPersisted !== "boolean" ||
			!Number.isFinite(value.cleanupAfter) ||
			Number(value.cleanupAfter) < 0
		)
			throw new Error("Invalid Auto Learn obligation");
		if (value.phase === "captured" || value.phase === "confirmed") {
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
			const record: Obligation = {
				version: 1,
				...input,
				parentSessionFile: input.parentSessionFile ? resolve(input.parentSessionFile) : null,
				workRunPath: resolve(this.workRun.path),
				hold,
				phase: "registering",
				host: hostname(),
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
			if (
				record.parentSessionId !== owner.sessionId ||
				record.parentSessionFile !== (owner.sessionFile ? resolve(owner.sessionFile) : null) ||
				!owner.isCurrent()
			)
				return;
			if (record.phase === "prepared") {
				this.warn(`Auto Learn accounting ${runId} requires launch reconciliation; evidence retained.`);
				return;
			}
			if (record.phase === "running") {
				if (record.host !== hostname() || record.pid === undefined || probeProcessLiveness(record.pid) !== "dead")
					return;
				this.terminal(runId, record.pid, null);
				record = this.locked(() => this.read(runId));
			}
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

	private sessionDirectory(record: Obligation): string {
		return join(this.workRun.path, "tenants", record.tenant, "sessions", record.runId);
	}
}
