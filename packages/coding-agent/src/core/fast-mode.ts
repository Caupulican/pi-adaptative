import {
	type Api,
	isModelServiceTierAdvertised,
	type Model,
	type ModelServiceTier,
	resolveXaiBuildModelId,
	type ServiceTier,
} from "@caupulican/pi-ai";

export type FastModeKind = "service-tier" | "model";
export type FastModePreference = boolean | "ultrafast";
export type FastModeTier = "priority" | "ultrafast";

interface FastModeSettings {
	getFastModePreference(provider: string): FastModePreference | undefined;
	setFastModePreference(provider: string, preference: FastModePreference): void;
}

/** What the account catalog says about a model's speed tiers: the advertised ones, and the one it applies when none is saved. */
export interface FastModeCatalog {
	readonly tiers: readonly ModelServiceTier[] | undefined;
	readonly defaultTier: string | undefined;
}

export interface FastModeSession {
	readonly model: Model<Api> | undefined;
	readonly settingsManager: FastModeSettings;
	getFastModeCatalog?(model: Model<Api>): FastModeCatalog;
}

export interface FastModeStatus {
	available: boolean;
	changed: boolean;
	enabled: boolean;
	kind?: FastModeKind;
	tier?: FastModeTier | "default";
	/** The tier comes from the account catalog's default, not from a saved choice. */
	catalogDefault?: boolean;
	reason?: string;
}

function supportsFastMode(model: Model<Api> | undefined): boolean {
	return model?.provider === "openai-codex" || (model?.provider === "xai" && model.api === "openai-responses");
}

function catalogOf(session: FastModeSession, model: Model<Api>): FastModeCatalog {
	return session.getFastModeCatalog?.(model) ?? { tiers: model.serviceTiers, defaultTier: model.defaultServiceTier };
}

export function getFastModeStatus(session: FastModeSession): FastModeStatus {
	if (!supportsFastMode(session.model) || !session.model) {
		return { available: false, changed: false, enabled: false };
	}
	const preference = session.settingsManager.getFastModePreference(session.model.provider);
	const catalog = catalogOf(session, session.model);
	const tier = resolveFastModeServiceTier(session.model, preference, catalog.tiers, catalog.defaultTier);
	const buildModelId = resolveXaiBuildModelId(session.model, tier);
	return {
		available: true,
		changed: false,
		enabled: buildModelId ? buildModelId === "grok-4.7-build-fast" : tier === "priority" || tier === "ultrafast",
		kind: buildModelId ? "model" : "service-tier",
		tier: tier === "priority" || tier === "ultrafast" ? tier : "default",
		...(preference === undefined && (tier === "priority" || tier === "ultrafast") ? { catalogDefault: true } : {}),
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

	const catalog = catalogOf(session, session.model);
	if (enabled && resolveFastModeServiceTier(session.model, enabled, catalog.tiers) === undefined) {
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

/**
 * A speed command is a toggle on one tier, as in Codex: choosing the tier that is already in effect returns to standard
 * processing, choosing another tier switches to it. `/fast` toggles `priority`, `/ultrafast` toggles `ultrafast`.
 */
export function toggleFastModeTier(session: FastModeSession, tier: FastModeTier): FastModeStatus {
	const status = getFastModeStatus(session);
	if (!status.available) return status;
	const inEffect = status.kind === "model" ? status.enabled && tier === "priority" : status.tier === tier;
	return setFastMode(session, inEffect ? false : tier === "ultrafast" ? "ultrafast" : true);
}

export function toggleFastMode(session: FastModeSession): FastModeStatus {
	return toggleFastModeTier(session, "priority");
}

/**
 * The service tier a request carries. A saved choice wins; with none, the account catalog's default tier applies when the
 * model still advertises it, and otherwise the request names no tier (standard processing).
 */
export function resolveFastModeServiceTier(
	model: Model<Api>,
	preference: FastModePreference | undefined,
	serviceTiers: readonly ModelServiceTier[] | undefined = model.serviceTiers,
	catalogDefaultTier?: string,
): ServiceTier | undefined {
	if (!supportsFastMode(model)) return undefined;
	if (preference === undefined) {
		if (model.provider !== "openai-codex") return undefined;
		return (catalogDefaultTier === "priority" || catalogDefaultTier === "ultrafast") &&
			isModelServiceTierAdvertised(model, catalogDefaultTier, serviceTiers)
			? catalogDefaultTier
			: undefined;
	}
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
