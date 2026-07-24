import type { Api, Model } from "@caupulican/pi-ai";
import type { ModelRegistry } from "../model-registry.ts";
import type {
	OrchestrationModelBinding,
	OrchestrationProfile,
	WorkerProfileExecutionContract,
} from "../orchestration/contracts.ts";
import {
	resolveConfiguredOrchestrationModel,
	resolvePinnedOrchestrationModel,
} from "../orchestration/model-binding.ts";
import { OrchestrationProfileStore } from "../orchestration/profile-store.ts";
import type { SettingsManager } from "../settings-manager.ts";
import type { WorkerDelegationRequest } from "./worker-delegation-request.ts";

export interface ResolvedWorkerProfile {
	model: Model<Api>;
	modelBinding: OrchestrationModelBinding;
	profile: OrchestrationProfile;
	soul?: string;
}

export interface WorkerProfileResolverOptions {
	agentDir: string;
	cwd: string;
	getSettingsManager(): SettingsManager;
	getModelRegistry(): ModelRegistry;
	isModelExhausted(model: Model<Api>): boolean;
	getActiveOrchestrationProfile(): OrchestrationProfile | undefined;
	onDiagnostic(message: string): void;
}

export class WorkerProfileResolver {
	private readonly options: WorkerProfileResolverOptions;
	private readonly warnedDiagnostics = new Set<string>();

	constructor(options: WorkerProfileResolverOptions) {
		this.options = options;
	}

	catalog(): Array<{ profileId: string; role: string; description: string }> {
		const activeProfile = this.options.getActiveOrchestrationProfile();
		const allowedProfileIds =
			activeProfile?.role === "orchestrator" ? new Set(activeProfile.dispatchProfileIds) : undefined;
		return this.loadProfiles()
			.profiles.filter(
				(profile) =>
					profile.role !== "orchestrator" && (!allowedProfileIds || allowedProfileIds.has(profile.profileId)),
			)
			.map((profile) => ({
				profileId: profile.profileId,
				role: profile.role,
				description: profile.description,
			}));
	}

	resolve(
		request: WorkerDelegationRequest,
		defaultProfileId: string | undefined,
	): { ok: true; resolved: ResolvedWorkerProfile } | { ok: false; reason: string } {
		const profileId = request.profileId?.trim() || defaultProfileId;
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
		// The architect allowlist authorized this immutable contract at admission. Live session/goal
		// controls may revoke execution, but mutable profile files cannot retroactively redefine it.
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
				...(contract.soul ? { soul: contract.soul } : {}),
			},
		};
	}

	private resolveProfileId(
		profileId: string,
	): { ok: true; resolved: ResolvedWorkerProfile } | { ok: false; reason: string } {
		if (!this.isProfileAuthorized(profileId)) {
			return { ok: false, reason: "orchestration_profile_not_authorized_for_orchestrator" };
		}
		const profile = this.loadProfiles().registry.get(profileId);
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
		return {
			ok: true,
			resolved: {
				model: resolvedModel.model,
				modelBinding: resolvedModel.binding,
				profile,
				...(soul ? { soul } : {}),
			},
		};
	}

	private isProfileAuthorized(profileId: string): boolean {
		const activeProfile = this.options.getActiveOrchestrationProfile();
		return (
			!activeProfile ||
			(activeProfile.role === "orchestrator" && activeProfile.dispatchProfileIds.includes(profileId))
		);
	}

	private loadProfiles(): ReturnType<OrchestrationProfileStore["load"]> {
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
		return loaded;
	}
}
