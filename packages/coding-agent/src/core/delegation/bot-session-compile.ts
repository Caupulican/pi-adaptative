/**
 * What a bot made from a worker profile runs on as a session of its own: the profile's resolution as a fresh worker of the
 * bot would take it (`WorkerProfileResolver`, the owner's pin for its role, the bot's authority and soul over it, the model
 * rules, the execution plan the lanes build, and the verifier the profile requires), fixed in a worker execution contract.
 * Resolution only: none of a worker run's admission gates applies (whether the main session delegates now, the worker
 * fleet, a parent agent, saved intents, knowledge, write reservations), because no worker run starts.
 */

import type { Api, Model } from "@caupulican/pi-ai";
import type { OrchestrationProfile, WorkerExecutionContract } from "../orchestration/contracts.ts";
import { createWorkerExecutionContract } from "../orchestration/worker-execution-contract.ts";
import {
	pinnedModelSkipReason,
	type ResolvedWorkerModelPin,
	resolveWorkerModelPin,
	type WorkerModelPinPolicy,
} from "../orchestration/worker-model-pins.ts";
import type { ResolvedWorkerDelegationSettings } from "../settings/settings-schema.ts";
import {
	bindBotSoul,
	bindCompiledToolSurface,
	bindCompiledVerifierIdentity,
	type WorkerAuthorityResolution,
} from "./worker-authority-resolver.ts";
import {
	parseWorkerDelegationAuthorityRequest,
	type WorkerDelegationAuthorityRequest,
	type WorkerDelegationRequest,
} from "./worker-delegation-request.ts";
import { type WorkerExecutionPlan, workerExecutionAuthorityFromPlan } from "./worker-execution-policy.ts";
import type { ResolvedWorkerProfile, WorkerProfileResolver } from "./worker-profile-resolver.ts";
import { selectWorkerResourcePointers } from "./worker-resource-catalog.ts";
import { materializeWorkerResourceBundle } from "./worker-resource-materializer.ts";

/** What the bot's compile is resolved by: the main session's profile resolver, authority rules, verifier and plan builder. */
export interface BotSessionCompilePorts {
	resolver(): Pick<WorkerProfileResolver, "resolvePreset" | "bindPreset">;
	settings(): ResolvedWorkerDelegationSettings;
	modelPinPolicy(): WorkerModelPinPolicy;
	/** The worker authority rules over a bound profile: the bot's model stance and read-only grant, the foreground's ceiling. */
	resolveAuthority(input: {
		authority?: WorkerDelegationAuthorityRequest;
		base: ResolvedWorkerProfile;
		modelPin?: ResolvedWorkerModelPin["binding"];
	}): WorkerAuthorityResolution;
	isModelAllowed(model: Model<Api>): boolean;
	/** The verifier the profile requires, admitted as a fresh verifier is; none when it requires none. */
	requiredVerifier(
		profile: OrchestrationProfile,
		policy: WorkerModelPinPolicy,
	): { ok: true; shipment?: ResolvedWorkerProfile } | { ok: false; skipReason: string };
	/** The execution plan the lanes build for a profile. */
	plan(profile: OrchestrationProfile, settings: ResolvedWorkerDelegationSettings): WorkerExecutionPlan;
	systemPromptMaxChars(model: Model<Api>): number | undefined;
}

/** What a bot made from a profile compiles to for a session of its own; or why it cannot run. */
export type BotSessionCompilation =
	| { readonly ok: false; readonly skipReason: string }
	| {
			readonly ok: true;
			/** The profile as its owner wrote it: the tools it names and whether each answer needs an independent verifier. */
			readonly profile: OrchestrationProfile;
			/** The bot's contract: its worker side is the session, its verifier side checks the session's answers. */
			readonly contract: WorkerExecutionContract;
			/** The resolved worker side's model, as the registry knows it now. */
			readonly model: Model<Api>;
			/** The profile's resources as a worker's system prompt carries them; empty when it has none. */
			readonly resourceSystemPrompt: string;
			/** How the plan holds its scope: its working directory, whether reads are confined, whether it or its shell edits nothing. */
			readonly plan: Pick<
				WorkerExecutionPlan,
				"cwd" | "readConfined" | "readScopeNamed" | "readPaths" | "deniedPaths" | "readOnly" | "shellReadOnly"
			>;
	  };

type Bound =
	| { ok: true; written: OrchestrationProfile; shipment: ResolvedWorkerProfile }
	| { ok: false; skipReason: string };

