import {
	createRollingOutputBuffer,
	type ExecOptions,
	type ExecResult,
	type RollingOutputBuffer,
} from "../../../src/core/exec.ts";
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
	/** External shell-reported directory after a command-local cd; native admission/verification checks remain real. */
	readonly resultCwd?: string;
	readonly output: string | readonly string[];
	readonly stderr?: string | readonly string[];
	readonly exitCode: number;
	readonly gate?: Promise<void>;
	/** Declared external failure, not a script/oracle failure. Native callers must retain its cause. */
	readonly error?: Error;
	readonly ignoresAbort?: boolean;
	/** Synchronous external effects on the virtual world; permission and verification owners remain real. */
	check?(request: ShellRequest): void;
	effect?(request: ShellRequest): void;
}

interface ShellOutcome {
	exitCode: number | null;
	cwd: string;
	initialCwd: string;
	cancellation?: "aborted" | "timeout";
}

interface ShellCapture {
	stdout?: RollingOutputBuffer;
	stderr?: RollingOutputBuffer;
	/** Set only when this execution raises its declared external failure. */
	externalError?: Error;
}

export type ShellProtocolOutcome =
	| { readonly kind: "completed"; readonly result: ShellOutcome }
	| { readonly kind: "cancelled"; readonly cause: Error }
	| { readonly kind: "external-failure"; readonly cause: Error };

/** Script the existing external shell-execution port, retaining the production bash tool and its receipts. */
export class VirtualShell implements BashOperations {
	readonly requests: ShellRequest[] = [];
	readonly reached: string[] = [];
	readonly failures: string[] = [];
	private readonly steps: ShellStep[] = [];
	private readonly active = new Set<AbortController>();
	private readonly tasks = new Set<Promise<ShellOutcome>>();
	private disposed = false;
	private readonly expectedErrors = new Set<Error>();
	private readonly cancellationErrors = new WeakSet<Error>();

	enqueue(...steps: ShellStep[]): void {
		if (this.disposed) throw new Error("Cannot script a disposed shell transport");
		for (const step of steps) {
			if (!Number.isSafeInteger(step.exitCode)) throw new Error("Shell exit code must be a finite integer");
			if (step.ignoresAbort && !step.gate) throw new Error("Uncooperative shell control requires an explicit gate");
			if (step.error) this.expectedErrors.add(step.error);
		}
		this.steps.push(...steps);
	}

	readonly exec: BashOperations["exec"] = (command, cwd, options) => this.execute(command, cwd, options);

	/** External process protocols share this execution's exact cancellation and declared-error classification. */
	execProtocol(
		command: string,
		cwd: string,
		options: Parameters<BashOperations["exec"]>[2],
	): Promise<ShellProtocolOutcome> {
		return this.executeClassified(command, cwd, options, {});
	}

	private async executeClassified(
		command: string,
		cwd: string,
		options: Parameters<BashOperations["exec"]>[2],
		capture: ShellCapture,
	): Promise<ShellProtocolOutcome> {
		try {
			return { kind: "completed", result: await this.execute(command, cwd, options, capture) };
		} catch (error) {
			if (error instanceof Error && this.cancellationErrors.has(error)) return { kind: "cancelled", cause: error };
			if (error instanceof Error && error === capture.externalError)
				return { kind: "external-failure", cause: error };
			throw error;
		}
	}

