import { describe, expect, it } from "vitest";
import { assessOperationRisk } from "../src/core/autonomy/risk-assessment.ts";

describe("assessOperationRisk", () => {
	it("returns read-only for empty operations", () => {
		const result = assessOperationRisk({ operation: "   " });
		expect(result.risk).toBe("read-only");
		expect(result.requiresApproval).toBe(false);
	});

	it("returns read-only for explicit informational questions about architecture and settings", () => {
		const result1 = assessOperationRisk({ operation: "Show me the architecture of this package" });
		expect(result1.risk).toBe("read-only");
		expect(result1.requiresApproval).toBe(false);

		const result2 = assessOperationRisk({ operation: "List tools available in this repo" });
		expect(result2.risk).toBe("read-only");

		const result3 = assessOperationRisk({ operation: "Read settings-manager.ts and summarize it" });
		expect(result3.risk).toBe("read-only");
	});

	it("returns approval-required for self-modification and settings modification", () => {
		const result1 = assessOperationRisk({ operation: "Modify the tool settings" });
		expect(result1.risk).toBe("approval-required");
		expect(result1.requiresApproval).toBe(true);

		const result2 = assessOperationRisk({ operation: "Update agent skills" });
		expect(result2.risk).toBe("approval-required");
	});

	it("returns high-impact for architecture mutation", () => {
		const result = assessOperationRisk({ operation: "Rewrite the autonomous runtime architecture" });
		expect(result.risk).toBe("high-impact");
		expect(result.requiresApproval).toBe(false);
	});

	it("returns approval-required for security and authentication changes", () => {
		const result = assessOperationRisk({ operation: "Change authentication token handling" });
		expect(result.risk).toBe("approval-required");
	});

	it("returns approval-required for release/publish/deploy actions", () => {
		const result1 = assessOperationRisk({ operation: "Publish a release and push the tag" });
		expect(result1.risk).toBe("approval-required");
		expect(result1.requiresApproval).toBe(true);

		const result2 = assessOperationRisk({ operation: "Trigger deploy" });
		expect(result2.risk).toBe("approval-required");
	});

	it("returns approval-required for destructive commands", () => {
		const result1 = assessOperationRisk({ operation: "Run command", command: "git reset --hard" });
		expect(result1.risk).toBe("approval-required");
		expect(result1.requiresApproval).toBe(true);

		const result2 = assessOperationRisk({ operation: "Delete the generated files and reset the repo" });
		expect(result2.risk).toBe("approval-required");
	});

	it("returns approval-required for publish commands", () => {
		const result = assessOperationRisk({ operation: "Run command", command: "npm publish --access public" });
		expect(result.risk).toBe("approval-required");
		expect(result.requiresApproval).toBe(true);
	});

	it("is quote-aware for shell commands and ignores destructive patterns inside single quotes", () => {
		const result1 = assessOperationRisk({ operation: "Run shell", command: "echo 'rm -rf /tmp/foo'" });
		// The command string has 'rm -rf /tmp/foo' but inside quotes, so it should not trigger approval-required
		// unless there's a toolName that triggers scoped-write
		expect(result1.risk).toBe("read-only");

		const result2 = assessOperationRisk({ operation: "Run shell", command: "rm -rf /tmp/foo" });
		expect(result2.risk).toBe("approval-required");
	});

	it("defaults to scoped-write for generic mutating tool operations", () => {
		const result = assessOperationRisk({ operation: "Update the tests", toolName: "replace_file_content" });
		expect(result.risk).toBe("scoped-write");
		expect(result.requiresApproval).toBe(false);
	});

	it("returns read-only for read-only tool operations", () => {
		const result = assessOperationRisk({ operation: "Read the file", toolName: "read_file" });
		expect(result.risk).toBe("read-only");
		expect(result.requiresApproval).toBe(false);
	});

	it("does not require approval for shell read-only commands", () => {
		const cmds = ["git status", "ls -la", "npm view", "rg 'foo'"];
		for (const cmd of cmds) {
			const result = assessOperationRisk({ operation: "Run shell", command: cmd });
			expect(result.risk).not.toBe("approval-required");
			expect(result.risk).not.toBe("high-impact");
		}
	});
});
