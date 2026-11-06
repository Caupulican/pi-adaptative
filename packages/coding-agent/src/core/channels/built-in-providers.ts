/**
 * The transports Pi ships. A built-in channel starts hands-off under an explicit `channels.<name>` policy unless a
 * deployment wrapper registered a provider of the same name (the wrapper's wins). Every other transport still comes
 * from a wrapper.
 */

import type { ChannelProvider } from "../gateways/channel-provider.ts";
import type { TimerPort } from "../util/timer-port.ts";
import type { ResolvedChannelPolicy } from "./channel-policy.ts";
import { GMAIL_CHANNEL, GmailChannelProvider } from "./gmail-channel-provider.ts";
import { SLACK_CHANNEL, SlackChannelProvider } from "./slack-channel-provider.ts";
import { TELEGRAM_CHANNEL, TelegramChannelProvider } from "./telegram-channel-provider.ts";

export interface BuiltInChannelProviderDeps {
	readonly agentDir: string;
	readonly fetch?: typeof globalThis.fetch;
	/** The WebSocket constructor a socket transport (Slack) opens its connection with; the runtime's global one when omitted. */
	readonly webSocket?: typeof globalThis.WebSocket;
	readonly warn: (message: string) => void;
	/** The schedule clock of a transport that polls (Gmail: `channel-poll`); the system clock when omitted. */
	readonly timers?: TimerPort;
}

/** Whether `name` has a shipped transport. */
export function isBuiltInChannel(name: string): boolean {
	return name === TELEGRAM_CHANNEL || name === SLACK_CHANNEL || name === GMAIL_CHANNEL;
}

/** The providers this module built: only these are Pi's own transports, however they were registered. */
const shippedProviders = new WeakSet<ChannelProvider>();

/**
 * Whether `provider` is a transport Pi ships, built by {@link createBuiltInChannelProvider}: its errors and start
 * rejections are Pi's own words. A wrapper's provider is not, whatever it declares, and neither is one that wraps a
 * shipped provider.
 */
export function isShippedChannelProvider(provider: ChannelProvider | undefined): boolean {
	return provider !== undefined && shippedProviders.has(provider);
}

function buildShipped(channel: string, deps: BuiltInChannelProviderDeps): ChannelProvider | undefined {
	const fetch = deps.fetch ? { fetch: deps.fetch } : {};
	if (channel === TELEGRAM_CHANNEL)
		return new TelegramChannelProvider({ agentDir: deps.agentDir, warn: deps.warn, ...fetch });
	if (channel === SLACK_CHANNEL)
		return new SlackChannelProvider({
			agentDir: deps.agentDir,
			...fetch,
			...(deps.webSocket ? { webSocket: deps.webSocket } : {}),
		});
	if (channel === GMAIL_CHANNEL)
		return new GmailChannelProvider({
			agentDir: deps.agentDir,
			warn: deps.warn,
			...fetch,
			...(deps.timers ? { timers: deps.timers } : {}),
		});
	return undefined;
}

/** The shipped transport for `channel`, or undefined for a name that is not built in. Starts nothing by itself. */
export function createBuiltInChannelProvider(
	channel: string,
	_policy: ResolvedChannelPolicy,
	deps: BuiltInChannelProviderDeps,
): ChannelProvider | undefined {
	const provider = buildShipped(channel, deps);
	if (provider) shippedProviders.add(provider);
	return provider;
}
