/** Bounded raw response bodies and SSE frames before a provider SDK buffers or parses them. */

export interface ResponseBounds {
	readonly frameBytes: number;
	readonly bodyBytes: number;
}

class ResponseLimitError extends Error {
	readonly status: number;
	readonly headers: Headers;

	constructor(message: string, response: Response) {
		super(message);
		this.name = "ResponseLimitError";
		this.status = response.status;
		this.headers = response.headers;
	}
}

/** Preserve the native Request when no init is supplied (including Bun's Request semantics). */
export function boundedResponseFetch(bounds: ResponseBounds): typeof fetch {
	const { frameBytes, bodyBytes } = bounds;
	for (const limit of [frameBytes, bodyBytes])
		if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError("Response byte limit must be positive.");
	return async (input, init) => {
		const response = init == null ? await globalThis.fetch(input) : await globalThis.fetch(input, init);
		if (!response.body) return response;
		const signal = init && "signal" in init ? init.signal : input instanceof Request ? input.signal : undefined;
		const sse = response.ok && /^text\/event-stream(?:\s*;|\s*$)/i.test(response.headers.get("content-type") ?? "");
		const body = boundedBody(response, response.body, sse ? frameBytes : bodyBytes, sse, signal ?? undefined);
		const result = new Response(body, {
			status: response.status,
			statusText: response.statusText,
			headers: response.headers,
		});
		Object.defineProperties(result, {
			url: { value: response.url },
			redirected: { value: response.redirected },
			type: { value: response.type },
		});
		return result;
	};
}

function boundedBody(
	response: Response,
	source: ReadableStream<Uint8Array>,
	limit: number,
	sse: boolean,
	signal?: AbortSignal,
): ReadableStream<Uint8Array> {
	const reader = source.getReader();
	let closed = false;
	let chunk: Uint8Array | undefined;
	let position = 0;
	let size = 0;
	let frame = new Uint8Array(Math.min(limit, 4096));
	let lineHasBytes = false;
	let previousCR = false;
	let carriedCR = false;
	let prefixBytes = 0;
	let cleanup: Promise<void> | undefined;
	let downstream: ReadableStreamDefaultController<Uint8Array>;
	const release = (cancel: boolean, reason?: unknown): Promise<void> => {
		if (cleanup) return cleanup;
		closed = true;
		signal?.removeEventListener("abort", abort);
		cleanup = (async () => {
			try {
				if (cancel) await reader.cancel(reason);
			} catch {
				// The original stream error remains authoritative.
			} finally {
				reader.releaseLock();
			}
		})();
		return cleanup;
	};
	const abort = () => {
		if (closed) return;
		downstream.error(signal?.reason ?? new DOMException("Aborted", "AbortError"));
		void release(true, signal?.reason);
	};
	const emitFrame = (carryCR = false) => {
		const result = frame.slice(0, size);
		size = 0;
		lineHasBytes = false;
		previousCR = carryCR;
		carriedCR = carryCR;
		prefixBytes = 0;
		return result;
	};
	const append = (byte: number, prefix = false) => {
		if (!prefix && size - prefixBytes >= limit)
			throw new ResponseLimitError(
				`Provider ${sse ? "SSE frame" : "response body"} exceeded the ${limit} byte limit`,
				response,
			);
		if (size === frame.length) {
			const grown = new Uint8Array(Math.min(limit + 1, frame.length * 2));
			grown.set(frame);
			frame = grown;
		}
		frame[size++] = byte;
		if (prefix) prefixBytes++;
	};
	return new ReadableStream<Uint8Array>(
		{
			start(controller) {
				downstream = controller;
				if (signal?.aborted) abort();
				else signal?.addEventListener("abort", abort, { once: true });
			},
			async pull(controller) {
				try {
					while (!closed) {
						if (!chunk || position === chunk.length) {
							const next = await reader.read();
							if (closed) return;
							if (next.done) {
								if (sse && size > 0) controller.enqueue(emitFrame());
								controller.close();
								await release(false);
								return;
							}
							chunk = next.value;
							position = 0;
							if (!sse) {
								size += chunk.byteLength;
								if (size > limit)
									throw new ResponseLimitError(
										`Provider response body exceeded the ${limit} byte limit`,
										response,
									);
								controller.enqueue(chunk);
								chunk = undefined;
								return;
							}
						}
						while (position < chunk.length) {
							const byte = chunk[position];
							position++;
							const delimiterLF = carriedCR && byte === 10;
							carriedCR = false;
							append(byte, delimiterLF);
							if (previousCR && byte === 10) {
								previousCR = false;
								continue;
							}
							if (byte === 13 || byte === 10) {
								if (!lineHasBytes) {
									// A CR completes a frame immediately, but a following LF may still be part of its delimiter.
									// Reserve that one raw byte before forwarding; never accept a frame over the limit.
									if (byte === 13 && size - prefixBytes === limit)
										throw new ResponseLimitError(
											`Provider SSE frame exceeded the ${limit} byte limit`,
											response,
										);
									controller.enqueue(emitFrame(byte === 13));
									return;
								}
								lineHasBytes = false;
								previousCR = byte === 13;
							} else {
								lineHasBytes = true;
								previousCR = false;
							}
						}
					}
				} catch (error) {
					if (!closed) controller.error(error);
					await release(true, error);
				}
			},
			cancel: (reason) => release(true, reason),
		},
		{ highWaterMark: 0 },
	);
}
