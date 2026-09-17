import { readFileSync } from "node:fs";
import { cpus, totalmem } from "node:os";
import { withFileLockSync, writeFileAtomicSync } from "../util/atomic-file.ts";
import { deepFreeze } from "../util/deep-freeze.ts";
import { isMissingPathError } from "../util/filesystem-errors.ts";
import { isPlainRecord } from "../util/value-guards.ts";

export interface HostFingerprint {
	id: string;
	cpu: string;
	cores: number;
	totalMemGb: number;
}

export function currentHostFingerprint(): HostFingerprint {
	const cpuList = cpus();
	const cpu = (cpuList[0]?.model ?? "unknown-cpu").trim();
	const cores = Math.max(1, cpuList.length);
	const totalMemGb = Math.round(totalmem() / 1024 ** 3);
	const id = `${cpu
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 48)}-${cores}c-${totalMemGb}g`;
	return { id, cpu, cores, totalMemGb };
}

export function isHostFingerprint(value: unknown): value is HostFingerprint {
	return (
		isPlainRecord(value) &&
		typeof value.id === "string" &&
		value.id.length > 0 &&
		typeof value.cpu === "string" &&
		Number.isSafeInteger(value.cores) &&
		Number(value.cores) > 0 &&
		typeof value.totalMemGb === "number" &&
		Number.isFinite(value.totalMemGb) &&
		value.totalMemGb >= 0
	);
}

interface HostStateFile<THostData> {
	version: number;
	hosts: Record<string, THostData>;
}

export interface HostStateMutation<TResult> {
	result: TResult;
	changed: boolean;
}

export interface HostStateWriteBehindOptions {
	/** Idle time after the last mutation before pending mutations are flushed (default 250ms). */
	debounceMs?: number;
	/** Pending mutations that force a flush regardless of idleness (default 64). */
	maxPending?: number;
}

export interface HostStateStoreOptions<THostData> {
	filePath: string;
	version: number;
	fingerprint?: () => HostFingerprint;
	readOnly?: boolean;
	parseHost(value: unknown, hostId: string): THostData | undefined;
	/**
	 * Apply mutations in memory immediately and persist them in batches (see
	 * {@link HostStateStore.flush}) instead of one durable transaction per mutation. For stores
	 * mutated on every tool call whose contents are advisory statistics; readers in this process see
	 * every mutation at once, other processes see them at the next flush.
	 */
	writeBehind?: HostStateWriteBehindOptions;
}

const DEFAULT_WRITE_BEHIND_DEBOUNCE_MS = 250;
const DEFAULT_WRITE_BEHIND_MAX_PENDING = 64;

/** Every pending-write flush a process exit must run for owners that did not get to close. */
const exitFlushes = new Set<() => void>();
let exitFlushInstalled = false;

/** Run `flush` at process exit until the returned unregister is called. Synchronous flushes only. */
export function registerProcessExitFlush(flush: () => void): () => void {
	exitFlushes.add(flush);
	if (!exitFlushInstalled) {
		exitFlushInstalled = true;
		process.on("exit", () => {
			for (const pending of exitFlushes) {
				try {
					pending();
				} catch {
					// Exit is not the place to fail; the durable file keeps its last flushed state.
				}
			}
		});
	}
	return () => {
		exitFlushes.delete(flush);
	};
}

