import type { BashOperations } from "../../../src/core/tools/schemas/bash.ts";

export interface ShellRequest {
	readonly sequence: number;
	readonly command: string;
	readonly cwd: string;
	readonly detached: boolean;
	readonly environmentNames: readonly string[];
	readonly workerLabel?: string;
}

export interface ShellStep {
	readonly name: string;
	readonly command: string;
	readonly cwd?: string;
	readonly output: string | readonly string[];
	readonly exitCode: number;
	readonly gate?: Promise<void>;
	/** Synchronous external effects on the virtual world; permission and verification owners remain real. */
	check?(request: ShellRequest): void;
	effect?(request: ShellRequest): void;
}

/** Script the existing external shell-execution port, retaining the production bash tool and its receipts. */
export class VirtualShell implements BashOperations {
	readonly requests: ShellRequest[] = [];
	readonly reached: string[] = [];
	readonly failures: string[] = [];
	private readonly steps: ShellStep[] = [];
	private readonly active = new Set<AbortController>();
	private readonly tasks = new Set<Promise<{ exitCode: number | null; cwd: string; initialCwd: string }>>();
	private disposed = false;

	enqueue(...steps: ShellStep[]): void {
		if (this.disposed) throw new Error("Cannot script a disposed shell transport");
		for (const step of steps) {
			if (!Number.isSafeInteger(step.exitCode)) throw new Error("Shell exit code must be a finite integer");
		}
		this.steps.push(...steps);
	}

	readonly exec: BashOperations["exec"] = (command, cwd, options) => {
		const controller = new AbortController();
		let deadline: ReturnType<typeof setTimeout> | undefined;
		let timedOut = false;
		const cancellationError = () => new Error(timedOut ? `timeout:${options.timeout}` : "aborted");
		if (options.timeout !== undefined && Number.isFinite(options.timeout) && options.timeout > 0) {
			deadline = setTimeout(() => {
				if (controller.signal.aborted) return;
				timedOut = true;
				controller.abort();
			}, options.timeout * 1000);
		}
		const forwardAbort = () => controller.abort(options.signal?.reason);
		options.signal?.addEventListener("abort", forwardAbort, { once: true });
		if (options.signal?.aborted || this.disposed) forwardAbort();
		this.active.add(controller);
		const request: ShellRequest = {
			sequence: this.requests.length + 1,
			command,
			cwd,
			detached: options.detached === true,
			environmentNames: Object.keys(options.env ?? {}).sort(),
			workerLabel: options.env?.PI_WORKER_LABEL,
		};
		this.requests.push(request);
		const task = Promise.resolve().then(async () => {
			try {
				if (controller.signal.aborted) throw cancellationError();
				const step = this.steps[0];
				if (!step || step.command !== command || (step.cwd !== undefined && step.cwd !== cwd)) {
					throw new Error(`Unscripted shell request ${request.sequence}: ${command} @ ${cwd}`);
				}
				step.check?.(request);
				this.steps.shift();
				this.reached.push(step.name);
				if (controller.signal.aborted) throw cancellationError();
				if (step.gate) {
					let onAbort!: () => void;
					const cancelled = new Promise<never>((_resolve, reject) => {
						onAbort = () => reject(cancellationError());
						controller.signal.addEventListener("abort", onAbort, { once: true });
					});
					try {
						await Promise.race([step.gate, cancelled]);
					} finally {
						controller.signal.removeEventListener("abort", onAbort);
					}
				}
				if (controller.signal.aborted) throw cancellationError();
				step.effect?.(request);
				for (const chunk of typeof step.output === "string" ? [step.output] : step.output) {
					if (controller.signal.aborted) throw cancellationError();
					options.onData(Buffer.from(chunk));
				}
				if (controller.signal.aborted) throw cancellationError();
				return { exitCode: step.exitCode, cwd, initialCwd: cwd };
			} catch (error) {
				if (!controller.signal.aborted) this.failures.push(error instanceof Error ? error.message : String(error));
				throw error;
			} finally {
				clearTimeout(deadline);
				this.active.delete(controller);
				this.tasks.delete(task);
				options.signal?.removeEventListener("abort", forwardAbort);
			}
		});
		this.tasks.add(task);
		return task;
	};

	assertDrained(): void {
		if (this.steps.length || this.active.size || this.tasks.size || this.failures.length) {
			throw new Error(
				`Shell not settled: pending=${this.steps.map((step) => step.name).join(",")}; active=${this.active.size}; tasks=${this.tasks.size}; failures=${this.failures.join(";")}`,
			);
		}
	}

	async dispose(): Promise<void> {
		this.disposed = true;
		for (const controller of this.active) controller.abort();
		const tasks = await Promise.allSettled([...this.tasks]);
		const unexpected = tasks.flatMap((result) =>
			result.status === "rejected" &&
			!(
				result.reason instanceof Error &&
				(result.reason.message === "aborted" || result.reason.message.startsWith("timeout:"))
			)
				? [result.reason]
				: [],
		);
		if (unexpected.length) throw new AggregateError(unexpected, "Virtual shell producer cleanup failed");
	}
}
