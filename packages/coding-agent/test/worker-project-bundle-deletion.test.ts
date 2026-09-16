import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { orchestrationSessionDir } from "../src/core/agent-paths.ts";
import { WorkerConversationStore } from "../src/core/delegation/worker-conversation-store.ts";
import { deleteForegroundSessionBundle } from "../src/core/session-artifact-bundle.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-project-delete-"));
	roots.push(agentDir);
	const parentSessionId = "birth-parent";
	const sessionPath = join(agentDir, "foreground.jsonl");
	writeFileSync(sessionPath, "foreground\n");
	const store = new WorkerConversationStore();
	const create = {
		agentDir,
		parentSessionId,
		logicalAgentId: "worker-1",
		cwd: agentDir,
		resourceProfileNames: [],
		contextPointers: [],
	};
	const original = store.create(create);
	const claim = {
		agentDir,
		resumeContext: original.getResumeContext(),
		expectedLogicalAgentId: "worker-1",
		owner: { parentSessionId, incarnation: "first" },
		specializationKey: "a".repeat(64),
	};
	const bundle = { agentDir, parentSessionId, sessionPath };
	return { store, create, claim, bundle, artifactPath: orchestrationSessionDir(agentDir, parentSessionId) };
}

async function remove(path: string) {
	rmSync(path, { recursive: true, force: true });
	return { ok: true, method: "unlink" as const };
}

it.each([false, true])(
	"preserves an executing context when its birth parent is deleted (foreign: %s)",
	async (foreign) => {
		const f = fixture();
		let current = f.store.claimProjectContext(f.claim);
		if (foreign) {
			f.store.releaseProjectContext(current);
			current = f.store.claimProjectContext({
				...f.claim,
				owner: { parentSessionId: "other", incarnation: "second" },
			});
		}
		const result = await deleteForegroundSessionBundle({ ...f.bundle, removePath: remove });
		expect(result.complete).toBe(false);
		expect(result.foreground.ok).toBe(true);
		expect(result.workerArtifacts).toMatchObject({ ok: false, method: "preserved" });
		expect(existsSync(f.claim.resumeContext.sessionFile!)).toBe(true);
		current.appendMessage({ role: "user", content: "Owner remains usable", timestamp: 1 });
	},
);

it.each([false, true])(
	"deletes settled artifacts and fences creation and transfer during asynchronous removal (enrolled: %s)",
	async (enrolled) => {
		const f = fixture();
		if (enrolled) f.store.releaseProjectContext(f.store.claimProjectContext(f.claim));
		let checked = false;
		const result = await deleteForegroundSessionBundle({
			...f.bundle,
			removePath: async (path) => {
				if (path === f.artifactPath) {
					checked = true;
					expect(() => f.store.claimProjectContext(f.claim)).toThrow(/delet/i);
					expect(() => f.store.create({ ...f.create, logicalAgentId: "worker-2" })).toThrow(/delet/i);
				}
				return remove(path);
			},
		});
		expect(checked).toBe(true);
		expect(result.complete).toBe(true);
		expect(existsSync(f.artifactPath)).toBe(false);
		expect(() => f.store.ensure(f.create)).toThrow(/delet/i);
	},
);

it("keeps a failed artifact deletion fenced and permits an explicit deletion retry", async () => {
	const f = fixture();
	f.store.releaseProjectContext(f.store.claimProjectContext(f.claim));
	const result = await deleteForegroundSessionBundle({
		...f.bundle,
		removePath: async (path) =>
			path === f.artifactPath ? { ok: false, method: "unlink", error: "injected removal failure" } : remove(path),
	});
	expect(result.complete).toBe(false);
	expect(() => f.store.claimProjectContext(f.claim)).toThrow(/delet/i);
	expect((await deleteForegroundSessionBundle({ ...f.bundle, removePath: remove })).complete).toBe(true);
});

it("does not reserve worker deletion when foreground removal fails", async () => {
	const f = fixture();
	const result = await deleteForegroundSessionBundle({
		...f.bundle,
		removePath: async () => ({ ok: false, method: "unlink", error: "denied" }),
	});
	expect(result.complete).toBe(false);
	f.store.claimProjectContext(f.claim).appendMessage({ role: "user", content: "Still admitted", timestamp: 1 });
});
