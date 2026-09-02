import { stateFile } from "../agent-paths.ts";
import { type CapabilityTierDemotion, isCapabilityTierDemotion } from "../capability-tier.ts";
import { isWorkerSession } from "../session-role.ts";

const DEFERRED_PERF_SAMPLE_IDLE_MS = 2_000;
const DEFERRED_PERF_SAMPLE_CAP = 16;

import { isRecordObject } from "../util/value-guards.ts";
import {
	type HostFingerprint,
	HostStateStore,
	isHostFingerprint,
	registerProcessExitFlush,
} from "./host-state-store.ts";
import {
	hasUsableModelPerfSample,
	isModelPerfProfile,
	type ModelPerfProfile,
	type ModelPerfSample,
	updateModelPerfProfile,
} from "./perf-profile.ts";

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
	perf?: ModelPerfProfile;
	/** Evidence-driven capability tier demotion; see capability-tier.ts. Absent = frontier. */
	capabilityTier?: CapabilityTierDemotion;
	teachStats: Record<string, ModelTeachStats>;
}

export interface StoredModelAdaptation {
	model: string;
	profile: ModelAdaptationProfile;
	at: string;
	host: HostFingerprint;
}

interface ProfileMutation {
	profile: ModelAdaptationProfile;
	entry?: StoredModelAdaptation;
	applied: boolean;
}

function emptyProfile(): ModelAdaptationProfile {
	return { rules: [], teachStats: {} };
}

function normalizeProfile(profile: Partial<ModelAdaptationProfile> | undefined): ModelAdaptationProfile {
	return {
		rules: Array.isArray(profile?.rules) ? profile.rules.filter(isRule) : [],
		...(isProtocol(profile?.protocol) && { protocol: profile.protocol }),
		...(isToolProbe(profile?.toolProbe) && { toolProbe: profile.toolProbe }),
		...(isModelPerfProfile(profile?.perf) && { perf: profile.perf }),
		...(isCapabilityTierDemotion(profile?.capabilityTier) && { capabilityTier: profile.capabilityTier }),
		teachStats: isRecordObject(profile?.teachStats) ? filterTeachStats(profile.teachStats) : {},
	};
}

function isRule(value: unknown): value is ModelAdaptationRule {
	return (
		isRecordObject(value) &&
		typeof value.mode === "string" &&
		typeof value.text === "string" &&
		typeof value.addedAt === "string" &&
		typeof value.lastFiredAt === "string"
	);
}

