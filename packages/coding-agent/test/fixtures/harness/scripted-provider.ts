import {
	type AssistantMessage,
	AssistantMessageEventStream,
	type Context,
	createEmptyUsage,
	type Model,
	registerApiProvider,
	type SimpleStreamOptions,
	type StreamOptions,
	type ToolCall,
	type Usage,
	unregisterApiProviders,
} from "@caupulican/pi-ai";

export const HARNESS_API = "harness-script";
export const HARNESS_PROVIDER = "harness-script";

export interface ScriptedRequest {
	readonly sequence: number;
	readonly model: Model<typeof HARNESS_API>;
	readonly context: Context;
	readonly options: StreamOptions | undefined;
}

export interface ScriptedReply {
	content: AssistantMessage["content"];
	stopReason?: AssistantMessage["stopReason"];
	errorMessage?: string;
	/** Actual externally reported accounting, consumed by the native budget owners. */
	usage?: Usage;
}

export interface ScriptedPartialFrame {
	readonly partialContent: AssistantMessage["content"];
	readonly event:
		| { type: "text_start" | "toolcall_start"; contentIndex: number }
		| { type: "text_delta" | "toolcall_delta"; contentIndex: number; delta: string }
		| { type: "text_end"; contentIndex: number; content: string }
		| { type: "toolcall_end"; contentIndex: number; toolCall: ToolCall };
	readonly gate?: Promise<void>;
	check?(request: ScriptedRequest): void;
}

export interface ScriptStep {
	name: string;
	gate?: Promise<void>;
	/** Late-result control: ignore only the request's abort; provider disposal still cancels and joins this producer. */
	ignoresAbort?: boolean;
	/** Explicit failed-physical-join control; the scenario MUST eventually release its gate and join this producer. */
	ignoresLifetimeAbort?: boolean;
	frames?: readonly ScriptedPartialFrame[];
	check?(request: ScriptedRequest): void;
	/** Synchronous observation of the actual terminal emitted by this transport, including late or canceled terminals. */
	onTerminal?(request: ScriptedRequest, message: AssistantMessage): void;
	/** Retain this step until a real production request carries the expected evidence. No requests are generated. */
	until?(request: ScriptedRequest): boolean;
	/** Bound repeated production requests; defaults to 32. Exhaustion is a script failure. */
	maxRequests?: number;
	/** Reply callbacks are synchronous; controlled asynchronous ordering belongs in the cancellable gate. */
	reply: ScriptedReply | ((request: ScriptedRequest) => ScriptedReply);
}

interface ScriptTrack {
	readonly modelId: string;
	readonly matches?: (request: ScriptedRequest) => boolean;
	readonly steps: ScriptStep[];
}

export interface Barrier {
	promise: Promise<void>;
	release(): void;
}

export function createBarrier(): Barrier {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}

export function text(name: string, value: string): ScriptStep {
	return { name, reply: { content: [{ type: "text", text: value }] } };
}

export function calls(
	name: string,
	toolCalls: readonly { id: string; name: string; arguments: Record<string, unknown> }[],
): ScriptStep {
	return {
		name,
		reply: {
			content: toolCalls.map((call): ToolCall => ({ type: "toolCall", ...structuredClone(call) })),
			stopReason: "toolUse",
		},
	};
}

export function fail(name: string, errorMessage: string): ScriptStep {
	return { name, reply: { content: [], stopReason: "error", errorMessage } };
}

/** Script only the provider boundary: the session and every child still run their production loop. */
export class ScriptedProvider {
	readonly requests: ScriptedRequest[] = [];
	readonly reached: string[] = [];
	readonly failures: string[] = [];
	readonly terminals: Array<{
		sequence: number;
		modelId: string;
		stopReason: AssistantMessage["stopReason"];
		requestAborted: boolean;
		ignoredRequestAbort: boolean;
	}> = [];
	private readonly scripts = new Map<string, ScriptTrack>();
	private readonly modelOptions = new Map<
		string,
		Partial<Pick<Model<typeof HARNESS_API>, "cost" | "contextWindow" | "maxTokens" | "input">>
	>();
	private readonly stepRequests = new Map<ScriptStep, number>();
	private readonly active = new Set<AbortController>();
	private readonly producers = new Set<Promise<void>>();
	private lastTimestamp = 0;
	private readonly sourceId: string;
	private registered = false;
	private disposed = false;
	private readonly lifetimeAbort = new AbortController();

