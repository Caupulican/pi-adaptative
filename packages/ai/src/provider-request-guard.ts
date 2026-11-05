import { createAssistantMessage, terminateAssistantStreamWithError } from "./providers/provider-runtime.ts";
import type { Api, Model, ProviderResponseTicket, StreamOptions } from "./types.ts";
import { AssistantMessageEventStream } from "./utils/event-stream.ts";

/**
 * Consume a request-local guard at the last harness-owned handoff. The callback never reaches a
 * provider, and there is no await between its decision and dispatch. Unguarded options retain identity.
 */
export function dispatchGuardedProviderRequest<
	TOptions extends StreamOptions,
	TResult extends AssistantMessageEventStream | Promise<AssistantMessageEventStream>,
>(
	model: Model<Api>,
	options: TOptions | undefined,
	dispatch: (options: TOptions | undefined) => TResult,
): TResult | AssistantMessageEventStream {
	if (options === undefined || (!options.requestGuard && !options.providerResponseObserver)) return dispatch(options);
	const guard = options.requestGuard;
	const observer = options.providerResponseObserver;
	const providerOptions = { ...options };
	delete providerOptions.requestGuard;
	delete providerOptions.providerResponseObserver;
	let ticket: ProviderResponseTicket | undefined;
	try {
		options?.signal?.throwIfAborted();
		const returned: unknown = guard?.(model, options?.signal);
		if (returned !== undefined) {
			// A JavaScript caller may bypass the synchronous type contract. Observe its rejection,
			// but never wait for it or allow the provider request to start.
			void Promise.resolve(returned).catch(() => undefined);
			throw new TypeError("Provider request guards must return undefined synchronously.");
		}
		options?.signal?.throwIfAborted();
		ticket = observer?.begin(model, options.signal);
	} catch (error) {
		const stream = new AssistantMessageEventStream();
		const output = createAssistantMessage(model);
		Object.defineProperty(output, "cause", { value: error, enumerable: false });
		terminateAssistantStreamWithError(stream, output, options?.signal, error, {
			formatError: (failure) => (failure instanceof Error ? failure.message : String(failure)),
		});
		return stream;
	}
	try {
		const result = dispatch(providerOptions);
		if (ticket) {
			const settlement = ticket;
			const observe = (stream: AssistantMessageEventStream): void => {
				// result() is independent of event iteration. A watchdog may abandon that iterator.
				void stream.result().then(
					(message) => settlement.complete(message),
					(error) => settlement.failed(error),
				);
			};
			if (result instanceof Promise) void result.then(observe, (error) => settlement.failed(error));
			else observe(result);
		}
		return result;
	} catch (error) {
		ticket?.failed(error);
		throw error;
	}
}
