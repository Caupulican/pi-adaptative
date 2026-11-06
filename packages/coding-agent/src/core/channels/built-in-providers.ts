/**
 * The transports Pi ships. A built-in channel starts hands-off under an explicit `channels.<name>` policy unless a
 * deployment wrapper registered a provider of the same name (the wrapper's wins). Every other transport still comes
 * from a wrapper.
 */

import type { ChannelProvider } from "../gateways/channel-provider.ts";
import type { ResolvedChannelPolicy } from "./channel-policy.ts";
import { TELEGRAM_CHANNEL, TelegramChannelProvider } from "./telegram-channel-provider.ts";

export interface BuiltInChannelProviderDeps {
	readonly agentDir: string;
	readonly fetch?: typeof globalThis.fetch;
	readonly warn: (message: string) => void;
}

/** Whether `name` has a shipped transport. */
export function isBuiltInChannel(name: string): boolean {
	return name === TELEGRAM_CHANNEL;
}

/** The shipped transport for `channel`, or undefined for a name that is not built in. Starts nothing by itself. */
export function createBuiltInChannelProvider(
	channel: string,
	_policy: ResolvedChannelPolicy,
	deps: BuiltInChannelProviderDeps,
): ChannelProvider | undefined {
	if (channel !== TELEGRAM_CHANNEL) return undefined;
	return new TelegramChannelProvider({
		agentDir: deps.agentDir,
		warn: deps.warn,
		...(deps.fetch ? { fetch: deps.fetch } : {}),
	});
}
