import {
	type FastModeSession,
	type FastModeStatus,
	getFastModeStatus,
	setFastMode,
	toggleFastModeTier,
} from "../../core/fast-mode.ts";

export interface FastModeCommandHost {
	session: FastModeSession;
	showStatus(message: string): void;
}

const FAST_MODE_USAGE = "Usage: /fast [on|off|priority|ultrafast|status]";
const ULTRAFAST_USAGE = "Usage: /ultrafast [on|off|status]";

function describeFastMode(status: FastModeStatus, statusOnly: boolean, provider: string | undefined): string {
	const state = status.enabled ? "on" : "off";
	const prefix = statusOnly ? `Fast mode is ${state}` : `Fast mode ${state}`;
	if (status.catalogDefault) {
		return `${prefix}: ${provider === "xai" ? "Grok" : "Codex"} requests ${status.tier} processing, the account catalog's default for this model. /${status.tier === "ultrafast" ? "ultrafast" : "fast"} turns it off.`;
	}
	if (status.kind === "model") {
		return `${prefix}: Grok requests ${status.enabled ? "Grok 4.7 Fast" : "Grok 4.7 standard"}.`;
	}
	const providerName = provider === "xai" ? "Grok" : "Codex";
	return `${prefix}: ${providerName} requests ${status.tier ?? "default"} processing.${
		status.tier === "ultrafast"
			? " Cost uses base rates; Ultrafast pricing is unavailable."
			: status.reason
				? ` ${status.reason}`
				: ""
	}`;
}

/**
 * `/fast` and `/ultrafast`: each toggles its own tier of the model's catalog, as in Codex. Without an argument, choosing the
 * tier already in effect returns to standard processing; `on` and `off` set it explicitly.
 */
export function handleFastModeCommand(host: FastModeCommandHost, text: string): void {
	const [command = "/fast", ...args] = text.trim().split(/\s+/);
	const ultrafast = command === "/ultrafast";
	const allowed = ultrafast ? ["on", "off", "status"] : ["on", "off", "priority", "ultrafast", "status"];
	if (args.length > 1 || (args[0] !== undefined && !allowed.includes(args[0]))) {
		host.showStatus(ultrafast ? ULTRAFAST_USAGE : FAST_MODE_USAGE);
		return;
	}

	const action = args[0];
	const result =
		action === "status"
			? getFastModeStatus(host.session)
			: action === "off"
				? setFastMode(host.session, false)
				: action === "ultrafast" || (ultrafast && action === "on")
					? setFastMode(host.session, "ultrafast")
					: action === "on" || action === "priority"
						? setFastMode(host.session, true)
						: toggleFastModeTier(host.session, ultrafast ? "ultrafast" : "priority");
	if (!result.available) {
		const model = host.session.model;
		host.showStatus(
			model
				? `Fast mode is unavailable for ${model.provider}/${model.id}.${result.reason ? ` ${result.reason}` : ""}`
				: "Fast mode is unavailable without an active model.",
		);
		return;
	}
	host.showStatus(describeFastMode(result, action === "status", host.session.model?.provider));
}
