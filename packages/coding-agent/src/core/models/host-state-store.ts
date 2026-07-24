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

/** Shared lock-safe, atomic substrate for versioned state partitioned by host fingerprint. */
export class HostStateStore<THostData> {
	private readonly filePath: string;
	private readonly version: number;
	private readonly fingerprint: () => HostFingerprint;
	private readonly readOnly: boolean;
	private readonly parseHost: (value: unknown, hostId: string) => THostData | undefined;

	constructor(options: HostStateStoreOptions<THostData>) {
		this.filePath = options.filePath;
		this.version = options.version;
		this.fingerprint = options.fingerprint ?? currentHostFingerprint;
		this.readOnly = options.readOnly ?? false;
		this.parseHost = options.parseHost;
	}

	private currentHost(): HostFingerprint {
		return this.fingerprint();
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
			const file = this.load();
			const data = file.hosts[host.id] ?? create(host);
			file.hosts[host.id] = data;
			const mutation = mutate(data, host);
			if (mutation.changed && !this.readOnly) {
				writeFileAtomicSync(this.filePath, `${JSON.stringify(file, null, "\t")}\n`);
			}
			return mutation.result;
		};
		return this.readOnly ? execute() : withFileLockSync(this.filePath, execute);
	}

	private load(): HostStateFile<THostData> {
		if (!existsSync(this.filePath)) return { version: this.version, hosts: {} };
		try {
			const parsed: unknown = JSON.parse(readFileSync(this.filePath, "utf-8"));
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
