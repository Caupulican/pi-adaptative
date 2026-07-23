import type { CompileExecutionGrantInput, PolicyCompilationResult } from "./policy-compiler.ts";
import { ExecutionPolicyCompiler } from "./policy-compiler.ts";
import type { DurableTaskRuntime } from "./task-runtime.ts";

export interface ExecutionPolicyGateOptions {
	runtime: DurableTaskRuntime;
	compiler?: ExecutionPolicyCompiler;
}

/**
 * Atomic control-plane seam between policy evaluation and durable task state. An allow result binds
 * its grant before execution can lease the attempt; an approval result persists the owner request.
 */
export class ExecutionPolicyGate {
	private readonly runtime: DurableTaskRuntime;
	private readonly compiler: ExecutionPolicyCompiler;

	constructor(options: ExecutionPolicyGateOptions) {
		this.runtime = options.runtime;
		this.compiler = options.compiler ?? new ExecutionPolicyCompiler();
	}

	evaluate(input: CompileExecutionGrantInput): PolicyCompilationResult {
		const result = this.compiler.compile(input);
		if (result.outcome === "allow") {
			this.runtime.bindAttemptGrant(input.attemptId, result.grant.grantId);
		} else if (result.outcome === "approval-required") {
			this.runtime.requestApproval(result.approval);
		}
		return result;
	}
}
