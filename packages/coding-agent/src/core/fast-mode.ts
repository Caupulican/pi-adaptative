import {
	type Api,
	isModelServiceTierAdvertised,
	type Model,
	type ModelServiceTier,
	type ServiceTier,
} from "@caupulican/pi-ai";

export type FastModeKind = "service-tier";
export type FastModePreference = boolean | "ultrafast";
export type FastModeTier = "priority" | "ultrafast";

interface FastModeSettings {
	getFastModePreference(provider: string): FastModePreference | undefined;
	setFastModePreference(provider: string, preference: FastModePreference): void;
}

export interface FastModeSession {
	readonly model: Model<Api> | undefined;
	readonly settingsManager: FastModeSettings;
	getFastModeServiceTiers?(model: Model<Api>): readonly ModelServiceTier[] | undefined;
}

export interface FastModeStatus {
	available: boolean;
	changed: boolean;
	enabled: boolean;
	kind?: FastModeKind;
	tier?: FastModeTier | "default";
	reason?: string;
}

function supportsFastMode(model: Model<Api> | undefined): boolean {
	return model?.provider === "openai-codex" || (model?.provider === "xai" && model.api === "openai-responses");
}

export function getFastModeStatus(session: FastModeSession): FastModeStatus {
	if (!supportsFastMode(session.model) || !session.model) {
		return { available: false, changed: false, enabled: false };
	}
	const preference = session.settingsManager.getFastModePreference(session.model.provider);
	const tier = resolveFastModeServiceTier(
		session.model,
		preference,
		session.getFastModeServiceTiers?.(session.model) ?? session.model.serviceTiers,
	);
	return {
		available: true,
		changed: false,
		enabled: tier === "priority" || tier === "ultrafast",
		kind: "service-tier",
		tier: tier === "priority" || tier === "ultrafast" ? tier : "default",
		...(preference && tier === undefined
			? {
					reason: `The model/account catalog does not advertise ${preference === "ultrafast" ? "ultrafast" : "priority"}.`,
				}
			: {}),
	};
}

export function setFastMode(session: FastModeSession, enabled: FastModePreference): FastModeStatus {
	if (!supportsFastMode(session.model) || !session.model) {
		return { available: false, changed: false, enabled: false };
	}

	const tiers = session.getFastModeServiceTiers?.(session.model) ?? session.model.serviceTiers;
	if (enabled && resolveFastModeServiceTier(session.model, enabled, tiers) === undefined) {
		return {
			available: false,
			changed: false,
			enabled: false,
			reason: `The model/account catalog does not advertise ${enabled === "ultrafast" ? "ultrafast" : "priority"}.`,
		};
	}
	const previousPreference = session.settingsManager.getFastModePreference(session.model.provider);
	session.settingsManager.setFastModePreference(session.model.provider, enabled);
	return { ...getFastModeStatus(session), changed: previousPreference !== enabled };
}

export function toggleFastMode(session: FastModeSession): FastModeStatus {
	const status = getFastModeStatus(session);
	return status.available ? setFastMode(session, !status.enabled) : status;
}

export function resolveFastModeServiceTier(
	model: Model<Api>,
	preference: FastModePreference | undefined,
	serviceTiers: readonly ModelServiceTier[] | undefined = model.serviceTiers,
): ServiceTier | undefined {
	if (!supportsFastMode(model) || preference === undefined) return undefined;
	if (!preference) return "default";
	const tier = preference === "ultrafast" ? "ultrafast" : "priority";
	if (tier === "ultrafast" && model.provider !== "openai-codex") return undefined;
	if (
		model.provider === "openai-codex" &&
		(serviceTiers !== undefined || tier === "ultrafast") &&
		!isModelServiceTierAdvertised(model, tier, serviceTiers)
	)
		return undefined;
	return tier;
}
