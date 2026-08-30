import { describe, expect, it } from "vitest";
// Both sides of the pin are imported by path so the comparison is always between THIS checkout's
// wrapper and THIS checkout's kernel. The `@caupulican/pi-agent-core/*` specifier resolves through
// the workspace link, which in a git worktree points at the primary checkout's agent sources — a
// pin reading a different tree than the one under test would silently pass.
import { assessToolFailure } from "../../agent/src/tool-failure-memory.ts";
import { wrapUntrustedText } from "../src/core/security/untrusted-boundary.ts";

/**
 * Drift pin between the untrusted-content wire format (coding-agent) and the kernel's envelope
 * filter (agent). The kernel cannot import the tag, so this test wraps with the REAL wrapper and
 * asserts the REAL assessment never promotes envelope framing into model-visible text.
 */
describe("untrusted envelope never reaches a failure diagnostic", () => {
	it("promotes the wrapped payload, not the boundary tag", () => {
		const wrapped = wrapUntrustedText("delegate cancel requires agentId; agentIds is not accepted", "tool:delegate");

		const assessment = assessToolFailure(wrapped, "failed", "tool_result_error");

		expect(assessment.diagnostic).toContain("requires agentId");
		expect(assessment.diagnostic).not.toContain("untrusted_content");
	});

	it("keeps evidence free of the boundary tag on a process-exit failure", () => {
		const wrapped = wrapUntrustedText("error: worker worker-10 refused the cancel request", "tool:delegate");

		const assessment = assessToolFailure(`${wrapped}\nCommand exited with code 1`, "failed", "Error");

		expect(assessment.failureCode).toBe("exit_1");
		expect(assessment.diagnostic).toContain("refused the cancel request");
		expect(assessment.diagnostic).not.toContain("untrusted_content");
		expect(assessment.evidence).toContain("refused the cancel request");
		expect(assessment.evidence).not.toContain("untrusted_content");
	});
});
