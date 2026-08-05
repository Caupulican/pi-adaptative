import type { Api, Model } from "@caupulican/pi-ai";
import type { ModelRegistry } from "../model-registry.ts";
import type {
	OrchestrationModelBinding,
	OrchestrationProfile,
	ResourcePointer,
	WorkerProfileExecutionContract,
} from "../orchestration/contracts.ts";
import {
	resolveConfiguredOrchestrationModel,
	resolvePinnedOrchestrationModel,
} from "../orchestration/model-binding.ts";
import { OrchestrationProfileStore } from "../orchestration/profile-store.ts";
import type { SessionTaskProfileStore } from "../orchestration/session-task-profile-store.ts";
import type { SettingsManager } from "../settings-manager.ts";
import type { WorkerDelegationRequest } from "./worker-delegation-request.ts";
import { catalogWorkerResourcePointers, type WorkerResourceCatalogResourceLoader } from "./worker-resource-catalog.ts";

export interface ResolvedWorkerProfile {
	model: Model<Api>;
	modelBinding: OrchestrationModelBinding;
	profile: OrchestrationProfile;
	/** Metadata-only pointers admitted from the profile-linked resource configuration. */
	resourcePointers: readonly ResourcePointer[];
	soul?: string;
}

export interface WorkerProfileResolverOptions {
	agentDir: string;
	cwd: string;
	getSettingsManager(): SettingsManager;
	getResourceLoader(): WorkerResourceCatalogResourceLoader;
	getModelRegistry(): ModelRegistry;
	isModelExhausted(model: Model<Api>): boolean;
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
		const requestedProfileId = request.profileId?.trim();
		// Profiles are routing presets, not authority cages. Any loaded preset may be selected; the
		// execution controller independently intersects its materialized plan with inherited authority.
		const profileId = requestedProfileId || defaultProfileId;
		if (!profileId) return { ok: false, reason: "orchestration_profile_required" };
		const selected = this.resolveProfileId(profileId);
		if (!selected.ok) return selected;
		const profile = selected.resolved.profile;
		if (request.verificationOfTaskId && profile.role !== "verifier") {
			return { ok: false, reason: "verification_profile_role_mismatch" };
		}
		if (!request.verificationOfTaskId && profile.role === "verifier") {
			return { ok: false, reason: "verifier_profile_requires_runtime_dispatch" };
		}
		return selected;
	}

	resolveVerifier(
		workerProfile: OrchestrationProfile,
	): { ok: true; resolved: ResolvedWorkerProfile } | { ok: false; reason: string } {
		if (!workerProfile.requireIndependentVerification || !workerProfile.verificationProfileId) {
			return { ok: false, reason: "independent_verifier_not_configured" };
		}
		const selected = this.resolveProfileId(workerProfile.verificationProfileId);
		if (!selected.ok) return selected;
		if (selected.resolved.profile.role !== "verifier") {
			return { ok: false, reason: "verification_profile_role_mismatch" };
		}
		return selected;
	}

	resolveContract(
		contract: WorkerProfileExecutionContract,
	): { ok: true; resolved: ResolvedWorkerProfile } | { ok: false; reason: string } {
		// Admission already fixed this contract. Live host controls may revoke execution, but mutable
		// profile files cannot retroactively redefine the model, resources, or authority snapshot.
		const resolvedModel = resolvePinnedOrchestrationModel(
			contract.modelBinding,
			this.options.getModelRegistry(),
			(model) => this.options.isModelExhausted(model),
		);
		if (!resolvedModel) return { ok: false, reason: "orchestration_profile_model_unavailable" };
		return {
			ok: true,
			resolved: {
				model: resolvedModel.model,
				modelBinding: resolvedModel.binding,
				profile: structuredClone(contract.profile),
				resourcePointers: structuredClone(contract.resourcePointers),
				...(contract.soul ? { soul: contract.soul } : {}),
			},
		};
	}

	private resolveProfileId(
		profileId: string,
		loaded: LoadedWorkerProfiles = this.loadProfiles(),
	): { ok: true; resolved: ResolvedWorkerProfile } | { ok: false; reason: string } {
		const profile = loaded.registry.get(profileId);
		if (!profile) return { ok: false, reason: "orchestration_profile_not_found" };
		const resolvedModel = resolveConfiguredOrchestrationModel(profile, this.options.getModelRegistry(), (model) =>
			this.options.isModelExhausted(model),
		);
		if (!resolvedModel) return { ok: false, reason: "orchestration_profile_model_unavailable" };
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
				model: resolvedModel.model,
				modelBinding: resolvedModel.binding,
				profile,
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