	private execute(
		command: string,
		cwd: string,
		options: Parameters<BashOperations["exec"]>[2],
		capture?: ShellCapture,
	): Promise<ShellOutcome> {
		const controller = new AbortController();
		let deadline: ReturnType<typeof setTimeout> | undefined;
		let timedOut = false;
		const cancellationError = () => {
			const error = new Error(timedOut ? `timeout:${options.timeout}` : "aborted");
			this.cancellationErrors.add(error);
			return error;
		};
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
		let admittedStep: ShellStep | undefined;
		const isCancelled = () => controller.signal.aborted && admittedStep?.ignoresAbort !== true;
		const task = Promise.resolve().then(async () => {
			try {
				if (isCancelled()) throw cancellationError();
				const step = this.steps[0];
				if (!step || step.command !== command || (step.cwd !== undefined && step.cwd !== cwd)) {
					throw new Error(`Unscripted shell request ${request.sequence}: ${command} @ ${cwd}`);
				}
				admittedStep = step;
				step.check?.(request);
				this.steps.shift();
				this.reached.push(step.name);
				if (isCancelled()) throw cancellationError();
				if (step.gate) {
					let onAbort!: () => void;
					const cancelled = new Promise<never>((_resolve, reject) => {
						onAbort = () => reject(cancellationError());
						if (!step.ignoresAbort) controller.signal.addEventListener("abort", onAbort, { once: true });
					});
					try {
						await Promise.race([step.gate, cancelled]);
					} finally {
						controller.signal.removeEventListener("abort", onAbort);
					}
				}
				if (isCancelled()) throw cancellationError();
				if (step.error) {
					if (capture) capture.externalError = step.error;
					throw step.error;
				}
				step.effect?.(request);
				for (const chunk of typeof step.output === "string" ? [step.output] : step.output) {
					if (isCancelled()) throw cancellationError();
					capture?.stdout?.push(chunk);
					options.onData(Buffer.from(chunk));
				}
				for (const chunk of typeof step.stderr === "string" ? [step.stderr] : (step.stderr ?? [])) {
					if (isCancelled()) throw cancellationError();
					capture?.stderr?.push(chunk);
					options.onData(Buffer.from(chunk));
				}
				if (isCancelled()) throw cancellationError();
				return {
					exitCode: step.exitCode,
					cwd: step.resultCwd ?? cwd,
					initialCwd: cwd,
					...(controller.signal.aborted
						? { cancellation: timedOut ? ("timeout" as const) : ("aborted" as const) }
						: {}),
				};
			} catch (error) {
				if (!(error instanceof Error && (this.cancellationErrors.has(error) || error === admittedStep?.error)))
					this.failures.push(error instanceof Error ? error.message : String(error));
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
	}

	/** Worktree engine shell port. Git remains at VirtualGit; no command reaches a host shell. */
	async execEngine(file: string, args: readonly string[], options: ExecOptions): Promise<ExecResult> {
		if ((file !== "sh" && file !== "cmd") || args.length !== 2 || args[0] !== (file === "sh" ? "-c" : "/c")) {
			const detail = `Unscripted engine shell ${file} ${args.join(" ")}`;
			this.failures.push(detail);
			throw new Error(detail);
		}
		// Native worktree callers supply their bounded buffer; other engine shapes are explicitly unsupported.
		if (options.maxBuffer === undefined || !Number.isFinite(options.maxBuffer) || options.maxBuffer <= 0) {
			const detail = "Engine shell control requires an explicit positive maxBuffer";
			this.failures.push(detail);
			throw new Error(detail);
		}
		if (options.stdin !== undefined) {
			const detail = "Engine gate transport does not support stdin";
			this.failures.push(detail);
			throw new Error(detail);
		}
		const capture = {
			stdout: createRollingOutputBuffer(options.maxBuffer),
			stderr: createRollingOutputBuffer(options.maxBuffer),
		};
		let code = 1;
		let killed = false;
		let errorMessage: string | undefined;
		const outcome = await this.executeClassified(
			args[1]!,
			options.cwd ?? "",
			{
				onData: () => undefined,
				signal: options.signal,
				timeout: options.timeout === undefined ? undefined : options.timeout / 1000,
				env: options.env,
			},
			capture,
		);
		if (outcome.kind === "completed") {
			const result = outcome.result;
			killed = result.cancellation !== undefined;
			code = result.exitCode ?? 1;
		} else if (outcome.kind === "cancelled") killed = true;
		else errorMessage = outcome.cause.message;
		return {
			stdout: capture.stdout.text(),
			stderr: capture.stderr.text(),
			code,
			killed,
			stdoutTruncated: capture.stdout.truncated(),
			stderrTruncated: capture.stderr.truncated(),
			...(errorMessage ? { errorMessage } : {}),
		};
	}

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
			!this.expectedErrors.has(result.reason) &&
			!(result.reason instanceof Error && this.cancellationErrors.has(result.reason))
				? [result.reason]
				: [],
		);
		if (unexpected.length) throw new AggregateError(unexpected, "Virtual shell producer cleanup failed");
	}
}
