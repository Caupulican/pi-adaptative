import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context, SimpleStreamOptions } from "@caupulican/pi-ai";
import { fauxAssistantMessage, registerFauxProvider } from "@caupulican/pi-ai/faux";
import { afterEach, expect, it } from "vitest";
import { WorkerLifecycle } from "../src/core/delegation/worker-lifecycle.ts";
import { createHarness, getMessageText, type Harness } from "./suite/harness.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function project() {
	const root = mkdtempSync(join(tmpdir(), "pi-project-context-"));
	const cwd = join(root, "project");
	const agentDir = join(root, "state");
	mkdirSync(cwd);
	const faux = registerFauxProvider();
	const parents: Harness[] = [];
	const requests: string[] = [];
	cleanups.push(async () => {
		for (const parent of parents.reverse()) await parent.cleanup();
		faux.unregister();
		rmSync(root, { recursive: true, force: true });
	});
	faux.setResponses(
		Array.from({ length: 32 }, () => (context: Context, options?: SimpleStreamOptions) => {
			if (!options?.sessionId?.startsWith("lane:worker:")) return fauxAssistantMessage("Acknowledged.");
			requests.push(context.messages.map(getMessageText).join("\n"));
			return fauxAssistantMessage(
				JSON.stringify({ status: "completed", summary: `Project finding ${requests.length}` }),
			);
		}),
	);
	const parent = async (directory = cwd) => {
		const harness = await createHarness({
			agentDir,
			cwd: directory,
			sharedFauxProvider: faux,
			settings: { workerDelegation: { enabled: true } },
		});
		parents.push(harness);
		return harness;
	};
	const bindings = (harness: Harness) =>
		new WorkerLifecycle({ agentDir, sessionId: harness.sessionManager.getSessionId() }).getTaskRuntimeSnapshot()
			.agents;
	return { root, cwd, parent, requests, bindings };
}

it("a compatible task in another parent uses the original specialist transcript and provider context", async () => {
	const f = await project();
	const a = await f.parent();
	const b = await f.parent();
	const first = await a.session.runWorkerDelegationOnce({ instructions: "Map the project retry ladder" });
	const second = await b.session.runWorkerDelegationOnce({ instructions: "Review its cancellation boundary" });
	expect(first.record?.status).toBe("succeeded");
	expect(second.record?.status).toBe("succeeded");
	expect(f.requests).toHaveLength(2);
	expect(f.requests[1]).toContain("Map the project retry ladder");
	expect(f.requests[1]).toContain("Project finding 1");
	const original = f.bindings(a)[first.record!.agentId!];
	const reused = f.bindings(b)[second.record!.agentId!];
	expect(reused.resumeContext).toMatchObject({
		sessionId: original.resumeContext.sessionId,
		sessionFile: original.resumeContext.sessionFile,
		sessionDir: original.resumeContext.sessionDir,
	});
});

it("importing context preserves both transcripts when parent-local agent handles collide", async () => {
	const f = await project();
	const narrow = join(f.cwd, "narrow");
	mkdirSync(narrow);
	const a = await f.parent();
	const b = await f.parent();
	const original = await a.session.runWorkerDelegationOnce({ instructions: "Map project-wide assumptions" });
	const local = await b.session.runWorkerDelegationOnce({
		instructions: "Inspect only the narrow directory",
		authority: { path: narrow },
	});
	const originalBinding = f.bindings(a)[original.record!.agentId!];
	const localBinding = f.bindings(b)[local.record!.agentId!];
	expect(local.record?.agentId).toBe(original.record?.agentId);
	const imported = await b.session.runWorkerDelegationOnce({ instructions: "Review project-wide assumptions" });
	expect(imported.record?.status).toBe("succeeded");
	expect(imported.record?.agentId).not.toBe(local.record?.agentId);
	expect(f.bindings(b)[local.record!.agentId!].resumeContext).toEqual(localBinding.resumeContext);
	expect(f.bindings(b)[imported.record!.agentId!].resumeContext).toMatchObject({
		sessionId: originalBinding.resumeContext.sessionId,
		sessionFile: originalBinding.resumeContext.sessionFile,
		sessionDir: originalBinding.resumeContext.sessionDir,
	});
	expect(f.requests[2]).toContain("Project finding 1");
	expect(f.requests[2]).not.toContain("Inspect only the narrow directory");
});

it("negative control: another physical project starts without the first project's context", async () => {
	const f = await project();
	const other = join(f.root, "other-project");
	mkdirSync(other);
	const a = await f.parent();
	const b = await f.parent(other);
	const first = await a.session.runWorkerDelegationOnce({ instructions: "Map the private project assumptions" });
	const second = await b.session.runWorkerDelegationOnce({ instructions: "Inspect another project" });
	expect(first.record?.status).toBe("succeeded");
	expect(second.record?.status).toBe("succeeded");
	expect(f.requests[1]).not.toContain("Map the private project assumptions");
	expect(f.requests[1]).not.toContain("Project finding 1");
	expect(f.bindings(b)[second.record!.agentId!].resumeContext).not.toEqual(
		f.bindings(a)[first.record!.agentId!].resumeContext,
	);
});
