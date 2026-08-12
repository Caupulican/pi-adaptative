import { isPlainRecord } from "../util/value-guards.ts";
import {
	MAX_ORCHESTRATION_MODEL_ID_LENGTH,
	MAX_ORCHESTRATION_MODEL_PROVIDER_LENGTH,
	ORCHESTRATION_THINKING_LEVELS,
	type OrchestrationModelBinding,
	WORKER_ROLES,
	type WorkerRole,
} from "./contracts.ts";

export type WorkerModelPinSource = "global" | "project" | "directoryProfile";

export interface WorkerModelPinsSettings {
	default?: OrchestrationModelBinding;
	roles?: Partial<Record<WorkerRole, OrchestrationModelBinding>>;
}

export interface ResolvedWorkerModelPin {
	binding: OrchestrationModelBinding;
	source: WorkerModelPinSource;
}

export type WorkerModelPinPolicy =
	| { status: "absent" }
	| { status: "invalid"; diagnostics: readonly string[] }
	| {
			status: "active";
			byRole: Readonly<Partial<Record<WorkerRole, ResolvedWorkerModelPin>>>;
	  };

export interface WorkerModelPinPolicyLayers {
	global?: unknown;
	project?: unknown;
	directoryProfile?: unknown;
}

interface NormalizedPinLayer {
	settings: WorkerModelPinsSettings;
	source: WorkerModelPinSource;
}

interface ParsedPinLayer {
	present: boolean;
	settings?: WorkerModelPinsSettings;
	diagnostics: string[];
}

const POLICY_KEYS = new Set(["default", "roles"]);
const BINDING_KEYS = new Set(["provider", "modelId", "thinkingLevel"]);
const WORKER_ROLE_SET: ReadonlySet<string> = new Set(WORKER_ROLES);
const THINKING_LEVEL_SET: ReadonlySet<string> = new Set(ORCHESTRATION_THINKING_LEVELS);

function cloneBinding(binding: OrchestrationModelBinding): OrchestrationModelBinding {
	return { ...binding };
}

function bindingDiagnostic(scope: WorkerModelPinSource, path: string, expectation: string): string {
	return `workerDelegation.modelPins.${path} in ${scope} settings must ${expectation}`;
}

function parseBinding(
	value: unknown,
	scope: WorkerModelPinSource,
	path: string,
	diagnostics: string[],
): OrchestrationModelBinding | undefined {
	if (!isPlainRecord(value)) {
		diagnostics.push(bindingDiagnostic(scope, path, "be an object"));
		return undefined;
	}
	const unknownKeys = Object.keys(value).filter((key) => !BINDING_KEYS.has(key));
	if (unknownKeys.length > 0) {
		diagnostics.push(bindingDiagnostic(scope, path, `contain only provider, modelId, and thinkingLevel`));
		return undefined;
	}
	const provider = typeof value.provider === "string" ? value.provider.trim() : "";
	if (!provider || provider.length > MAX_ORCHESTRATION_MODEL_PROVIDER_LENGTH) {
		diagnostics.push(
			bindingDiagnostic(
				scope,
				`${path}.provider`,
				`be a nonempty string of at most ${MAX_ORCHESTRATION_MODEL_PROVIDER_LENGTH} characters`,
			),
		);
	}
	const modelId = typeof value.modelId === "string" ? value.modelId.trim() : "";
	if (!modelId || modelId.length > MAX_ORCHESTRATION_MODEL_ID_LENGTH) {
		diagnostics.push(
			bindingDiagnostic(
				scope,
				`${path}.modelId`,
				`be a nonempty string of at most ${MAX_ORCHESTRATION_MODEL_ID_LENGTH} characters`,
			),
		);
	}
	const thinkingLevel = value.thinkingLevel;
	if (typeof thinkingLevel !== "string" || !THINKING_LEVEL_SET.has(thinkingLevel)) {
		diagnostics.push(
			bindingDiagnostic(scope, `${path}.thinkingLevel`, `be one of ${ORCHESTRATION_THINKING_LEVELS.join(", ")}`),
		);
	}
	if (!provider || !modelId || typeof thinkingLevel !== "string" || !THINKING_LEVEL_SET.has(thinkingLevel)) {
		return undefined;
	}
	return {
		provider,
		modelId,
		thinkingLevel: thinkingLevel as OrchestrationModelBinding["thinkingLevel"],
	};
}

