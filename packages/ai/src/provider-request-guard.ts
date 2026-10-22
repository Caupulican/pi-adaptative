import { createAssistantMessage, terminateAssistantStreamWithError } from "./providers/provider-runtime.ts";
import type { Api, Model, StreamOptions } from "./types.ts";
import { AssistantMessageEventStream } from "./utils/event-stream.ts";

/**
 * Consume a request-local guard at the last harness-owned handoff. The callback never reaches a
 * provider, and there is no await between its decision and dispatch. Unguarded options retain identity.
 */
export function dispatchGuardedProviderRequest<TOptions extends StreamOptions, TResult>(
	model: Model<Api>,
	options: TOptions | undefined,
	dispatch: (options: TOptions | undefined) => TResult,
): TResult | AssistantMessageEventStream {
	if (options === undefined || options.requestGuard === undefined) return dispatch(options);
	const guard = options.requestGuard;
	const providerOptions = { ...options };
	delete providerOptions.requestGuard;
	try {
		options?.signal?.throwIfAborted();
		const returned: unknown = guard(model, options?.signal);
		if (returned !== undefined) {
			// A JavaScript caller may bypass the synchronous type contract. Observe its rejection,
			// but never wait for it or allow the provider request to start.
			void Promise.resolve(returned).catch(() => undefined);
			throw new TypeError("Provider request guards must return undefined synchronously.");
		}
		options?.signal?.throwIfAborted();
	} catch (error) {
		const stream = new AssistantMessageEventStream();
		const output = createAssistantMessage(model);
		Object.defineProperty(output, "cause", { value: error, enumerable: false });
		terminateAssistantStreamWithError(stream, output, options?.signal, error, {
			formatError: (failure) => (failure instanceof Error ? failure.message : String(failure)),
		});
		return stream;
	}
	return dispatch(providerOptions);
}
