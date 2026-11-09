import type { Api, Model } from "@caupulican/pi-ai";
import { deriveModelCapabilityProfile, filterToolNamesForCapability } from "../model-capability.ts";
import type { ModelRegistry } from "../model-registry.ts";
import type {
	OrchestrationModelBinding,
	OrchestrationProfile,
	ResourcePointer,
	WorkerProfileExecutionContract,
} from "../orchestration/contracts.ts";
import {
	formatOrchestrationModelRefusals,
	type OrchestrationModelUnusableCause,
	resolveConfiguredOrchestrationModelResolution,
	resolvePinnedOrchestrationModelResolution,
} from "../orchestration/model-binding.ts";
import { OrchestrationProfileStore } from "../orchestration/profile-store.ts";
import type { SessionTaskProfileStore } from "../orchestration/session-task-profile-store.ts";
import type { ProfileRegistry } from "../profile-registry.ts";
import type { ModelCapabilitySettings } from "../settings/settings-schema.ts";
import type { WorkerDelegationRequest } from "./worker-delegation-request.ts";
import { catalogWorkerResourcePointers, type WorkerResourceCatalogResourceLoader } from "./worker-resource-catalog.ts";

/** The settings this module reads, declared by the module itself; the composition root passes the SettingsManager. */
export interface WorkerProfileResolverSettingsSource {
	getModelCapabilitySettings(): Required<ModelCapabilitySettings>;
	getProfileRegistry(): ProfileRegistry;
	isProjectTrusted(): boolean;
}

export interface ResolvedWorkerProfile {
	model: Model<Api>;
	modelBinding: OrchestrationModelBinding;
	profile: OrchestrationProfile;
	/** Metadata-only pointers admitted from the profile-linked resource configuration. */
	resourcePointers: readonly ResourcePointer[];
	soul?: string;
}

export interface ResolvedWorkerProfilePreset {
	profile: OrchestrationProfile;
	/** Metadata-only pointers admitted from the profile-linked resource configuration. */
	resourcePointers: readonly ResourcePointer[];
	soul?: string;
}

/**
 * The skip-reason prefix of a plan verify step whose verifier cannot be set up. The plan executor reads it to hold the
 * step with words instead of parking it.
 */
export const PLAN_VERIFIER_UNAVAILABLE = "independent_verifier_unavailable";

/**
 * The read-only verifier form of a preset: the verifier role, no configured verifier, no dispatch, and the derived id
 * `<id>~verifier`, which the profile store never holds. Its write scope is empty, so it edits nothing.
 */
function readOnlyVerifierPreset(preset: ResolvedWorkerProfilePreset): ResolvedWorkerProfilePreset {
	const { verificationProfileId: _configured, ...profile } = preset.profile;
	return {
		profile: {
			...profile,
			profileId: `${profile.profileId}~verifier`,
			role: "verifier",
			readOnly: true,
			writePaths: [],
			dispatchProfileIds: [],
			requireIndependentVerification: false,
		},
		resourcePointers: preset.resourcePointers,
		...(preset.soul ? { soul: preset.soul } : {}),
	};
}

export interface WorkerProfileResolverOptions {
	agentDir: string;
	cwd: string;
	getSettingsManager(): WorkerProfileResolverSettingsSource;
	getResourceLoader(): WorkerResourceCatalogResourceLoader;
	getModelRegistry(): ModelRegistry;
	modelUnusableCause(model: Model<Api>): OrchestrationModelUnusableCause | undefined;
	getTaskProfileStore(): SessionTaskProfileStore;
	onDiagnostic(message: string): void;
}

interface LoadedWorkerProfiles {
	profiles: OrchestrationProfile[];
	registry: ReadonlyMap<string, OrchestrationProfile>;
}

export class WorkerProfileResolver {
	private readonly options: WorkerProfileResolverOptions;
	private readonly warnedDiagnostics = new Set<string>();

	constructor(options: WorkerProfileResolverOptions) {
		this.options = options;
	}

	catalog(): Array<{ profileId: string; role: string; description: string }> {
		const loaded = this.loadProfiles();
		return loaded.profiles.map((profile) => ({
			profileId: profile.profileId,
			role: profile.role,
			description: profile.description,
		}));
	}

	resolve(
		request: WorkerDelegationRequest,
		defaultProfileId: string | undefined,
	): { ok: true; resolved: ResolvedWorkerProfile } | { ok: false; reason: string } {
		const preset = this.resolvePreset(request, defaultProfileId);
		return preset.ok ? this.bindPreset(preset.resolved) : preset;
	}

	resolvePreset(
		request: WorkerDelegationRequest,
		defaultProfileId: string | undefined,
	): { ok: true; resolved: ResolvedWorkerProfilePreset } | { ok: false; reason: string } {
		const requestedProfileId = request.profileId?.trim();
		// Profiles are routing presets, not authority cages. Any loaded preset may be selected; the
		// execution controller independently intersects its materialized plan with inherited authority.
		const profileId = requestedProfileId || defaultProfileId;
		// A plan review's derived verifier exists only on its request: it is never stored, so it is not looked up.
		const derived = request.verifierPreset && request.reviewOf ? request.verifierPreset : undefined;
		const verifierSubject = request.verificationOfTaskId !== undefined || request.reviewOf !== undefined;
		return this.presetWithRoles(profileId, verifierSubject, derived);
	}

