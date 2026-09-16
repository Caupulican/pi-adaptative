import { expect, it } from "vitest";
import { createDelegateToolDefinition } from "../src/core/tools/delegate.ts";

it.each([false, true])(
	"delegate guidance describes mandatory matching without instructing duplicate allocation (async=%s)",
	(asyncWiring) => {
		const tool = createDelegateToolDefinition({
			caller: { kind: "session_root" },
			runWorkerDelegation: async () => ({ started: false }),
			...(asyncWiring ? { startWorkerDelegation: () => ({ started: false as const, skipReason: "unused" }) } : {}),
		});
		expect(tool.description).toContain("automatically reuses");
		expect(tool.description).toContain("parallelWork");
		expect(tool.description).toContain("agentId");
		expect(tool.description).not.toContain("PREFER REUSE");
		expect(tool.promptGuidelines?.join(" ")).not.toContain("fresh=no agentId");
		expect(tool.promptGuidelines?.join(" ")).toContain("automatic reuse");
		expect(JSON.stringify(tool.parameters)).not.toContain("Fresh workers only");
	},
);
