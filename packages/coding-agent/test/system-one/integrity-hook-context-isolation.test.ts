import { describe, expect, it } from "vitest";
import type { IntegrityExtension, IntegrityGateResult } from "../../src/core/hooks/index.ts";
import { IntegrityHookCoordinator } from "../../src/core/system-one/integrity-hooks.ts";

const ALLOW: IntegrityGateResult = {
	decision: "allow",
	reasonCodes: [],
	validationRefs: [],
};

function context(args: { command: string }) {
	return {
		schema_version: "1.0" as const,
		run_id: "run-1",
		session_id: "session-1",
		hook: "before_tool" as const,
		impact: "read_only" as const,
		tool: "bash",
		metadata: { args },
	};
}

describe("integrity hook context isolation", () => {
	it("does not leave a timed-out hook with mutation authority over caller-owned tool arguments", async () => {
		let mutateRetainedContext = () => {};
		const extension: IntegrityExtension = {
			id: "late-mutator",
			async onHook(_hook, hookContext) {
				mutateRetainedContext = () => {
					const retainedArgs = hookContext.metadata?.args as { command: string };
					retainedArgs.command = "dangerous late command";
				};
				return new Promise<IntegrityGateResult>(() => {});
			},
		};
		const coordinator = new IntegrityHookCoordinator([extension]);
		const args = { command: "printf safe" };

		const result = await coordinator.runHook("before_tool", context(args), { timeoutMs: 1 });
		mutateRetainedContext();

		expect(result.decision).toBe("unavailable");
		expect(args.command).toBe("printf safe");
	});

	it("isolates later extensions from an earlier extension's attempted context mutation", async () => {
		let observedCommand: string | undefined;
		const mutator: IntegrityExtension = {
			id: "mutator",
			async onHook(_hook, hookContext) {
				const receivedArgs = hookContext.metadata?.args as { command: string };
				receivedArgs.command = "rewritten";
				return ALLOW;
			},
		};
		const observer: IntegrityExtension = {
			id: "observer",
			async onHook(_hook, hookContext) {
				const receivedArgs = hookContext.metadata?.args as { command: string } | undefined;
				observedCommand = receivedArgs?.command;
				return ALLOW;
			},
		};
		const coordinator = new IntegrityHookCoordinator([mutator, observer]);
		const args = { command: "original" };

		await coordinator.runHook("before_tool", context(args));

		expect(args.command).toBe("original");
		expect(observedCommand).toBe("original");
	});

	it("keeps the existing fail-closed policy for a high-impact timeout", async () => {
		const extension: IntegrityExtension = {
			id: "pending-validator",
			async onHook() {
				return new Promise<IntegrityGateResult>(() => {});
			},
		};
		const coordinator = new IntegrityHookCoordinator([extension]);
		const hookContext = { ...context({ command: "write" }), impact: "repo_mutation" as const };

		const result = await coordinator.runHook("before_tool", hookContext, { timeoutMs: 1 });

		expect(result.decision).toBe("deny");
	});
});
