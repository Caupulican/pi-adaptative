import type { Api, Model, ServiceTier } from "@caupulican/pi-ai";

export type FastModeKind = "service-tier";

interface FastModeSettings {
	getFastModeEnabled(provider: string): boolean | undefined;
	setFastModeEnabled(provider: string, enabled: boolean): void;
}

export interface FastModeSession {
	readonly model: Model<Api> | undefined;
	readonly settingsManager: FastModeSettings;
}

export interface FastModeStatus {
	available: boolean;
	changed: boolean;
	enabled: boolean;
	kind?: FastModeKind;
}

function supportsFastMode(model: Model<Api> | undefined): boolean {
	return model?.provider === "openai-codex" || (model?.provider === "xai" && model.api === "openai-responses");
}

export function getFastModeStatus(session: FastModeSession): FastModeStatus {
	if (!supportsFastMode(session.model) || !session.model) {
		return { available: false, changed: false, enabled: false };
	}
	return {
		available: true,
		changed: false,
		enabled: session.settingsManager.getFastModeEnabled(session.model.provider) ?? false,
		kind: "service-tier",
	};
}

export function setFastMode(session: FastModeSession, enabled: boolean): FastModeStatus {
	if (!supportsFastMode(session.model) || !session.model) {
		return { available: false, changed: false, enabled: false };
	}

	const previousPreference = session.settingsManager.getFastModeEnabled(session.model.provider);
	session.settingsManager.setFastModeEnabled(session.model.provider, enabled);
	return {
		available: true,
		changed: previousPreference !== enabled,
		enabled,
		kind: "service-tier",
	};
}

export function toggleFastMode(session: FastModeSession): FastModeStatus {
	const status = getFastModeStatus(session);
	return status.available ? setFastMode(session, !status.enabled) : status;
}

export function resolveFastModeServiceTier(
	model: Model<Api>,
	preference: boolean | undefined,
): ServiceTier | undefined {
	if (!supportsFastMode(model) || preference === undefined) return undefined;
	return preference ? "priority" : "default";
}