	/**
	 * The preset a profile id names (or a derived verifier given in its place), with the role rules a request of its kind must meet.
	 * A request's own resolution and a plan verify step's fallback to the default profile both pass through here.
	 */
	private presetWithRoles(
		profileId: string | undefined,
		verifierSubject: boolean,
		derived?: ResolvedWorkerProfilePreset,
	): { ok: true; resolved: ResolvedWorkerProfilePreset } | { ok: false; reason: string } {
		if (!profileId) return { ok: false, reason: "orchestration_profile_required" };
		const selected = derived ? { ok: true as const, resolved: derived } : this.resolveProfilePresetId(profileId);
		if (!selected.ok) return selected;
		const role = selected.resolved.profile.role;
		if (verifierSubject && role !== "verifier") {
			return { ok: false, reason: "verification_profile_role_mismatch" };
		}
		if (!verifierSubject && role === "verifier") {
			return { ok: false, reason: "verifier_profile_requires_runtime_dispatch" };
		}
		return selected;
	}

	resolveVerifier(
		workerProfile: OrchestrationProfile,
	): { ok: true; resolved: ResolvedWorkerProfile } | { ok: false; reason: string } {
		const preset = this.resolveVerifierPreset(workerProfile);
		return preset.ok ? this.bindPreset(preset.resolved) : preset;
	}

	resolveVerifierPreset(
		workerProfile: OrchestrationProfile,
	): { ok: true; resolved: ResolvedWorkerProfilePreset } | { ok: false; reason: string } {
		if (!workerProfile.requireIndependentVerification || !workerProfile.verificationProfileId) {
			return { ok: false, reason: "independent_verifier_not_configured" };
		}
		const selected = this.resolveProfilePresetId(workerProfile.verificationProfileId);
		if (!selected.ok) return selected;
		if (selected.resolved.profile.role !== "verifier") {
			return { ok: false, reason: "verification_profile_role_mismatch" };
		}
		return selected;
	}

	/**
	 * The verifier a plan verify step runs as: the read-only verifier form of the subject's admitted profile. A subject with no local
	 * contract (it ran on a linked machine or in a managed lane) gets the form of the profile a plan step runs under by default, the
	 * default-profile path of `resolvePreset`. A configured verifier may be write-capable, so it is never used for a plan step.
	 */
	resolvePlanVerifierPreset(
		subject: WorkerProfileExecutionContract | undefined,
		defaultProfileId: string | undefined,
	): { ok: true; resolved: ResolvedWorkerProfilePreset } | { ok: false; reason: string } {
		if (subject)
			return {
				ok: true,
				resolved: readOnlyVerifierPreset({
					profile: subject.profile,
					resourcePointers: subject.resourcePointers,
					...(subject.soul ? { soul: subject.soul } : {}),
				}),
			};
		const base = this.presetWithRoles(defaultProfileId, false);
		if (!base.ok) return { ok: false, reason: `${PLAN_VERIFIER_UNAVAILABLE}:${base.reason}` };
		return { ok: true, resolved: readOnlyVerifierPreset(base.resolved) };
	}

	bindPreset(
		preset: ResolvedWorkerProfilePreset,
		modelPin?: OrchestrationModelBinding,
	): { ok: true; resolved: ResolvedWorkerProfile } | { ok: false; reason: string } {
		const outcome = modelPin
			? resolvePinnedOrchestrationModelResolution(modelPin, this.options.getModelRegistry(), (model) =>
					this.options.modelUnusableCause(model),
				)
			: resolveConfiguredOrchestrationModelResolution(preset.profile, this.options.getModelRegistry(), (model) =>
					this.options.modelUnusableCause(model),
				);
		if (!outcome.ok) {
			const family = modelPin ? "orchestration_model_unavailable" : "orchestration_profile_model_unavailable";
			return { ok: false, reason: `${family}:${formatOrchestrationModelRefusals(outcome.refusals)}` };
		}
		const resolvedModel = outcome.resolved;
		return {
			ok: true,
			resolved: {
				model: resolvedModel.model,
				modelBinding: resolvedModel.binding,
				profile: modelPin
					? {
							...structuredClone(preset.profile),
							modelPolicy: { mode: "fixed", candidates: [resolvedModel.binding] },
						}
					: structuredClone(preset.profile),
				resourcePointers: structuredClone(preset.resourcePointers),
				...(preset.soul ? { soul: preset.soul } : {}),
			},
		};
	}