function isProtocol(value: unknown): value is ModelProtocolCalibration {
	if (!isRecordObject(value) || typeof value.version !== "number") return false;
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
		isRecordObject(value) &&
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
		isRecordObject(value) &&
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

/**
 * Minimum post-rule recurrences before efficacy can retire a rule early — a single relapse is
 * noise, not proof the rule stopped working.
 */
const MIN_RECURRENCE_AFTER_FOR_EFFICACY = 2;

/**
 * Efficacy-based early retirement. `agent-session.ts`'s `_handleModelAdaptationTelemetry` bumps
 * `recurrenceBefore` each time a failure mode recurs BEFORE a standing rule exists for it (the
 * baseline that earned the rule), then switches to bumping `recurrenceAfter` each time the SAME mode
 * recurs AFTER the rule fired. So a rule that is actually working keeps `recurrenceAfter` low relative
 * to its own pre-rule baseline; a rule that has caught up to (or exceeded) that baseline has
 * demonstrably stopped reducing recurrence and should retire before the time-based outer bound.
 */
function isRuleEffective(stats: ModelTeachStats | undefined): boolean {
	if (!stats || stats.recurrenceAfter < MIN_RECURRENCE_AFTER_FOR_EFFICACY) return true; // not enough post-rule evidence yet
	return stats.recurrenceAfter < stats.recurrenceBefore;
}

/**
 * Prune rules past the time-based outer bound (`RETIRE_AFTER_MS`, always enforced) OR past efficacy
 * (a rule that stopped reducing recurrence retires early; a rule that keeps helping persists until
 * the outer bound).
 */
function pruneRetiredRules(
	rules: readonly ModelAdaptationRule[],
	teachStats: Record<string, ModelTeachStats>,
	now: Date,
): ModelAdaptationRule[] {
	const cutoff = now.getTime() - RETIRE_AFTER_MS;
	return rules.filter((rule) => ruleRecency(rule) >= cutoff && isRuleEffective(teachStats[rule.mode]));
}

function enforceRuleCap(rules: readonly ModelAdaptationRule[]): ModelAdaptationRule[] {
	if (rules.length <= MAX_RULES_PER_MODEL) return [...rules];
	return [...rules].sort((a, b) => ruleRecency(b) - ruleRecency(a)).slice(0, MAX_RULES_PER_MODEL);
}

function mergeRule(rules: readonly ModelAdaptationRule[], rule: ModelAdaptationRule): ModelAdaptationRule[] {
	const withoutSameMode = rules.filter((existing) => existing.mode !== rule.mode);
	return enforceRuleCap([...withoutSameMode, rule]);
}

function parseAdaptationHost(value: unknown, hostId: string): Record<string, StoredModelAdaptation> | undefined {
	if (!isRecordObject(value)) return undefined;
	const profiles: Record<string, StoredModelAdaptation> = {};
	for (const [model, candidate] of Object.entries(value)) {
		if (
			!isRecordObject(candidate) ||
			candidate.model !== model ||
			typeof candidate.at !== "string" ||
			!isHostFingerprint(candidate.host) ||
			candidate.host.id !== hostId ||
			!isRecordObject(candidate.profile)
		)
			continue;
		profiles[model] = {
			model,
			profile: normalizeProfile(candidate.profile),
			at: candidate.at,
			host: candidate.host,
		};
	}
	return profiles;
}

export class ModelAdaptationStore {
	private readonly storage: HostStateStore<Record<string, StoredModelAdaptation>>;

	/**
	 * Perf samples waiting to be folded into their model's profile, per model, in arrival order.
	 *
	 * Every other mutation here (a tool-probe verdict, a protocol change, a rule) persists at once,
	 * because readers open their own store instances and expect to see it -- the capability gate
	 * reads a verdict through a fresh instance right after it is graded. A perf sample arrives per
	 * provider stream, is advisory, and read only for estimates, so the owning session may defer
	 * those: they fold into one transaction after a short idle, at a cap, before any other mutation
	 * of this instance (so ordering holds), at close, and at process exit. Folding N samples in one
	 * transaction produces the profile N transactions would have.
	 */
	private readonly pendingPerf = new Map<string, Array<{ sample: ModelPerfSample; at: string }>>();
	private pendingPerfCount = 0;
	private perfFlushTimer: NodeJS.Timeout | undefined;
	private readonly deferPerfSamples: boolean;
	private unregisterExitFlush: (() => void) | undefined;
	private closed = false;

	constructor(
		filePath: string,
		options?: { fingerprint?: () => HostFingerprint; readOnly?: boolean; deferPerfSamples?: boolean },
	) {
		const readOnly = options?.readOnly ?? isWorkerSession();
		this.storage = new HostStateStore({
			filePath,
			version: STORE_VERSION,
			fingerprint: options?.fingerprint,
			readOnly,
			parseHost: parseAdaptationHost,
		});
		this.deferPerfSamples = options?.deferPerfSamples === true && !readOnly;
		if (this.deferPerfSamples) this.unregisterExitFlush = registerProcessExitFlush(() => this.flush());
	}

	static forAgentDir(
		agentDir: string,
		options?: { fingerprint?: () => HostFingerprint; readOnly?: boolean; deferPerfSamples?: boolean },
	): ModelAdaptationStore {
		return new ModelAdaptationStore(stateFile(agentDir, "model-adaptation.json"), options);
	}

	/** Fold every deferred perf sample into its profile now, one transaction per model. */
	flush(): void {
		if (this.perfFlushTimer) {
			clearTimeout(this.perfFlushTimer);
			this.perfFlushTimer = undefined;
		}
		if (this.pendingPerfCount === 0) return;
		const pending = [...this.pendingPerf.entries()];
		this.pendingPerf.clear();
		this.pendingPerfCount = 0;
		for (const [model, samples] of pending) {
			const last = samples[samples.length - 1]!;
			this.mutateProfile(
				model,
				new Date(last.at),
				(profile) => {
					let perf = profile.perf;
					let changed = false;
					for (const { sample, at } of samples) {
						const next = updateModelPerfProfile(perf, sample, at);
						if (next) {
							perf = next;
							changed = true;
						}
					}
					return changed ? { ...profile, perf } : undefined;
				},
				last.at,
			);
		}
	}

	/** Flush deferred perf samples and stop deferring; the owning session calls it on dispose. */
	close(): void {
		this.closed = true;
		this.unregisterExitFlush?.();
		this.unregisterExitFlush = undefined;
		this.flush();
	}

	/**
	 * Load-mutate-write under a single exclusive lock so two concurrent stores (e.g. two sessions
	 * sharing an agentDir) can't both read the old file and clobber each other's write.
	 */
	private store(model: string, profile: ModelAdaptationProfile, at: string): StoredModelAdaptation {
		return this.storage.mutateCurrentHost(
			() => ({}),
			(profiles, host) => {
				const entry: StoredModelAdaptation = { model, profile: normalizeProfile(profile), at, host };
				profiles[model] = entry;
				return { result: entry, changed: true };
			},
		);
	}

	/** Keep the complete profile read-modify-write transaction under the host-state lock. */
	private mutateProfile(
		model: string,
		now: Date,
		mutate: (profile: ModelAdaptationProfile) => ModelAdaptationProfile | undefined,
		storedAt = now.toISOString(),
	): ProfileMutation {
		// Deferred perf samples for this model fold in first, so this mutation sees and keeps them.
		if (this.pendingPerf.has(model)) {
			const samples = this.pendingPerf.get(model) ?? [];
			this.pendingPerf.delete(model);
			this.pendingPerfCount -= samples.length;
			for (const { sample, at } of samples) this.applyPerfSample(model, sample, at);
		}
		return this.storage.mutateCurrentHost<ProfileMutation>(
			() => ({}),
			(profiles, host) => {
				const current = normalizeProfile(profiles[model]?.profile);
				const activeRules = pruneRetiredRules(current.rules, current.teachStats, now);
				const pruned = activeRules.length !== current.rules.length;
				const active = pruned ? { ...current, rules: activeRules } : current;
				const requested = mutate(active);
				const applied = requested !== undefined;
				if (!applied && !pruned) {
					return { result: { profile: active, applied: false }, changed: false };
				}
				const profile = normalizeProfile(requested ?? active);
				const entry: StoredModelAdaptation = { model, profile, at: storedAt, host };
				profiles[model] = entry;
				return { result: { profile, entry, applied }, changed: true };
			},
		);
	}

	/** Persist the profile for a model on the CURRENT host. Best-effort, returns the entry. */
	save(model: string, profile: ModelAdaptationProfile, at?: string): StoredModelAdaptation {
		return this.store(model, profile, at ?? new Date().toISOString());
	}

	/** Profile for a model on the current host; prunes retired rules before returning. */
	get(model: string, now: Date = new Date()): ModelAdaptationProfile {
		const entry = this.storage.getHost()?.[model];
		if (!entry) return emptyProfile();
		const profile = normalizeProfile(entry.profile);
		const prunedRules = pruneRetiredRules(profile.rules, profile.teachStats, now);
		if (prunedRules.length !== profile.rules.length) {
			return this.mutateProfile(model, now, () => undefined).profile;
		}
		return profile;
	}

	/** Add or replace one standing rule, enforcing the per-model cap. */
	addRule(
		model: string,
		rule: { mode: string; text: string; addedAt?: string; lastFiredAt?: string },
		now = new Date(),
	): StoredModelAdaptation {
		const at = now.toISOString();
		const nextRule: ModelAdaptationRule = {
			mode: rule.mode,
			text: rule.text,
			addedAt: rule.addedAt ?? at,
			lastFiredAt: rule.lastFiredAt ?? at,
		};
		const result = this.mutateProfile(model, now, (profile) => ({
			...profile,
			rules: mergeRule(profile.rules, nextRule),
		}));
		return result.entry!;
	}

	removeRule(model: string, mode: string, at = new Date()): boolean {
		return this.mutateProfile(model, at, (profile) => {
			const rules = profile.rules.filter((rule) => rule.mode !== mode);
			return rules.length === profile.rules.length ? undefined : { ...profile, rules };
		}).applied;
	}

	/** Update last-fired recency for an existing rule. No-op when absent. */
	markRuleFired(model: string, mode: string, at = new Date()): StoredModelAdaptation | undefined {
		const result = this.mutateProfile(model, at, (profile) => {
			const rules = profile.rules.map((rule) =>
				rule.mode === mode ? { ...rule, lastFiredAt: at.toISOString() } : rule,
			);
			return rules.every((rule, index) => rule === profile.rules[index]) ? undefined : { ...profile, rules };
		});
		return result.applied ? result.entry : undefined;
	}

	setProtocol(model: string, protocol: ModelProtocolCalibration, at?: string): StoredModelAdaptation {
		const now = at ?? (protocol.status === "failed" ? protocol.attemptedAt : protocol.calibratedAt);
		return this.mutateProfile(model, new Date(now), (profile) => ({ ...profile, protocol }), now).entry!;
	}

	/** Record graded evidence that demotes a model's capability tier; `undefined` clears it. */
	setCapabilityTier(model: string, demotion: CapabilityTierDemotion | undefined, at?: string): StoredModelAdaptation {
		const now = at ?? demotion?.at ?? new Date().toISOString();
		return this.mutateProfile(
			model,
			new Date(now),
			(profile) => {
				const { capabilityTier: _previous, ...rest } = profile;
				return demotion ? { ...rest, capabilityTier: demotion } : rest;
			},
			now,
		).entry!;
	}

	setToolProbe(model: string, toolProbe: ModelToolProbe, at?: string): StoredModelAdaptation {
		const now = at ?? toolProbe.probedAt;
		return this.mutateProfile(model, new Date(now), (profile) => ({ ...profile, toolProbe }), now).entry!;
	}

	recordPerfSample(model: string, sample: ModelPerfSample, at?: string): StoredModelAdaptation | undefined {
		if (!hasUsableModelPerfSample(sample)) return undefined;
		const now = at ?? sample.at ?? new Date().toISOString();
		if (this.deferPerfSamples && !this.closed) {
			const queue = this.pendingPerf.get(model) ?? [];
			queue.push({ sample, at: now });
			this.pendingPerf.set(model, queue);
			this.pendingPerfCount += 1;
			if (this.pendingPerfCount >= DEFERRED_PERF_SAMPLE_CAP) this.flush();
			else if (!this.perfFlushTimer) {
				this.perfFlushTimer = setTimeout(() => {
					this.perfFlushTimer = undefined;
					try {
						this.flush();
					} catch {
						// The samples stay queued for the next flush.
					}
				}, DEFERRED_PERF_SAMPLE_IDLE_MS);
				this.perfFlushTimer.unref?.();
			}
			return undefined;
		}
		return this.applyPerfSample(model, sample, now);
	}

	private applyPerfSample(model: string, sample: ModelPerfSample, now: string): StoredModelAdaptation | undefined {
		const result = this.mutateProfile(
			model,
			new Date(now),
			(profile) => {
				const perf = updateModelPerfProfile(profile.perf, sample, now);
				return perf ? { ...profile, perf } : undefined;
			},
			now,
		);
		return result.applied ? result.entry : undefined;
	}

	removeProtocol(model: string, at = new Date()): boolean {
		return this.mutateProfile(model, at, (profile) => {
			if (!profile.protocol) return undefined;
			const { protocol: _protocol, ...rest } = profile;
			return rest;
		}).applied;
	}

	setTeachStats(model: string, mode: string, stats: ModelTeachStats, at?: string): StoredModelAdaptation {
		const now = at ?? new Date().toISOString();
		return this.mutateProfile(
			model,
			new Date(now),
			(profile) => ({
				...profile,
				teachStats: { ...profile.teachStats, [mode]: stats },
			}),
			now,
		).entry!;
	}

	/** Profiles for the current host (default) or an explicit host id. */
	getForHost(hostId?: string): StoredModelAdaptation[] {
		return Object.values(this.storage.getHost(hostId) ?? {}).map((entry) => ({
			...entry,
			profile: normalizeProfile(entry.profile),
		}));
	}

	/** Every stored profile across all hosts (for cross-machine comparisons). */
	getAll(): StoredModelAdaptation[] {
		return this.storage
			.getAllHosts()
			.flatMap((models) =>
				Object.values(models).map((entry) => ({ ...entry, profile: normalizeProfile(entry.profile) })),
			);
	}
}
