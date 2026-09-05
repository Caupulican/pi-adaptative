import { SessionManager } from "@caupulican/pi-agent-core/session";
import { fauxAssistantMessage } from "@caupulican/pi-ai/faux";
import { describe, expect, it, vi } from "vitest";
import { RuntimeUpdateController, type RuntimeUpdateControllerDeps } from "../src/core/runtime-update-controller.ts";

function fixture(overrides: Partial<RuntimeUpdateControllerDeps> = {}) {
	const sessionManager = SessionManager.inMemory();
	const deps: RuntimeUpdateControllerDeps = {
		sessionManager,
		getMessages: () => [],
		reload: vi.fn(async () => {}),
		appendNotice: vi.fn(async () => {}),
		isRoot: () => true,
		...overrides,
	};
	const controller = new RuntimeUpdateController(deps);
	const call = (input: Parameters<ReturnType<RuntimeUpdateController["createTool"]>["execute"]>[1]) =>
		controller.createTool().execute("update-1", input, undefined, undefined, undefined as never);
	return { controller, deps, call, sessionManager };
}

describe("bounded runtime update ownership", () => {
	it("directs core repair to the host-owned origin rather than the running artifact", async () => {
		const f = fixture();
		await f.call({ action: "reload", verificationTool: "probe" });
		f.sessionManager.appendCustomEntry("runtime-update", {
			...f.controller.getState(),
			mode: "restart",
			status: "restarting",
		});
		const restored = new RuntimeUpdateController(f.deps);
		restored.setSourceOrigin("/editable/source");
		await restored.acceptRestart("update-1", "invalid candidate");
		expect(f.deps.appendNotice).toHaveBeenCalledWith(
			expect.stringContaining(
				'Repair the original source/install location "/editable/source", not the running snapshot',
			),
		);
		expect(() => restored.setSourceOrigin("/invalid\0path")).toThrow("origin");
	});

	it("forgets an update when navigating to a branch that predates it", async () => {
		const f = fixture();
		const parent = f.sessionManager.appendMessage(fauxAssistantMessage("before update"));
		await f.call({ action: "reload", verificationTool: "probe" });
		f.sessionManager.branch(parent);
		await f.call({ action: "status" });
		expect(f.controller.getState()).toBeUndefined();
		expect(await f.controller.settle()).toBeUndefined();
		expect(f.deps.reload).not.toHaveBeenCalled();
	});

	it("fences candidate commit at the persisted batch boundary and requires host acknowledgement", async () => {
		const f = fixture();
		const commit = vi.fn(async () => {});
		f.controller.setRestartHandler(
			async () => {
				throw new Error("unused");
			},
			{ commit },
		);
		await f.call({ action: "reload", verificationTool: "probe" });
		await f.controller.settle();
		const state = f.controller.getState()!;
		f.sessionManager.appendCustomEntry("runtime-update", { ...state, mode: "restart" });
		f.sessionManager.appendMessage({
			role: "toolResult",
			toolName: "probe",
			toolCallId: "probe-1",
			content: [],
			isError: false,
			timestamp: 0,
		});
		await f.call({ action: "complete" });
		expect(f.controller.getState()?.status).toBe("committing");
		expect(commit).not.toHaveBeenCalled();
		expect(f.controller.shouldStopAfterTurn()).toBe(true);
		expect(await f.controller.settle()).toBe("continue");
		expect(commit).toHaveBeenCalledWith(state.id);
		expect(f.controller.getState()?.status).toBe("complete");
	});
	it("keeps failures in repair priority and stops after three attempts", async () => {
		const f = fixture({
			reload: vi.fn(async () => {
				throw new Error("broken module");
			}),
		});
		for (let attempt = 1; attempt <= 3; attempt++) {
			await f.call({ action: "reload", verificationTool: "probe" });
			expect(await f.controller.settle()).toBe(attempt === 3 ? "stop" : "continue");
			expect(f.controller.getState()?.attempts).toBe(attempt);
		}
		expect(f.deps.reload).toHaveBeenCalledTimes(3);
		expect(f.controller.getState()).toMatchObject({
			status: "stopped",
			error: expect.stringContaining("broken module"),
		});
		expect(f.deps.appendNotice).toHaveBeenCalledWith(expect.stringContaining("Do not resume the original task"));
	});

	it("rejects duplicate requests and stale, failed, or sibling-branch verification", async () => {
		const f = fixture();
		const answered = (isError: boolean, exitCode = 0) =>
			f.sessionManager.appendMessage({
				role: "toolResult",
				toolName: "probe",
				toolCallId: "probe-1",
				content: [],
				isError,
				timestamp: 0,
				details: { exitCode },
			});
		answered(false);
		await f.call({ action: "reload", verificationTool: "probe" });
		await expect(f.call({ action: "reload" })).rejects.toThrow("already pending");
		await f.controller.settle();
		await expect(f.call({ action: "complete" })).rejects.toThrow("verificationTool");
		answered(true);
		answered(false, 1);
		await expect(f.call({ action: "complete" })).rejects.toThrow("verificationTool");
		const beforeSuccess = f.sessionManager.getLeafId()!;
		answered(false);
		f.sessionManager.branch(beforeSuccess);
		await expect(f.call({ action: "complete" })).rejects.toThrow("verificationTool");
		answered(false);
		await f.call({ action: "complete" });
		expect(f.controller.getState()?.status).toBe("complete");
	});

	it("bounds verification rounds and stops when the model exits without verification", async () => {
		const f = fixture();
		await f.call({ action: "reload", verificationTool: "probe" });
		for (let turn = 0; turn < 12; turn++) expect(await f.controller.settle()).toBe("continue");
		expect(await f.controller.settle()).toBe("stop");
		expect(f.controller.getState()?.turns).toBe(12);
		const final = fixture({ getMessages: () => [fauxAssistantMessage("done")] });
		await final.call({ action: "reload", verificationTool: "probe" });
		await final.controller.settle();
		expect(await final.controller.settle()).toBe("stop");
		expect(final.controller.getState()?.error).toContain("without completing");
	});

	it("cancels before applying a queued update and denies child authority", async () => {
		const f = fixture();
		await f.call({ action: "reload", verificationTool: "probe" });
		expect(await f.controller.settle(AbortSignal.abort())).toBe("stop");
		expect(f.deps.reload).not.toHaveBeenCalled();
		const child = fixture({ isRoot: () => false });
		await expect(child.call({ action: "reload", verificationTool: "probe" })).rejects.toThrow("root session");
		expect(child.sessionManager.getBranch()).toHaveLength(0);
	});

	it("restores repair priority without blindly reapplying an interrupted queued request", async () => {
		const f = fixture();
		await f.call({ action: "reload", verificationTool: "probe" });
		const restored = new RuntimeUpdateController(f.deps);
		expect(await restored.settle()).toBe("continue");
		expect(restored.getState()).toMatchObject({ status: "repairing", attempts: 0 });
		expect(f.deps.reload).not.toHaveBeenCalled();
	});

	it("cancellation wins over interrupted queued restoration", async () => {
		const f = fixture();
		await f.call({ action: "reload", verificationTool: "probe" });
		const restored = new RuntimeUpdateController(f.deps);
		expect(await restored.settle(AbortSignal.abort())).toBe("stop");
		expect(restored.getState()?.status).toBe("stopped");
		expect(f.deps.reload).not.toHaveBeenCalled();
		expect(f.deps.appendNotice).not.toHaveBeenCalledWith(expect.stringContaining("Priority: inspect"));
	});

	it("cannot replace an uncommitted core update with an extension-only verification", async () => {
		const f = fixture();
		await f.call({ action: "reload", verificationTool: "probe" });
		await f.controller.settle();
		const state = { ...f.controller.getState()!, mode: "restart" as const };
		f.sessionManager.appendCustomEntry("runtime-update", state);
		await expect(f.call({ action: "reload" })).rejects.toThrow("update mode");
		expect(f.controller.getState()).toEqual(state);
	});

	it("does not continue after cancellation while reload is committing", async () => {
		let release!: () => void;
		const f = fixture({
			reload: () =>
				new Promise<void>((resolve) => {
					release = resolve;
				}),
		});
		await f.call({ action: "reload", verificationTool: "probe" });
		const settling = f.controller.settle();
		f.controller.cancel();
		release();
		expect(await settling).toBe("stop");
		expect(f.controller.getState()?.error).toContain("cancelled");
	});
});