	constructor(sourceId = "harness-script") {
		this.sourceId = sourceId;
	}

	model(id: string, contextWindow = 32768): Model<typeof HARNESS_API> {
		return {
			id,
			name: `Scripted ${id}`,
			api: HARNESS_API,
			provider: HARNESS_PROVIDER,
			baseUrl: "https://harness.invalid",
			reasoning: false,
			input: ["text"],
			contextWindow,
			maxTokens: 4096,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			...structuredClone(this.modelOptions.get(id) ?? {}),
		};
	}

	configureModel(
		id: string,
		options: Partial<Pick<Model<typeof HARNESS_API>, "cost" | "contextWindow" | "maxTokens" | "input">>,
	): void {
		if (this.requests.length || this.disposed) throw new Error("Configure model metadata before requests start");
		this.modelOptions.set(id, structuredClone(options));
	}

	enqueue(modelId: string, ...steps: ScriptStep[]): void {
		this.enqueueTrack(modelId, modelId, undefined, ...steps);
	}

	/** Route concurrent same-model actors by their actual request context; ambiguity fails closed. */
	enqueueTrack(
		trackId: string,
		modelId: string,
		matches: ((request: ScriptedRequest) => boolean) | undefined,
		...steps: ScriptStep[]
	): void {
		if (this.disposed || this.lifetimeAbort.signal.aborted)
			throw new Error("Cannot enqueue work after provider cutoff");
		if (matches?.constructor.name === "AsyncFunction")
			throw new TypeError("Script track selection must be synchronous");
		for (const step of steps) {
			for (const callback of [
				step.reply,
				step.check,
				step.until,
				step.onTerminal,
				...(step.frames?.map((frame) => frame.check) ?? []),
			]) {
				if (typeof callback === "function" && callback.constructor.name === "AsyncFunction") {
					throw new TypeError(`Step ${step.name} must use synchronous callbacks and an external gate`);
				}
			}
			if (
				step.ignoresLifetimeAbort &&
				(!step.ignoresAbort || (!step.gate && !step.frames?.some((frame) => frame.gate)))
			) {
				throw new Error(`Step ${step.name} requires an explicit gated request-abort-ignoring lifetime control`);
			}
			if (step.maxRequests !== undefined && (!Number.isSafeInteger(step.maxRequests) || step.maxRequests < 1)) {
				throw new RangeError(`Step ${step.name} requires a positive bounded maxRequests`);
			}
		}
		const script = this.scripts.get(trackId);
		if (script && (script.modelId !== modelId || script.matches !== matches))
			throw new Error(`Track ${trackId} identity changed`);
		const track = script ?? { modelId, matches, steps: [] };
		track.steps.push(...steps);
		this.scripts.set(trackId, track);
	}

	/** Scenario phase boundary by track identity (the model id for default tracks), not physical settlement. */
	getPendingStepNames(trackId: string): readonly string[] {
		return (this.scripts.get(trackId)?.steps ?? []).map((step) => step.name);
	}

	register(): void {
		if (this.registered || this.disposed) throw new Error("Provider registration lifetime is invalid");
		const stream = (model: Model<typeof HARNESS_API>, context: Context, options?: StreamOptions) =>
			this.stream(model, context, options);
		registerApiProvider(
			{
				api: HARNESS_API,
				stream,
				streamSimple: (model, context, options?: SimpleStreamOptions) => stream(model, context, options),
			},
			this.sourceId,
		);
		this.registered = true;
	}

	assertDrained(): void {
		const remaining = [...this.scripts].flatMap(([trackId, track]) =>
			track.steps.map((step) => `${trackId}:${step.name}`),
		);
		if (remaining.length || this.active.size || this.producers.size || this.failures.length) {
			throw new Error(
				`Script not settled: pending=${remaining.join(",")}; active=${this.active.size}; producers=${this.producers.size}; failures=${this.failures.join(";")}`,
			);
		}
	}

