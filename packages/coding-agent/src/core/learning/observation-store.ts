import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Durable, BOUNDED evidence-strength store for the learning gate (G6). The gate auto-applies a
 * durable change only once it has been *observed* enough times; a single reflection pass sees a
 * lesson once, so without persistence every proposal would look brand-new and never accumulate the
 * repeated evidence the gate requires. This store counts how many times the SAME lesson (keyed by
 * its durable layer + normalized summary) has been proposed across passes and sessions.
 *
 * File layout mirrors {@link ../models/fitness-store.ts}: a versioned JSON object under
 * `<agentDir>/state/`, best-effort writes, and a corrupt/missing file recovers as a fresh store.
 */

/** Cap per-key counts so a hot lesson can't grow unbounded (the gate only needs a small threshold). */
const MAX_COUNT = 100;
/** Cap the number of tracked keys; least-recently-incremented keys are evicted past this bound. */
const MAX_KEYS = 500;

interface ObservationEntry {
	count: number;
	/** ISO timestamp of the most recent increment; drives least-recently-incremented eviction. */
	lastAt: string;
}

interface ObservationStoreFile {
	version: 1;
	/** observationKey -> accumulated evidence for that lesson. */
	observations: Record<string, ObservationEntry>;
}

/**
 * Stable evidence key for a durable-change proposal: sha256 of the layer plus its summary,
 * lowercased and whitespace-collapsed, truncated to 24 hex chars. Normalization means the same
 * lesson re-observed with reworded whitespace/casing accumulates onto one key instead of scattering.
 */
export function observationKey(layer: string, summary: string): string {
	const normalized = summary.toLowerCase().replace(/\s+/g, " ").trim();
	return createHash("sha256").update(`${layer}\n${normalized}`).digest("hex").slice(0, 24);
}

export class ObservationStore {
	private readonly filePath: string;

	constructor(filePath: string) {
		this.filePath = filePath;
	}

	static forAgentDir(agentDir: string): ObservationStore {
		return new ObservationStore(join(agentDir, "state", "learning-observations.json"));
	}

	private load(): ObservationStoreFile {
		try {
			if (!existsSync(this.filePath)) return { version: 1, observations: {} };
			const parsed = JSON.parse(readFileSync(this.filePath, "utf-8")) as ObservationStoreFile;
			if (
				parsed &&
				parsed.version === 1 &&
				parsed.observations &&
				typeof parsed.observations === "object" &&
				!Array.isArray(parsed.observations)
			) {
				// Sanitize per-entry so a partially-mangled file still yields a usable store rather than
				// leaking NaN/undefined counts into the gate.
				const clean: ObservationStoreFile = { version: 1, observations: {} };
				for (const [key, value] of Object.entries(parsed.observations)) {
					if (
						value &&
						typeof value === "object" &&
						typeof (value as ObservationEntry).count === "number" &&
						Number.isFinite((value as ObservationEntry).count) &&
						typeof (value as ObservationEntry).lastAt === "string"
					) {
						clean.observations[key] = {
							count: Math.min(Math.max(0, Math.floor((value as ObservationEntry).count)), MAX_COUNT),
							lastAt: (value as ObservationEntry).lastAt,
						};
					}
				}
				return clean;
			}
		} catch {
			// Unreadable/corrupt store: start fresh in memory; the next increment rewrites the file.
		}
		return { version: 1, observations: {} };
	}

	private save(file: ObservationStoreFile): void {
		mkdirSync(dirname(this.filePath), { recursive: true });
		writeFileSync(this.filePath, `${JSON.stringify(file, null, "\t")}\n`, "utf-8");
	}

	/** Evict least-recently-incremented keys until the store is back within {@link MAX_KEYS}. */
	private evict(file: ObservationStoreFile): void {
		const keys = Object.keys(file.observations);
		if (keys.length <= MAX_KEYS) return;
		keys.sort((a, b) => {
			const la = file.observations[a]!.lastAt;
			const lb = file.observations[b]!.lastAt;
			return la < lb ? -1 : la > lb ? 1 : 0;
		});
		for (const key of keys.slice(0, keys.length - MAX_KEYS)) {
			delete file.observations[key];
		}
	}

	/** Record one more observation of `key` and return the new (capped) count. */
	increment(key: string, at?: string): number {
		const file = this.load();
		const now = at ?? new Date().toISOString();
		const count = Math.min((file.observations[key]?.count ?? 0) + 1, MAX_COUNT);
		file.observations[key] = { count, lastAt: now };
		this.evict(file);
		this.save(file);
		return count;
	}

	/** Current observation count for `key` (0 if never observed). */
	get(key: string): number {
		return this.load().observations[key]?.count ?? 0;
	}
}
