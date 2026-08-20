import {
	type FastModeSession,
	type FastModeStatus,
	getFastModeStatus,
	setFastMode,
	toggleFastMode,
} from "../../core/fast-mode.ts";

export interface FastModeCommandHost {
	session: FastModeSession;
	showStatus(message: string): void;
}

const FAST_MODE_USAGE = "Usage: /fast [on|off|status]";

function describeFastMode(status: FastModeStatus, statusOnly: boolean, provider: string | undefined): string {
	const state = status.enabled ? "on" : "off";
	const prefix = statusOnly ? `Fast mode is ${state}` : `Fast mode ${state}`;
	const providerName = provider === "xai" ? "Grok" : "Codex";
	return `${prefix}: ${providerName} requests ${status.enabled ? "priority" : "default"} processing.`;
}

export function handleFastModeCommand(host: FastModeCommandHost, text: string): void {
	const args = text.trim().split(/\s+/).slice(1);
	if (args.length > 1 || (args[0] !== undefined && !["on", "off", "status"].includes(args[0]))) {
		host.showStatus(FAST_MODE_USAGE);
		return;
	}

	const action = args[0];
	const result =
		action === "status"
			? getFastModeStatus(host.session)
			: action === "on"
				? setFastMode(host.session, true)
				: action === "off"
					? setFastMode(host.session, false)
					: toggleFastMode(host.session);
	if (!result.available) {
		const model = host.session.model;
		host.showStatus(
			model
				? `Fast mode is unavailable for ${model.provider}/${model.id}.`
				: "Fast mode is unavailable without an active model.",
		);
		return;
	}
	host.showStatus(describeFastMode(result, action === "status", host.session.model?.provider));
}