	resolveContract(
		contract: WorkerProfileExecutionContract,
		skipModelRefs?: ReadonlySet<string>,
	): { ok: true; resolved: ResolvedWorkerProfile } | { ok: false; reason: string } {
		// Admission already fixed this contract. Live host controls may revoke execution, but mutable
		// profile files cannot retroactively redefine the model, resources, or authority snapshot.
		// A routed worker's contract carries its routing order as an ordered-fallback policy: the first
		// candidate not exhausted is where it runs, so a quota failure moves it on retry. A fixed policy
		// runs on the admitted binding or not at all.
		const unusableCause = (model: Model<Api>) => this.options.modelUnusableCause(model);
		// A queued route judged unfit on some candidates resolves past them (`skipModelRefs`); the resolved profile keeps
		// the contract's full candidate list, so only the resolution sees the remaining order.
		const candidates = contract.profile.modelPolicy.candidates;
		const remaining = candidates.filter((binding) => !skipModelRefs?.has(`${binding.provider}/${binding.modelId}`));
		if (contract.profile.modelPolicy.mode === "ordered-fallback" && remaining.length === 0 && candidates.length > 0)
			return {
				ok: false,
				reason: "orchestration_profile_model_unavailable:every candidate was judged unfit for this task",
			};
		const outcome =
			contract.profile.modelPolicy.mode === "ordered-fallback"
				? resolveConfiguredOrchestrationModelResolution(
						{ ...contract.profile, modelPolicy: { ...contract.profile.modelPolicy, candidates: remaining } },
						this.options.getModelRegistry(),
						unusableCause,
					)
				: resolvePinnedOrchestrationModelResolution(
						contract.modelBinding,
						this.options.getModelRegistry(),
						unusableCause,
					);
		if (!outcome.ok) {
			// A fixed contract runs on its admitted binding, so it reports the model family the start path reports.
			const family =
				contract.profile.modelPolicy.mode === "ordered-fallback"
					? "orchestration_profile_model_unavailable"
					: "orchestration_model_unavailable";
			return { ok: false, reason: `${family}:${formatOrchestrationModelRefusals(outcome.refusals)}` };
		}
		const resolvedModel = outcome.resolved;
		const profile = structuredClone(contract.profile);
		profile.toolNames = filterToolNamesForCapability(
			profile.toolNames,
			deriveModelCapabilityProfile({
				contextWindow: resolvedModel.model.contextWindow,
				mode: this.options.getSettingsManager().getModelCapabilitySettings().mode,
			}),
			resolvedModel.model,
		);
		return {
			ok: true,
			resolved: {
				model: resolvedModel.model,
				modelBinding: resolvedModel.binding,
				profile,
				resourcePointers: structuredClone(contract.resourcePointers),
				...(contract.soul ? { soul: contract.soul } : {}),
			},
		};
	}

	private resolveProfilePresetId(
		profileId: string,
		loaded: LoadedWorkerProfiles = this.loadProfiles(),
	): { ok: true; resolved: ResolvedWorkerProfilePreset } | { ok: false; reason: string } {
		const profile = loaded.registry.get(profileId);
		if (!profile) return { ok: false, reason: "orchestration_profile_not_found" };
		const linkedProfiles = profile.resourceProfileNames.map((name) =>
			this.options.getSettingsManager().getProfileRegistry().getProfile(name),
		);
		if (linkedProfiles.some((linked) => linked === undefined)) {
			return { ok: false, reason: "orchestration_resource_profile_not_found" };
		}
		const soul = linkedProfiles
			.flatMap((linked) => (linked?.soul ? [linked.soul] : []))
			.join("\n\n")
			.trim();
		const resourcePointers = catalogWorkerResourcePointers({
			cwd: this.options.cwd,
			resourceLoader: this.options.getResourceLoader(),
			resourceProfiles: linkedProfiles.filter(
				(linked): linked is NonNullable<typeof linked> => linked !== undefined,
			),
		});
		return {
			ok: true,
			resolved: {
				profile: structuredClone(profile),
				resourcePointers,
				...(soul ? { soul } : {}),
			},
		};
	}

	private loadProfiles(): LoadedWorkerProfiles {
		const loaded = new OrchestrationProfileStore({
			agentDir: this.options.agentDir,
			cwd: this.options.cwd,
			projectTrusted: this.options.getSettingsManager().isProjectTrusted(),
		}).load();
		for (const diagnostic of loaded.diagnostics) {
			const key = `${diagnostic.path}\0${diagnostic.message}`;
			if (this.warnedDiagnostics.has(key)) continue;
			this.warnedDiagnostics.add(key);
			this.options.onDiagnostic(`Orchestration profile ignored (${diagnostic.path}): ${diagnostic.message}`);
		}
		const taskProfiles = this.options.getTaskProfileStore().load();
		for (const diagnostic of taskProfiles.diagnostics) {
			const key = `session\0${diagnostic}`;
			if (this.warnedDiagnostics.has(key)) continue;
			this.warnedDiagnostics.add(key);
			this.options.onDiagnostic(`Session task profile ignored: ${diagnostic}`);
		}
		const profiles = [...loaded.profiles];
		const registry = new Map(loaded.profiles.map((profile) => [profile.profileId, profile]));
		for (const record of taskProfiles.records) {
			if (registry.has(record.profile.profileId)) continue;
			profiles.push(record.profile);
			registry.set(record.profile.profileId, record.profile);
		}
		return { profiles, registry };
	}
}
