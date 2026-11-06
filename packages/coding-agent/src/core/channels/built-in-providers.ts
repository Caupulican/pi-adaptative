/**
 * The transports Pi ships. A built-in channel starts hands-off under an explicit `channels.<name>` policy unless a
 * deployment wrapper registered a provider of the same name (the wrapper's wins). Every other transport still comes
 * from a wrapper.
 */

import type { ChannelProvider } from "../gateways/channel-provider.ts";
import type { ResolvedChannelPolicy } from "./channel-policy.ts";
import { SLACK_CHANNEL, SlackChannelProvider } from "./slack-channel-provider.ts";
import { TELEGRAM_CHANNEL, TelegramChannelProvider } from "./telegram-channel-provider.ts";

export interface BuiltInChannelProviderDeps {
	readonly agentDir: string;
	readonly fetch?: typeof globalThis.fetch;
	/** The WebSocket constructor a socket transport (Slack) opens its connection with; the runtime's global one when omitted. */
	readonly webSocket?: typeof globalThis.WebSocket;
	readonly warn: (message: string) => void;
}

/** Whether `name` has a shipped transport. */
export function isBuiltInChannel(name: string): boolean {
	return name === TELEGRAM_CHANNEL || name === SLACK_CHANNEL;
}

/** The shipped transport for `channel`, or undefined for a name that is not built in. Starts nothing by itself. */
export function createBuiltInChannelProvider(
	channel: string,
	_policy: ResolvedChannelPolicy,
	deps: BuiltInChannelProviderDeps,
): ChannelProvider | undefined {
	const fetch = deps.fetch ? { fetch: deps.fetch } : {};
	if (channel === TELEGRAM_CHANNEL)
		return new TelegramChannelProvider({ agentDir: deps.agentDir, warn: deps.warn, ...fetch });
	if (channel === SLACK_CHANNEL)
		return new SlackChannelProvider({
			agentDir: deps.agentDir,
			...fetch,
			...(deps.webSocket ? { webSocket: deps.webSocket } : {}),
		});
	return undefined;
}