/** Shared lock-safe, atomic substrate for versioned state partitioned by host fingerprint. */
export class HostStateStore<THostData> {
	private readonly filePath: string;
	private readonly version: number;
	private readonly fingerprint: () => HostFingerprint;
	private readonly readOnly: boolean;
	private readonly parseHost: (value: unknown, hostId: string) => THostData | undefined;
	/**
	 * The host this process runs on does not change while it runs, but `currentHostFingerprint`
	 * asks the OS for its CPU list every time -- measured at 4% of host CPU across a 1,500-turn
	 * session, because every tool call resolves the host two or three times. Resolved once.
	 */
	private resolvedHost: HostFingerprint | undefined;
	/**
	 * The file text this instance last parsed or wrote, with the state it stands for. Every read
	 * re-parses the whole file and every reader re-validates every host record; a tool-performance
	 * file re-encodes up to a thousand observations per parse. Nearly every read follows this
	 * instance's own write, so the file text is compared to the text last seen and the parse is
	 * skipped when they are identical. Exact text comparison, so another process writing the same
	 * host file is always parsed fresh. The cached tree is deep-frozen and shared with readers;
	 * mutators work on a structured clone of it, and a mutation ends with the clone frozen and cached
	 * as what was written.
	 */
	private parsed: { readonly text: string; readonly file: HostStateFile<THostData> } | undefined;
	private readonly writeBehind: Required<HostStateWriteBehindOptions> | undefined;
	/**
	 * Write-behind state. `working` is the mutable tree every pending mutation has been applied to
	 * -- what this process reads while mutations are pending -- and `pending` is the replay log of
	 * those mutations, in order, so a flush can re-apply them onto a file another process changed in
	 * the meantime. Persisting the batch is therefore exactly equivalent to having run each
	 * mutation as its own transaction after that other process's writes.
	 */
	private working: HostStateFile<THostData> | undefined;
	/** Disk snapshot from which working was cloned; a failed flush must not advance it. */
	private workingBaseText: string | undefined;
	private pending: Array<{
		create: (host: HostFingerprint) => THostData;
		mutate: (data: THostData, host: HostFingerprint) => HostStateMutation<unknown>;
	}> = [];
	private flushTimer: NodeJS.Timeout | undefined;
	private closed = false;
	private unregisterExitFlush: (() => void) | undefined;

	constructor(options: HostStateStoreOptions<THostData>) {
		this.filePath = options.filePath;
		this.version = options.version;
		this.fingerprint = options.fingerprint ?? currentHostFingerprint;
		this.readOnly = options.readOnly ?? false;
		this.parseHost = options.parseHost;
		this.writeBehind =
			options.writeBehind && !this.readOnly
				? {
						debounceMs: options.writeBehind.debounceMs ?? DEFAULT_WRITE_BEHIND_DEBOUNCE_MS,
						maxPending: options.writeBehind.maxPending ?? DEFAULT_WRITE_BEHIND_MAX_PENDING,
					}
				: undefined;
		if (this.writeBehind) this.unregisterExitFlush = registerProcessExitFlush(() => this.flush());
	}

	private currentHost(): HostFingerprint {
		this.resolvedHost ??= this.fingerprint();
		return this.resolvedHost;
	}

	getHost(hostId = this.currentHost().id): THostData | undefined {
		return this.readableState().hosts[hostId];
	}

	getAllHosts(): THostData[] {
		return Object.values(this.readableState().hosts);
	}

	private readableState(): HostStateFile<THostData> {
		return this.working ?? (this.pending.length > 0 ? this.ensureWorkingState() : this.load());
	}

	private ensureWorkingState(): HostStateFile<THostData> {
		if (!this.working) {
			// Rejection must not make an admitted batch depend on another disk read. Its
			// original snapshot remains authoritative for local reads until flush rebases it.
			const replaying = this.pending.length > 0;
			const current = replaying
				? this.workingBaseText === undefined
					? { version: this.version, hosts: {} }
					: this.parseFile(this.workingBaseText)
				: this.load("mutation");
			const baseText = replaying ? this.workingBaseText : this.parsed?.text;
			const next = this.replayPending(current, this.currentHost());
			this.working = next;
			this.workingBaseText = baseText;
		}
		return this.working;
	}

	private discardWorkingState(): void {
		this.working = undefined;
		if (this.pending.length === 0) this.workingBaseText = undefined;
	}

	private replayPending(file: HostStateFile<THostData>, host: HostFingerprint): HostStateFile<THostData> {
		const next = structuredClone(file);
		for (const mutation of this.pending) {
			const data = next.hosts[host.id] ?? mutation.create(host);
			next.hosts[host.id] = data;
			mutation.mutate(data, host);
		}
		return next;
	}