	async dispose(): Promise<void> {
		this.disposed = true;
		this.cancelPending();
		const failures: unknown[] = [];
		try {
			this.unregister();
		} catch (error) {
			failures.push(error);
		}
		failures.push(...(await this.joinProducerFailures()));
		if (failures.length) throw new AggregateError(failures, "Scripted provider producer cleanup failed");
	}

	/**
	 * Join transport work after its native owners stop, keeping registration and pending scripts for a fresh owner.
	 * This does not close admission or judge native outcomes; sticky script failures remain subject to assertDrained.
	 */
	async waitForProducers(): Promise<void> {
		const failures = await this.joinProducerFailures();
		if (failures.length) throw new AggregateError(failures, "Scripted provider producer join failed");
	}

	private async joinProducerFailures(): Promise<unknown[]> {
		const failures: unknown[] = [];
		while (this.producers.size > 0) {
			const settled = await Promise.allSettled([...this.producers]);
			failures.push(...settled.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])));
		}
		return failures;
	}

	/** Begin world-level transport cutoff without unregistering while production shutdown is still unwinding. */
	cancelPending(): void {
		this.lifetimeAbort.abort(new Error("Scripted provider disposed"));
		for (const controller of this.active) controller.abort(this.lifetimeAbort.signal.reason);
	}

	/** Synchronous rollback only before a partially constructed world has started any producer. */
	rollbackRegistration(): void {
		if (this.active.size || this.producers.size) throw new Error("Provider rollback requires no started producers");
		this.disposed = true;
		this.lifetimeAbort.abort(new Error("Scripted provider construction rolled back"));
		this.unregister();
	}

	private unregister(): void {
		if (this.registered) unregisterApiProviders(this.sourceId);
		this.registered = false;
	}

	private stream(
		model: Model<typeof HARNESS_API>,
		context: Context,
		options: StreamOptions | undefined,
	): AssistantMessageEventStream {
		if (this.disposed || this.lifetimeAbort.signal.aborted) {
			const detail = "Provider request after lifetime cutoff";
			this.failures.push(detail);
			throw new Error(detail);
		}
		const stream = new AssistantMessageEventStream();
		const request: ScriptedRequest = {
			sequence: this.requests.length + 1,
			model: structuredClone(model),
			context: structuredClone(context),
			options,
		};
		this.requests.push(request);
		const controller = new AbortController();
		this.active.add(controller);
		const forwardAbort = () => controller.abort(options?.signal?.reason);
		options?.signal?.addEventListener("abort", forwardAbort, { once: true });
		if (options?.signal?.aborted || this.disposed || this.lifetimeAbort.signal.aborted) forwardAbort();
		const producer = Promise.resolve()
			.then(() => this.produce(stream, request, controller.signal))
			.finally(() => {
				this.active.delete(controller);
				this.producers.delete(producer);
				options?.signal?.removeEventListener("abort", forwardAbort);
			});
		this.producers.add(producer);
		void producer.catch((error: unknown) => {
			this.failures.push(error instanceof Error ? error.message : String(error));
		});
		return stream;
	}

	private async produce(
		stream: AssistantMessageEventStream,
		request: ScriptedRequest,
		signal: AbortSignal,
	): Promise<void> {
		this.lastTimestamp = Math.max(Date.now(), this.lastTimestamp + 1);
		const message: AssistantMessage = {
			role: "assistant",
			api: request.model.api,
			provider: request.model.provider,
			model: request.model.id,
			content: [],
			usage: { ...createEmptyUsage(), input: 16, output: 8, totalTokens: 24 },
			stopReason: "stop",
			timestamp: this.lastTimestamp,
		};
		stream.push({ type: "start", partial: structuredClone(message) });
		let step: ScriptStep | undefined;
		let cancellation = signal;
		try {
			const matches = [...this.scripts].filter(
				([, track]) =>
					track.modelId === request.model.id &&
					track.steps.length > 0 &&
					(!track.matches || track.matches(request)),
			);
			if (matches.length !== 1)
				throw new Error(
					`Provider request ${request.sequence} matches ${matches.length} script tracks for ${request.model.id}`,
				);
			const [trackId, track] = matches[0]!;
			const steps = track.steps;
			step = steps?.[0];
			if (step?.ignoresAbort) cancellation = this.lifetimeAbort.signal;
			if (step?.ignoresLifetimeAbort) cancellation = new AbortController().signal;
			if (cancellation.aborted) throw cancellation.reason;
			if (!step) throw new Error(`Unexpected provider request ${request.sequence} for ${request.model.id}`);
			const count = (this.stepRequests.get(step) ?? 0) + 1;
			if (count > (step.maxRequests ?? 32)) throw new Error(`Step ${step.name} exceeded its request bound`);
			this.stepRequests.set(step, count);
			step.check?.(request);
			if (!step.until || step.until(request)) {
				steps!.shift();
				this.stepRequests.delete(step);
			}
			this.reached.push(`${trackId}:${step.name}`);
			if (cancellation.aborted) throw cancellation.reason;
			if (step.gate) {
				let onAbort!: () => void;
				const abort = new Promise<never>((_resolve, reject) => {
					onAbort = () => reject(cancellation.reason);
					cancellation.addEventListener("abort", onAbort, { once: true });
				});
				try {
					await Promise.race([step.gate, abort]);
				} finally {
					cancellation.removeEventListener("abort", onAbort);
				}
			}
			if (cancellation.aborted) throw cancellation.reason;
			const reply = typeof step.reply === "function" ? step.reply(request) : step.reply;
			if (cancellation.aborted) throw cancellation.reason;
			if (reply.usage) message.usage = structuredClone(reply.usage);
			for (const frame of step.frames ?? []) {
				if (cancellation.aborted) throw cancellation.reason;
				frame.check?.(request);
				if (frame.gate) {
					if (cancellation.aborted) throw cancellation.reason;
					let stop!: () => void;
					try {
						await Promise.race([
							frame.gate,
							new Promise<never>((_resolve, reject) => {
								stop = () => reject(cancellation.reason);
								cancellation.addEventListener("abort", stop, { once: true });
							}),
						]);
					} finally {
						cancellation.removeEventListener("abort", stop);
					}
				}
				if (cancellation.aborted) throw cancellation.reason;
				message.content = structuredClone(frame.partialContent);
				stream.push(structuredClone({ ...frame.event, partial: message }));
			}
			message.content = structuredClone(reply.content);
			message.stopReason =
				reply.stopReason ?? (message.content.some((item) => item.type === "toolCall") ? "toolUse" : "stop");
			message.errorMessage = reply.errorMessage;
			for (const [contentIndex, block] of (step.frames === undefined ? message.content : []).entries()) {
				if (block.type === "text") {
					stream.push({ type: "text_start", contentIndex, partial: message });
					stream.push({ type: "text_delta", contentIndex, delta: block.text, partial: message });
					stream.push({ type: "text_end", contentIndex, content: block.text, partial: message });
				} else if (block.type === "toolCall") {
					stream.push({ type: "toolcall_start", contentIndex, partial: message });
					stream.push({
						type: "toolcall_delta",
						contentIndex,
						delta: JSON.stringify(block.arguments),
						partial: message,
					});
					stream.push({ type: "toolcall_end", contentIndex, toolCall: block, partial: message });
				}
			}
			if (message.stopReason === "error" || message.stopReason === "aborted") {
				stream.push({ type: "error", reason: message.stopReason, error: message });
			} else {
				stream.push({ type: "done", reason: message.stopReason, message });
			}
		} catch (error) {
			const cancelled = cancellation.aborted && error === cancellation.reason;
			message.stopReason = cancelled ? "aborted" : "error";
			message.errorMessage = error instanceof Error ? error.message : String(error);
			if (!cancelled) this.failures.push(message.errorMessage);
			stream.push({ type: "error", reason: message.stopReason, error: message });
		} finally {
			stream.end(message);
			this.terminals.push({
				sequence: request.sequence,
				modelId: request.model.id,
				stopReason: message.stopReason,
				requestAborted: signal.aborted,
				ignoredRequestAbort: step?.ignoresAbort === true,
			});
			step?.onTerminal?.(request, structuredClone(message));
		}
	}
}
