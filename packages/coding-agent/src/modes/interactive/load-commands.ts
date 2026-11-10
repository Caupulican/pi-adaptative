/**
 * `/load` and `/estop` — the operator's machine-wide view of provider load, and the one switch that
 * pauses new worker and background work in every pi process on this agent directory.
 */
import { interfaceText } from "../../core/language/interface-text.ts";
import type { ProviderLoadView } from "../../core/provider-admission/load-view.ts";
import { formatProviderLoadView } from "../../core/provider-admission/load-view.ts";

export interface LoadHost {
	getLoadView(): ProviderLoadView;
	/** Returns true when the state changed. */
	setEmergencyStop(engaged: boolean, reason?: string): boolean;
	showStatus(message: string): void;
	showError(message: string): void;
	/** Multi-line output in the conversation (status lines are single rows). */
	showText(text: string): void;
}

export async function handleLoadCommand(host: LoadHost, text: string): Promise<void> {
	const words = interfaceText().machines.load;
	const args = text.replace(/^\/load\b/, "").trim();
	if (args.length > 0) {
		host.showError(words.usage);
		return;
	}
	host.showText(formatProviderLoadView(host.getLoadView()));
}

export async function handleEstopCommand(host: LoadHost, text: string): Promise<void> {
	const words = interfaceText().machines.load;
	const args = text.replace(/^\/estop\b/, "").trim();
	const [action = "status", ...rest] = args.split(/\s+/).filter(Boolean);
	if (action === "status") {
		const stop = host.getLoadView().emergencyStop;
		host.showStatus(
			stop.engaged
				? words.estopStatusOn({ reason: stop.reason, engagedAt: stop.engagedAt, usage: words.estopUsage })
				: words.estopStatusOff(words.estopUsage),
		);
		return;
	}
	if (action === "on") {
		const reason = rest.join(" ").trim() || undefined;
		host.setEmergencyStop(true, reason);
		host.showStatus(words.estopEngaged(reason));
		return;
	}
	if (action === "off") {
		const lifted = host.setEmergencyStop(false);
		host.showStatus(lifted ? words.estopLifted : words.estopNotEngaged);
		return;
	}
	host.showError(words.estopUsage);
}
