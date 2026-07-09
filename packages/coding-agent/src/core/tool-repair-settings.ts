import type { Settings } from "./settings-manager.ts";

export interface ResolvedToolRepairSettings {
	repair: boolean;
	teach: boolean;
	textProtocol: boolean | undefined;
	logging: boolean;
}

type EnvLike = Record<string, string | undefined>;

function isTruthyEnvFlag(value: string | undefined): boolean {
	if (!value) return false;
	return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

export function resolveToolRepairSettings(
	settings: Pick<Settings, "toolRepair">,
	env: EnvLike,
): ResolvedToolRepairSettings {
	return {
		repair: !isTruthyEnvFlag(env.PI_TOOL_REPAIR_DISABLED),
		teach: !isTruthyEnvFlag(env.PI_TOOL_REPAIR_TEACH_DISABLED) && settings.toolRepair?.teach !== false,
		textProtocol: isTruthyEnvFlag(env.PI_TEXT_TOOL_CALL_PROTOCOL_DISABLED)
			? false
			: settings.toolRepair?.textProtocol,
		logging: settings.toolRepair?.logging !== false,
	};
}

export function resolveCurrentToolRepairSettings(settings: Pick<Settings, "toolRepair">): ResolvedToolRepairSettings {
	return resolveToolRepairSettings(settings, process.env);
}
