import {
	type FastModeSession,
	type FastModeStatus,
	getFastModeStatus,
	setFastMode,
	toggleFastModeTier,
} from "../../core/fast-mode.ts";
import { interfaceText } from "../../core/language/interface-text.ts";

export interface FastModeCommandHost {
	session: FastModeSession;
	showStatus(message: string): void;
}

function describeFastMode(status: FastModeStatus, statusOnly: boolean, provider: string | undefined): string {
	const text = interfaceText().smallCommands.fastMode;
	const state = status.enabled ? text.on : text.off;
	const prefix = text.prefix(statusOnly, state);
	const providerName = provider === "xai" ? text.providerGrok : text.providerCodex;
	if (status.catalogDefault) {
		return text.catalogDefault({
			prefix,
			provider: providerName,
			tier: status.tier ?? text.defaultTier,
			command: status.tier === "ultrafast" ? "ultrafast" : "fast",
		});
	}
	if (status.kind === "model") {
		return text.modelVariant(prefix, status.enabled);
	}
	return `${text.tier(prefix, providerName, status.tier ?? text.defaultTier)}${
		status.tier === "ultrafast" ? text.ultrafastCost : status.reason ? ` ${status.reason}` : ""
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
		const usage = interfaceText().smallCommands.fastMode;
		host.showStatus(ultrafast ? usage.ultrafastUsage : usage.usage);
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
		const text = interfaceText().smallCommands.fastMode;
		const model = host.session.model;
		host.showStatus(
			model
				? text.unavailableFor(`${model.provider}/${model.id}`, result.reason ? ` ${result.reason}` : "")
				: text.unavailableNoModel,
		);
		return;
	}
	host.showStatus(describeFastMode(result, action === "status", host.session.model?.provider));
}
