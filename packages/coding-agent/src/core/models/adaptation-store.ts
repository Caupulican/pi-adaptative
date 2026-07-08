import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { currentHostFingerprint, type HostFingerprint } from "./fitness-store.ts";

const STORE_VERSION = 1;
const MAX_RULES_PER_MODEL = 5;
const RETIRE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

export interface ModelAdaptationRule {
	mode: string;
	text: string;
	addedAt: string;
	lastFiredAt: string;
}

export type ModelProtocolCalibration =
	| {
			version: number;
			status?: "calibrated";
			variant: string;
			calibratedAt: string;
	  }
	| {
			version: number;
			status: "failed";
			attemptedAt: string;
			variantsTried: string[];
	  };

export type ModelToolProbeVerdict = "native" | "text-protocol" | "none";
export type NativeToolProbeGrade = "task" | "echo-only" | "absent";

export interface ModelToolProbe {
	version: number;
	status: ModelToolProbeVerdict;
	probedAt: string;
	variant?: string;
	nativeGrade?: NativeToolProbeGrade;
	diagnostic?: string;
}

export interface ModelTeachStats {
	taught: number;
	recurrenceBefore: number;
	recurrenceAfter: number;
}

export interface ModelAdaptationProfile {
	rules: ModelAdaptationRule[];
	protocol?: ModelProtocolCalibration;
	toolProbe?: ModelToolProbe;
	teachStats: Record<string, ModelTeachStats>;
}

export interface StoredModelAdaptation {
	model: string;
	profile: ModelAdaptationProfile;
	at: string;
	host: HostFingerprint;
}

interface AdaptationStoreFile {
	version: 1;
	/** hostId -> modelRef -> latest stored adaptation profile. */
	hosts: Record<string, Record<string, StoredModelAdaptation>>;
}

function emptyProfile(): ModelAdaptationProfile {
	return { rules: [], teachStats: {} };
}

