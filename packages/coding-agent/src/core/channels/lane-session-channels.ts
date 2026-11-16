/**
 * The channels core a session's background lanes own (`BackgroundLaneController.channels`), built over the controller's
 * deps: the owner's channel policies with the joined hubs' implicit `link` policy, the owner channel when the session
 * has one, the emergency stop of the agent directory, and the model registry a turn's metered spend is read by. The
 * daemon's host for a channel served away builds its own (`away-channel-host.ts`).
 */
import type { BackgroundLaneControllerDeps } from "../background-lane-deps.ts";
import { isEmergencyStopEngaged, subscribeEmergencyStop } from "../provider-admission/emergency-stop.ts";
import { withLinkPolicy } from "../remote/link-policy.ts";
import { SessionChannels } from "./session-channels.ts";

/** The controller deps the lanes' channels core reads, declared by this module. */
export type LaneSessionChannelsDeps = Pick<
	BackgroundLaneControllerDeps,
	| "getAgentDir"
	| "getSessionManager"
	| "getSettingsManager"
	| "getModelRegistry"
	| "subscribeForegroundActivity"
	| "sendUserMessage"
	| "ownerChannel"
	| "observeHarnessNotice"
	| "isDisposed"
	| "standing"
	| "refreshToolRegistry"
	| "getTimers"
>;

/** The channels core of a session's background lanes; `warn` never throws. */
export function createLaneSessionChannels(
	deps: LaneSessionChannelsDeps,
	warn: (message: string) => void,
): SessionChannels {
	return new SessionChannels({
		getAgentDir: () => deps.getAgentDir(),
		getSessionManager: () => deps.getSessionManager(),
		getChannelPolicies: () => withLinkPolicy(deps.getSettingsManager().getChannelPolicies(), deps.getAgentDir()),
		subscribeSettings: (listener) => deps.getSettingsManager().subscribeChanges(listener),
		subscribeForegroundActivity: (listener) => deps.subscribeForegroundActivity(listener),
		sendUserMessage: (text, options) => deps.sendUserMessage(text, options),
		...(deps.ownerChannel ? { ownerDelivery: deps.ownerChannel } : {}),
		ownerControl: () => deps.ownerChannel?.control(),
		isEmergencyStopEngaged: () => isEmergencyStopEngaged(deps.getAgentDir()),
		subscribeEmergencyStop: (listener) => subscribeEmergencyStop(deps.getAgentDir(), listener),
		observeNotice: (kind, read, onLost) => deps.observeHarnessNotice?.(kind, read, onLost) ?? false,
		warn,
		isDisposed: () => deps.isDisposed(),
		servesChannels: () => deps.standing.ownsHostDuties,
		refreshTools: () => deps.refreshToolRegistry(),
		timers: deps.getTimers().port("channel-poll"),
		wakeTimers: deps.getTimers().port("channel-expiry"),
		// The channel's dollar bounds count metered (API) spend only (`readBatchOutcome`).
		getModelRegistry: () => deps.getModelRegistry(),
	});
}
