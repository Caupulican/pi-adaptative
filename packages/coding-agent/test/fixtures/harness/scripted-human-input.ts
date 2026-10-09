import type { ExtensionUIContext } from "../../../src/core/extensions/types.ts";
import type { HumanInputPresentationRequest, HumanInputPresentationResult } from "../../../src/core/human-input.ts";

export interface HumanInputStep {
	readonly name: string;
	readonly gate?: Promise<void>;
	/** Late UI response control; the scenario must eventually release and join its presentation. */
	readonly ignoresAbort?: boolean;
	check?(request: HumanInputPresentationRequest, signal: AbortSignal | undefined): void;
	readonly reply:
		| HumanInputPresentationResult
		| ((request: HumanInputPresentationRequest) => HumanInputPresentationResult);
}

/** Only the external typed question presentation is scripted. Request persistence/replay stays native. */
export class ScriptedHumanInput {
	readonly requests: HumanInputPresentationRequest[] = [];
	readonly reached: string[] = [];
	readonly failures: string[] = [];
	private readonly steps: HumanInputStep[] = [];
	private readonly presentations = new Set<Promise<HumanInputPresentationResult>>();
	private readonly lifetime = new AbortController();
	private readonly cancellations = new WeakSet<Error>();
	readonly ui: ExtensionUIContext;

	constructor() {
		// The UI boundary intentionally supports only askQuestions. A new UI operation must gain an explicit
		// external script instead of being satisfied by a silent stub. This is the checked adapter boundary.
		this.ui = new Proxy(
			{ askQuestions: this.present },
			{
				get: (target, property) => {
					if (property === "askQuestions") return target.askQuestions;
					const detail = `Unscripted human-input UI operation: ${String(property)}`;
					this.failures.push(detail);
					throw new Error(detail);
				},
			},
		) as ExtensionUIContext;
	}

	enqueue(...steps: HumanInputStep[]): void {
		if (this.lifetime.signal.aborted) throw new Error("Human-input admission is closed");
		for (const step of steps) {
			if (step.ignoresAbort && !step.gate) throw new Error("Late UI response requires an explicit gate");
			for (const callback of [step.check, step.reply]) {
				if (typeof callback === "function" && callback.constructor.name === "AsyncFunction")
					throw new TypeError("UI callbacks must be synchronous; ordering belongs in gates");
			}
		}
		this.steps.push(...steps);
	}

	private readonly present: ExtensionUIContext["askQuestions"] = (request, options) => {
		if (this.lifetime.signal.aborted) {
			const detail = "Human-input request after lifetime cutoff";
			this.failures.push(detail);
			return Promise.reject(new Error(detail));
		}
		const observed = structuredClone(request);
		this.requests.push(observed);
		let work!: Promise<HumanInputPresentationResult>;
		work = Promise.resolve().then(async () => {
			let signal = this.lifetime.signal;
			const cancelled = () => {
				const error = new Error("Human-input presentation cancelled");
				this.cancellations.add(error);
				return error;
			};
			try {
				const step = this.steps.shift();
				if (!step) throw new Error(`Unscripted human-input request ${observed.requestId}`);
				signal = AbortSignal.any([
					this.lifetime.signal,
					...(!step.ignoresAbort && options?.signal ? [options.signal] : []),
				]);
				if (signal.aborted) throw cancelled();
				step.check?.(observed, options?.signal);
				this.reached.push(step.name);
				if (signal.aborted) throw cancelled();
				if (step.gate) {
					let stop!: () => void;
					try {
						await Promise.race([
							step.gate,
							new Promise<never>((_resolve, reject) => {
								stop = () => reject(cancelled());
								signal.addEventListener("abort", stop, { once: true });
							}),
						]);
					} finally {
						signal.removeEventListener("abort", stop);
					}
				}
				if (signal.aborted) throw cancelled();
				const reply = typeof step.reply === "function" ? step.reply(observed) : step.reply;
				if (signal.aborted) throw cancelled();
				return structuredClone(reply);
			} catch (error) {
				if (error instanceof Error && this.cancellations.has(error))
					return { answers: [], cancelled: true, reason: "interrupted", imageContents: [] };
				this.failures.push(error instanceof Error ? error.message : String(error));
				throw error;
			} finally {
				this.presentations.delete(work);
			}
		});
		this.presentations.add(work);
		void work.catch(() => undefined);
		return work;
	};

	/** Joins only real UI calls, including a late reply whose native question has already settled. */
	async join(): Promise<void> {
		while (this.presentations.size) await Promise.allSettled([...this.presentations]);
		if (this.failures.length) throw new Error(`Human-input presentation failures: ${this.failures.join(";")}`);
	}

	async dispose(): Promise<void> {
		this.lifetime.abort();
		await this.join();
	}

	assertDrained(): void {
		if (this.steps.length || this.presentations.size || this.failures.length)
			throw new Error(
				`Human input not settled: pending=${this.steps.map((step) => step.name).join(",")}; presentations=${this.presentations.size}; failures=${this.failures.join(";")}`,
			);
	}
}
