import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { cpus, totalmem } from "node:os";
import { dirname, join } from "node:path";
import type { ModelFitnessReport } from "../research/model-fitness.ts";

/**
 * Durable, HOST-KEYED storage for model fitness reports. Fitness is a property of a model ON a
 * host (tok/s and latency-driven failures do not travel between machines), so reports are keyed
 * by a hardware fingerprint: the same model can be "the heavy lifter" on one machine and
 * "waiting for better hardware" on another, and pi remembers both without confusing them —
 * including when settings/dotfiles are synced across machines.
 */

export interface HostFingerprint {
	/** Stable, human-readable id derived from the specs below. */
	id: string;
	cpu: string;
	cores: number;
	totalMemGb: number;
}

export function currentHostFingerprint(): HostFingerprint {
	const cpuList = cpus();
	const cpu = (cpuList[0]?.model ?? "unknown-cpu").trim();
	const cores = cpuList.length;
	const totalMemGb = Math.round(totalmem() / 1024 ** 3);
	const id = `${cpu
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 48)}-${cores}c-${totalMemGb}g`;
	return { id, cpu, cores, totalMemGb };
}

export interface StoredFitnessReport {
	model: string;
	report: ModelFitnessReport;
	at: string;
	host: HostFingerprint;
}

interface FitnessStoreFile {
	version: 1;
	/** hostId -> modelRef -> latest stored report. */
	hosts: Record<string, Record<string, StoredFitnessReport>>;
}

export class FitnessStore {
	private readonly filePath: string;
	private readonly fingerprint: () => HostFingerprint;

	constructor(filePath: string, options?: { fingerprint?: () => HostFingerprint }) {
		this.filePath = filePath;
		this.fingerprint = options?.fingerprint ?? currentHostFingerprint;
	}

	static forAgentDir(agentDir: string, options?: { fingerprint?: () => HostFingerprint }): FitnessStore {
		return new FitnessStore(join(agentDir, "state", "model-fitness.json"), options);
	}

	private load(): FitnessStoreFile {
		try {
			if (!existsSync(this.filePath)) return { version: 1, hosts: {} };
			const parsed = JSON.parse(readFileSync(this.filePath, "utf-8")) as FitnessStoreFile;
			if (parsed && parsed.version === 1 && parsed.hosts && typeof parsed.hosts === "object") {
				return parsed;
			}
		} catch {
			// Unreadable/corrupt store: start fresh in memory; the next save rewrites the file.
		}
		return { version: 1, hosts: {} };
	}

	/** Persist the latest report for a model on the CURRENT host. Best-effort, returns the entry. */
	save(model: string, report: ModelFitnessReport, at?: string): StoredFitnessReport {
		const host = this.fingerprint();
		const entry: StoredFitnessReport = { model, report, at: at ?? new Date().toISOString(), host };
		const file = this.load();
		file.hosts[host.id] = { ...(file.hosts[host.id] ?? {}), [model]: entry };
		mkdirSync(dirname(this.filePath), { recursive: true });
		writeFileSync(this.filePath, `${JSON.stringify(file, null, "\t")}\n`, "utf-8");
		return entry;
	}

	/** Drop a model's report for the CURRENT host (uninstall cleanup). No-op when absent. */
	remove(model: string): void {
		const host = this.fingerprint();
		const file = this.load();
		if (!file.hosts[host.id]?.[model]) return;
		delete file.hosts[host.id][model];
		mkdirSync(dirname(this.filePath), { recursive: true });
		writeFileSync(this.filePath, `${JSON.stringify(file, null, "\t")}\n`, "utf-8");
	}

	/** Reports for the current host (default) or an explicit host id. */
	getForHost(hostId?: string): StoredFitnessReport[] {
		const file = this.load();
		return Object.values(file.hosts[hostId ?? this.fingerprint().id] ?? {});
	}

	/** Every stored report across all hosts (for cross-machine comparisons). */
	getAll(): StoredFitnessReport[] {
		const file = this.load();
		return Object.values(file.hosts).flatMap((models) => Object.values(models));
	}
}
