/**
 * `/load` and `/estop` — the operator's machine-wide view of provider load, and the one switch that
 * pauses new worker and background work in every pi process on this agent directory.
 */
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

export const LOAD_USAGE = "/load";
export const ESTOP_USAGE = "/estop [status] · /estop on [reason] · /estop off";

export async function handleLoadCommand(host: LoadHost, text: string): Promise<void> {
	const args = text.replace(/^\/load\b/, "").trim();
	if (args.length > 0) {
		host.showError(LOAD_USAGE);
		return;
	}
	host.showText(formatProviderLoadView(host.getLoadView()));
}

export async function handleEstopCommand(host: LoadHost, text: string): Promise<void> {
	const args = text.replace(/^\/estop\b/, "").trim();
	const [action = "status", ...rest] = args.split(/\s+/).filter(Boolean);
	if (action === "status") {
		const stop = host.getLoadView().emergencyStop;
		host.showStatus(
			stop.engaged
				? `Emergency stop: engaged${stop.reason ? ` — ${stop.reason}` : ""}${stop.engagedAt ? ` (since ${stop.engagedAt})` : ""}; new worker and background provider requests are held on this machine. ${ESTOP_USAGE}`
				: `Emergency stop: off. ${ESTOP_USAGE}`,
		);
		return;
	}
	if (action === "on") {
		const reason = rest.join(" ").trim() || undefined;
		host.setEmergencyStop(true, reason);
		host.showStatus(
			`Emergency stop engaged${reason ? ` — ${reason}` : ""}: every pi on this machine holds new worker and background provider requests; foreground turns continue. /estop off lifts it.`,
		);
		return;
	}
	if (action === "off") {
		const lifted = host.setEmergencyStop(false);
		host.showStatus(
			lifted ? "Emergency stop lifted; held work resumes on its next check." : "Emergency stop was not engaged.",
		);
		return;
	}
	host.showError(ESTOP_USAGE);
}