function parseLayer(value: unknown, scope: WorkerModelPinSource): ParsedPinLayer {
	if (value === undefined) return { present: false, diagnostics: [] };
	const diagnostics: string[] = [];
	if (!isPlainRecord(value)) {
		return {
			present: true,
			diagnostics: [`workerDelegation.modelPins in ${scope} settings must be an object`],
		};
	}
	const unknownKeys = Object.keys(value).filter((key) => !POLICY_KEYS.has(key));
	if (unknownKeys.length > 0) {
		diagnostics.push(
			`workerDelegation.modelPins in ${scope} settings contains unknown fields: ${unknownKeys.join(", ")}`,
		);
	}
	const settings: WorkerModelPinsSettings = {};
	if (Object.hasOwn(value, "default")) {
		const binding = parseBinding(value.default, scope, "default", diagnostics);
		if (binding) settings.default = binding;
	}
	if (Object.hasOwn(value, "roles")) {
		if (!isPlainRecord(value.roles)) {
			diagnostics.push(`workerDelegation.modelPins.roles in ${scope} settings must be an object`);
		} else {
			const roles: Partial<Record<WorkerRole, OrchestrationModelBinding>> = {};
			for (const [role, candidate] of Object.entries(value.roles)) {
				if (!WORKER_ROLE_SET.has(role)) {
					diagnostics.push(`workerDelegation.modelPins.roles in ${scope} settings contains unknown role: ${role}`);
					continue;
				}
				const binding = parseBinding(candidate, scope, `roles.${role}`, diagnostics);
				if (binding) roles[role as WorkerRole] = binding;
			}
			settings.roles = roles;
		}
	}
	return { present: true, settings, diagnostics };
}

function pinFromLayer(layer: NormalizedPinLayer | undefined, role: WorkerRole): ResolvedWorkerModelPin | undefined {
	if (!layer) return undefined;
	const binding = layer.settings.roles?.[role] ?? layer.settings.default;
	return binding ? { binding: cloneBinding(binding), source: layer.source } : undefined;
}

function pinFromLocalLayers(
	directoryLayer: NormalizedPinLayer | undefined,
	projectLayer: NormalizedPinLayer | undefined,
	role: WorkerRole,
): ResolvedWorkerModelPin | undefined {
	const roleLayer = directoryLayer?.settings.roles?.[role]
		? directoryLayer
		: projectLayer?.settings.roles?.[role]
			? projectLayer
			: undefined;
	const roleBinding = roleLayer?.settings.roles?.[role];
	if (roleLayer && roleBinding) {
		return {
			binding: cloneBinding(roleBinding),
			source: roleLayer.source,
		};
	}
	const defaultLayer = directoryLayer?.settings.default
		? directoryLayer
		: projectLayer?.settings.default
			? projectLayer
			: undefined;
	return defaultLayer?.settings.default
		? { binding: cloneBinding(defaultLayer.settings.default), source: defaultLayer.source }
		: undefined;
}

/** Compile independently validated settings scopes into one immutable admission policy. */
export function compileWorkerModelPinPolicy(layers: WorkerModelPinPolicyLayers): WorkerModelPinPolicy {
	const global = parseLayer(layers.global, "global");
	const project = parseLayer(layers.project, "project");
	const directoryProfile = parseLayer(layers.directoryProfile, "directoryProfile");
	const diagnostics = [...global.diagnostics, ...project.diagnostics, ...directoryProfile.diagnostics];
	if (diagnostics.length > 0) return { status: "invalid", diagnostics };
	if (!global.present && !project.present && !directoryProfile.present) return { status: "absent" };

	const globalLayer = global.settings ? { settings: global.settings, source: "global" as const } : undefined;
	const projectLayer = project.settings ? { settings: project.settings, source: "project" as const } : undefined;
	const directoryLayer = directoryProfile.settings
		? { settings: directoryProfile.settings, source: "directoryProfile" as const }
		: undefined;
	const byRole: Partial<Record<WorkerRole, ResolvedWorkerModelPin>> = {};
	for (const role of WORKER_ROLES) {
		const pin = pinFromLayer(globalLayer, role) ?? pinFromLocalLayers(directoryLayer, projectLayer, role);
		if (pin) byRole[role] = pin;
	}
	return Object.keys(byRole).length > 0 ? { status: "active", byRole } : { status: "absent" };
}

export function resolveWorkerModelPin(
	policy: WorkerModelPinPolicy,
	role: WorkerRole,
): ResolvedWorkerModelPin | undefined {
	if (policy.status !== "active") return undefined;
	const pin = policy.byRole[role];
	return pin ? { binding: cloneBinding(pin.binding), source: pin.source } : undefined;
}
