import { existsSync, readFileSync } from "node:fs";
import { cpus, totalmem } from "node:os";
import { withFileLockSync, writeFileAtomicSync } from "../util/atomic-file.ts";
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

export interface HostStateStoreOptions<THostData> {
	filePath: string;
	version: number;
	fingerprint?: () => HostFingerprint;
	readOnly?: boolean;
	parseHost(value: unknown, hostId: string): THostData | undefined;
}

/**
 * Freeze a parsed state tree in place so the cached copy handed to readers cannot be mutated by
 * accident: with the parse cache below, readers share one object graph instead of each getting a
 * fresh parse, and a mutation through a shared reference would corrupt what the next write persists.
 * Mutators never see frozen data; they work on a structured clone.
 */
function deepFreeze<T>(value: T): T {
	if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
	Object.freeze(value);
	for (const key of Object.keys(value as object)) deepFreeze((value as Record<string, unknown>)[key]);
	return value;
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

	constructor(options: HostStateStoreOptions<THostData>) {
		this.filePath = options.filePath;
		this.version = options.version;
		this.fingerprint = options.fingerprint ?? currentHostFingerprint;
		this.readOnly = options.readOnly ?? false;
		this.parseHost = options.parseHost;
	}

	private currentHost(): HostFingerprint {
		this.resolvedHost ??= this.fingerprint();
		return this.resolvedHost;
	}

	getHost(hostId = this.currentHost().id): THostData | undefined {
		return this.load().hosts[hostId];
	}

	getAllHosts(): THostData[] {
		return Object.values(this.load().hosts);
	}

	mutateCurrentHost<TResult>(
		create: (host: HostFingerprint) => THostData,
		mutate: (data: THostData, host: HostFingerprint) => HostStateMutation<TResult>,
	): TResult {
		const host = this.currentHost();
		const execute = (): TResult => {
			// A clone, so a mutator that throws halfway leaves the cached tree exactly as persisted.
			const file = structuredClone(this.load());
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

	private load(): HostStateFile<THostData> {
		if (!existsSync(this.filePath)) {
			this.parsed = undefined;
			return { version: this.version, hosts: {} };
		}
		let text: string;
		try {
			text = readFileSync(this.filePath, "utf-8");
		} catch {
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
