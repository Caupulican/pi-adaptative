import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentResumeContext } from "../src/core/orchestration/contracts.ts";
import { OrchestrationEventStore } from "../src/core/orchestration/event-store.ts";
import { DurableTaskRuntime } from "../src/core/orchestration/task-runtime.ts";

const roots: string[] = [];

function createRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "pi-agent-lineage-"));
	roots.push(root);
	return root;
}

function resumeContext(agentDir: string, agentId: string): AgentResumeContext {
	return {
		provider: "pi",
		sessionId: `session-${agentId}`,
		cwd: agentDir,
		resourceProfileNames: [],
		contextPointers: [],
	};
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("durable orchestration agent lineage", () => {
	it("persists an unbounded parent/root/depth chain and rejects an unknown parent", () => {
		const agentDir = createRoot();
		const store = new OrchestrationEventStore({ agentDir, sessionId: "owner-session" });
		const runtime = new DurableTaskRuntime({ store });
		const root = runtime.registerAgent({
			agentId: "agent-root",
			role: "orchestrator",
			resumeContext: resumeContext(agentDir, "root"),
		});
		const child = runtime.registerAgent({
			agentId: "agent-child",
			parentAgentId: root.agentId,
			role: "implementer",
			resumeContext: resumeContext(agentDir, "child"),
		});
		const grandchild = runtime.registerAgent({
			agentId: "agent-grandchild",
			parentAgentId: child.agentId,
			role: "verifier",
			resumeContext: resumeContext(agentDir, "grandchild"),
		});

		expect(root).toMatchObject({ rootAgentId: "agent-root", depth: 0 });
		expect(child).toMatchObject({ parentAgentId: "agent-root", rootAgentId: "agent-root", depth: 1 });
		expect(grandchild).toMatchObject({
			parentAgentId: "agent-child",
			rootAgentId: "agent-root",
			depth: 2,
		});
		expect(new DurableTaskRuntime({ store }).getSnapshot().agents[grandchild.agentId]).toMatchObject({
			parentAgentId: "agent-child",
			rootAgentId: "agent-root",
			depth: 2,
		});
		expect(() =>
			runtime.registerAgent({
				agentId: "orphan",
				parentAgentId: "missing",
				role: "explorer",
				resumeContext: resumeContext(agentDir, "orphan"),
			}),
		).toThrow("Unknown parent agent");
	});
});