/** The bot's profile, bound to the owner's pin for its role and held to the bot's authority. */
function bindProfile(
	ports: BotSessionCompilePorts,
	request: WorkerDelegationRequest & { readonly profileId: string },
	policy: WorkerModelPinPolicy,
): Bound {
	let authority: WorkerDelegationAuthorityRequest | undefined;
	try {
		authority = request.authority && parseWorkerDelegationAuthorityRequest(request.authority);
	} catch (error) {
		return {
			ok: false,
			skipReason: `orchestration_authority_invalid:${error instanceof Error ? error.message : String(error)}`,
		};
	}
	const preset = ports.resolver().resolvePreset(request, undefined);
	if (!preset.ok) return { ok: false, skipReason: preset.reason };
	const role = authority?.role ?? preset.resolved.profile.role;
	const pin = resolveWorkerModelPin(policy, role, request);
	// A refusal names the pin that refused, as a worker's admission names it.
	const pinLabel = pin?.tier === "leader" ? "leader" : role;
	const bound = ports.resolver().bindPreset(preset.resolved, pin?.binding);
	if (!bound.ok) return { ok: false, skipReason: pin ? pinnedModelSkipReason(pinLabel, bound.reason) : bound.reason };
	const held = ports.resolveAuthority({
		...(authority ? { authority } : {}),
		base: bound.resolved,
		...(pin ? { modelPin: pin.binding } : {}),
	});
	if (!held.ok)
		return {
			ok: false,
			skipReason:
				pin && held.reason.startsWith("orchestration_model_unavailable:")
					? pinnedModelSkipReason(pinLabel, held.reason)
					: held.reason,
		};
	if (!ports.isModelAllowed(held.shipment.model)) return { ok: false, skipReason: "worker_model_disallowed" };
	return { ok: true, written: preset.resolved.profile, shipment: held.shipment };
}

export function compileBotSessionContract(
	ports: BotSessionCompilePorts,
	request: WorkerDelegationRequest & { readonly profileId: string },
): BotSessionCompilation {
	const policy = ports.modelPinPolicy();
	if (policy.status === "invalid") return { ok: false, skipReason: "worker_model_pins_invalid" };
	const bound = bindProfile(ports, request, policy);
	if (!bound.ok) return bound;
	const settings = ports.settings();
	const verifier = ports.requiredVerifier(bound.shipment.profile, policy);
	if (!verifier.ok) return verifier;
	if (verifier.shipment && !ports.isModelAllowed(verifier.shipment.model))
		return { ok: false, skipReason: "independent_verifier_unavailable:worker_model_disallowed" };
	const plan = ports.plan(bound.shipment.profile, settings);
	let shipment = bindCompiledToolSurface(
		bound.shipment,
		plan.toolManifests.map((manifest) => manifest.toolName),
	);
	const verifierPlan = verifier.shipment && ports.plan(verifier.shipment.profile, settings);
	const verifierShipment =
		verifier.shipment &&
		verifierPlan &&
		bindCompiledToolSurface(
			verifier.shipment,
			verifierPlan.toolManifests.map((manifest) => manifest.toolName),
		);
	if (verifierShipment) shipment = bindCompiledVerifierIdentity(shipment, verifierShipment.profile.profileId);
	if (request.botSoul !== undefined) {
		const withSoul = bindBotSoul(shipment, request.botSoul, ports.systemPromptMaxChars(shipment.model));
		if (!withSoul.ok) return withSoul;
		shipment = withSoul.shipment;
	}
	const resources = selectWorkerResourcePointers(
		shipment.resourcePointers,
		shipment.resourcePointers.map((pointer) => pointer.id),
	);
	if (!resources.ok) return { ok: false, skipReason: resources.reason };
	const materialized = materializeWorkerResourceBundle(resources.pointers);
	if (!materialized.ok) return { ok: false, skipReason: `worker_resource_materialization_${materialized.code}` };
	const contract = createWorkerExecutionContract({
		worker: { ...shipment, authority: workerExecutionAuthorityFromPlan(plan) },
		...(verifierShipment && verifierPlan
			? { verifier: { ...verifierShipment, authority: workerExecutionAuthorityFromPlan(verifierPlan) } }
			: {}),
	});
	return {
		ok: true,
		profile: bound.written,
		contract,
		model: shipment.model,
		resourceSystemPrompt: materialized.systemPrompt,
		plan: {
			cwd: plan.cwd,
			readConfined: plan.readConfined,
			readScopeNamed: plan.readScopeNamed,
			readPaths: plan.readPaths,
			deniedPaths: plan.deniedPaths,
			readOnly: plan.readOnly,
			shellReadOnly: plan.shellReadOnly,
		},
	};
}