function normalizeProfile(profile: Partial<ModelAdaptationProfile> | undefined): ModelAdaptationProfile {
	return {
		rules: Array.isArray(profile?.rules) ? profile.rules.filter(isRule) : [],
		...(isProtocol(profile?.protocol) && { protocol: profile.protocol }),
		...(isToolProbe(profile?.toolProbe) && { toolProbe: profile.toolProbe }),
		teachStats: isRecord(profile?.teachStats) ? filterTeachStats(profile.teachStats) : {},
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRule(value: unknown): value is ModelAdaptationRule {
	return (
		isRecord(value) &&
		typeof value.mode === "string" &&
		typeof value.text === "string" &&
		typeof value.addedAt === "string" &&
		typeof value.lastFiredAt === "string"
	);
}

function isProtocol(value: unknown): value is ModelProtocolCalibration {
	if (!isRecord(value) || typeof value.version !== "number") return false;
	if (value.status === "failed") {
		return (
			typeof value.attemptedAt === "string" &&
			Array.isArray(value.variantsTried) &&
			value.variantsTried.every((variant) => typeof variant === "string")
		);
	}
	return (
		(value.status === undefined || value.status === "calibrated") &&
		typeof value.variant === "string" &&
		typeof value.calibratedAt === "string"
	);
}

function isToolProbe(value: unknown): value is ModelToolProbe {
	return (
		isRecord(value) &&
		typeof value.version === "number" &&
		(value.status === "native" || value.status === "text-protocol" || value.status === "none") &&
		typeof value.probedAt === "string" &&
		(value.variant === undefined || typeof value.variant === "string") &&
		(value.nativeGrade === undefined ||
			value.nativeGrade === "task" ||
			value.nativeGrade === "echo-only" ||
			value.nativeGrade === "absent") &&
		(value.diagnostic === undefined || typeof value.diagnostic === "string")
	);
}

function isTeachStats(value: unknown): value is ModelTeachStats {
	return (
		isRecord(value) &&
		typeof value.taught === "number" &&
		typeof value.recurrenceBefore === "number" &&
		typeof value.recurrenceAfter === "number"
	);
}

function filterTeachStats(value: Record<string, unknown>): Record<string, ModelTeachStats> {
	return Object.fromEntries(
		Object.entries(value).filter((entry): entry is [string, ModelTeachStats] => isTeachStats(entry[1])),
	);
}

function ruleRecency(rule: ModelAdaptationRule): number {
	const lastFired = Date.parse(rule.lastFiredAt);
	if (Number.isFinite(lastFired)) return lastFired;
	const added = Date.parse(rule.addedAt);
	return Number.isFinite(added) ? added : 0;
}

function pruneRetiredRules(rules: readonly ModelAdaptationRule[], now: Date): ModelAdaptationRule[] {
	const cutoff = now.getTime() - RETIRE_AFTER_MS;
	return rules.filter((rule) => ruleRecency(rule) >= cutoff);
}

function enforceRuleCap(rules: readonly ModelAdaptationRule[]): ModelAdaptationRule[] {
	if (rules.length <= MAX_RULES_PER_MODEL) return [...rules];
	return [...rules].sort((a, b) => ruleRecency(b) - ruleRecency(a)).slice(0, MAX_RULES_PER_MODEL);
}

function mergeRule(rules: readonly ModelAdaptationRule[], rule: ModelAdaptationRule): ModelAdaptationRule[] {
	const withoutSameMode = rules.filter((existing) => existing.mode !== rule.mode);
	return enforceRuleCap([...withoutSameMode, rule]);
}

export class ModelAdaptationStore {
	private readonly filePath: string;
	private readonly fingerprint: () => HostFingerprint;

	constructor(filePath: string, options?: { fingerprint?: () => HostFingerprint }) {
		this.filePath = filePath;
		this.fingerprint = options?.fingerprint ?? currentHostFingerprint;
	}

	static forAgentDir(agentDir: string, options?: { fingerprint?: () => HostFingerprint }): ModelAdaptationStore {
		return new ModelAdaptationStore(join(agentDir, "state", "model-adaptation.json"), options);
	}

	private load(): AdaptationStoreFile {
		try {
			if (!existsSync(this.filePath)) return { version: STORE_VERSION, hosts: {} };
			const parsed = JSON.parse(readFileSync(this.filePath, "utf-8")) as AdaptationStoreFile;
			if (parsed && parsed.version === STORE_VERSION && parsed.hosts && typeof parsed.hosts === "object") {
				return parsed;
			}
		} catch {
			// Unreadable/corrupt store: start fresh in memory; the next save rewrites the file.
		}
		return { version: STORE_VERSION, hosts: {} };
	}

	private write(file: AdaptationStoreFile): void {
		mkdirSync(dirname(this.filePath), { recursive: true });
		writeFileSync(this.filePath, `${JSON.stringify(file, null, "\t")}\n`, "utf-8");
	}

	private store(model: string, profile: ModelAdaptationProfile, at: string): StoredModelAdaptation {
		const host = this.fingerprint();
		const entry: StoredModelAdaptation = { model, profile: normalizeProfile(profile), at, host };
		const file = this.load();
		file.hosts[host.id] = { ...(file.hosts[host.id] ?? {}), [model]: entry };
		this.write(file);
		return entry;
	}

	/** Persist the profile for a model on the CURRENT host. Best-effort, returns the entry. */
	save(model: string, profile: ModelAdaptationProfile, at?: string): StoredModelAdaptation {
		return this.store(model, profile, at ?? new Date().toISOString());
	}

	/** Profile for a model on the current host; prunes retired rules before returning. */
	get(model: string, now: Date = new Date()): ModelAdaptationProfile {
		const host = this.fingerprint();
		const file = this.load();
		const entry = file.hosts[host.id]?.[model];
		if (!entry) return emptyProfile();
		const profile = normalizeProfile(entry.profile);
		const prunedRules = pruneRetiredRules(profile.rules, now);
		if (prunedRules.length !== profile.rules.length) {
			return this.store(model, { ...profile, rules: prunedRules }, now.toISOString()).profile;
		}
		return profile;
	}

	/** Add or replace one standing rule, enforcing the per-model cap. */
	addRule(
		model: string,
		rule: { mode: string; text: string; addedAt?: string; lastFiredAt?: string },
		now = new Date(),
	): StoredModelAdaptation {
		const profile = this.get(model, now);
		const at = now.toISOString();
		const nextRule: ModelAdaptationRule = {
			mode: rule.mode,
			text: rule.text,
			addedAt: rule.addedAt ?? at,
			lastFiredAt: rule.lastFiredAt ?? at,
		};
		return this.store(model, { ...profile, rules: mergeRule(profile.rules, nextRule) }, at);
	}

	removeRule(model: string, mode: string, at = new Date()): boolean {
		const profile = this.get(model, at);
		const rules = profile.rules.filter((rule) => rule.mode !== mode);
		if (rules.length === profile.rules.length) return false;
		this.store(model, { ...profile, rules }, at.toISOString());
		return true;
	}

	/** Update last-fired recency for an existing rule. No-op when absent. */
	markRuleFired(model: string, mode: string, at = new Date()): StoredModelAdaptation | undefined {
		const profile = this.get(model, at);
		const rules = profile.rules.map((rule) =>
			rule.mode === mode ? { ...rule, lastFiredAt: at.toISOString() } : rule,
		);
		if (rules.every((rule, index) => rule === profile.rules[index])) return undefined;
		return this.store(model, { ...profile, rules }, at.toISOString());
	}

	setProtocol(model: string, protocol: ModelProtocolCalibration, at?: string): StoredModelAdaptation {
		const now = at ?? (protocol.status === "failed" ? protocol.attemptedAt : protocol.calibratedAt);
		const profile = this.get(model, new Date(now));
		return this.store(model, { ...profile, protocol }, now);
	}

	setToolProbe(model: string, toolProbe: ModelToolProbe, at?: string): StoredModelAdaptation {
		const now = at ?? toolProbe.probedAt;
		const profile = this.get(model, new Date(now));
		return this.store(model, { ...profile, toolProbe }, now);
	}

	removeProtocol(model: string, at = new Date()): boolean {
		const profile = this.get(model, at);
		if (!profile.protocol) return false;
		const { protocol: _protocol, ...rest } = profile;
		this.store(model, rest, at.toISOString());
		return true;
	}

	setTeachStats(model: string, mode: string, stats: ModelTeachStats, at?: string): StoredModelAdaptation {
		const now = at ?? new Date().toISOString();
		const profile = this.get(model, new Date(now));
		return this.store(model, { ...profile, teachStats: { ...profile.teachStats, [mode]: stats } }, now);
	}

	/** Profiles for the current host (default) or an explicit host id. */
	getForHost(hostId?: string): StoredModelAdaptation[] {
		const file = this.load();
		return Object.values(file.hosts[hostId ?? this.fingerprint().id] ?? {}).map((entry) => ({
			...entry,
			profile: normalizeProfile(entry.profile),
		}));
	}

	/** Every stored profile across all hosts (for cross-machine comparisons). */
	getAll(): StoredModelAdaptation[] {
		const file = this.load();
		return Object.values(file.hosts).flatMap((models) =>
			Object.values(models).map((entry) => ({ ...entry, profile: normalizeProfile(entry.profile) })),
		);
	}
}