	mutateCurrentHost<TResult>(
		create: (host: HostFingerprint) => THostData,
		mutate: (data: THostData, host: HostFingerprint) => HostStateMutation<TResult>,
	): TResult {
		const host = this.currentHost();
		if (this.writeBehind && !this.closed) {
			// A failed cap-triggered flush retains its batch. Do not grow that replay log or
			// mutate its working tree again until the already-admitted batch can be persisted.
			if (this.pending.length >= this.writeBehind.maxPending) this.flush();
			// Successful admissions share one batch clone. A failed callback invalidates it;
			// the next read or admission rebuilds from durable state plus accepted mutations.
			const working = this.ensureWorkingState();
			let mutation: HostStateMutation<TResult>;
			try {
				const data = working.hosts[host.id] ?? create(host);
				working.hosts[host.id] = data;
				mutation = mutate(data, host);
			} catch (error) {
				this.discardWorkingState();
				throw error;
			}
			if (!mutation.changed) {
				this.discardWorkingState();
				return mutation.result;
			}
			this.pending.push({ create, mutate });
			if (this.pending.length >= this.writeBehind.maxPending) this.flush();
			else this.scheduleFlush();
			return mutation.result;
		}
		const execute = (): TResult => {
			// A clone, so a mutator that throws halfway leaves the cached tree exactly as persisted.
			const file = structuredClone(this.load(this.readOnly ? "read" : "mutation"));
			const data = file.hosts[host.id] ?? create(host);
			file.hosts[host.id] = data;
			const mutation = mutate(data, host);
			if (mutation.changed && !this.readOnly) {
				const text = `${JSON.stringify(file)}\n`;
				writeFileAtomicSync(this.filePath, text);
				this.parsed = { text, file: deepFreeze(file) };
			}
			return mutation.result;
		};
		return this.readOnly ? execute() : withFileLockSync(this.filePath, execute);
	}

	/**
	 * Persist every pending write-behind mutation in ONE transaction. Under the lock the file is
	 * re-read: unchanged since this store last saw it, the working tree is what would have been
	 * written by the individual transactions and is written as-is; changed by another process, the
	 * pending mutations are replayed in order onto the fresh state, which is what the individual
	 * transactions would have produced had they run after that process's writes. No-op when nothing
	 * is pending. Synchronous, so it is safe from an `exit` handler.
	 */
	flush(): void {
		if (this.flushTimer) {
			clearTimeout(this.flushTimer);
			this.flushTimer = undefined;
		}
		if (this.pending.length === 0) {
			this.discardWorkingState();
			return;
		}
		const working = this.working;
		const host = this.currentHost();
		// Pending state is cleared only after the write succeeded; a failed flush keeps every
		// mutation queued for the next attempt. Synchronous throughout, so nothing interleaves.
		withFileLockSync(this.filePath, () => {
			const current = this.load("mutation");
			let next: HostStateFile<THostData>;
			if (working && this.parsed?.text === this.workingBaseText) {
				next = working;
			} else {
				next = this.replayPending(current, host);
			}
			const text = `${JSON.stringify(next)}\n`;
			writeFileAtomicSync(this.filePath, text);
			this.parsed = { text, file: deepFreeze(next) };
		});
		this.pending = [];
		this.discardWorkingState();
	}

	/** Flush pending mutations and stop batching; later mutations persist one transaction each. */
	close(): void {
		// A failed close retains batching and its exit hook until the batch is durable.
		this.flush();
		this.closed = true;
		this.unregisterExitFlush?.();
		this.unregisterExitFlush = undefined;
	}

	private scheduleFlush(): void {
		if (!this.writeBehind || this.flushTimer) return;
		this.flushTimer = setTimeout(() => {
			this.flushTimer = undefined;
			try {
				this.flush();
			} catch {
				// A failed batch flush keeps its mutations pending for the next flush.
			}
		}, this.writeBehind.debounceMs);
		this.flushTimer.unref?.();
	}

	private load(access: "read" | "mutation" = "read"): HostStateFile<THostData> {
		let text: string;
		try {
			text = readFileSync(this.filePath, "utf-8");
		} catch (error) {
			// Advisory reads may fall back, but a write must not treat unreadable state as absent.
			if (access === "mutation" && !isMissingPathError(error)) throw error;
			this.parsed = undefined;
			return { version: this.version, hosts: {} };
		}
		if (this.parsed?.text === text) return this.parsed.file;
		const file = deepFreeze(this.parseFile(text));
		this.parsed = { text, file };
		return file;
	}

	private parseFile(text: string): HostStateFile<THostData> {
		try {
			const parsed: unknown = JSON.parse(text);
			if (!isPlainRecord(parsed) || parsed.version !== this.version || !isPlainRecord(parsed.hosts)) {
				return { version: this.version, hosts: {} };
			}
			const hosts: Record<string, THostData> = {};
			for (const [hostId, value] of Object.entries(parsed.hosts)) {
				const host = this.parseHost(value, hostId);
				if (host !== undefined) hosts[hostId] = host;
			}
			return { version: this.version, hosts };
		} catch {
			return { version: this.version, hosts: {} };
		}
	}
}
