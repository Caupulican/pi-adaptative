import { describe, expect, it, vi } from "vitest";
import type { CollaborationAgent, CollaborationBackend } from "../src/core/collaboration/backend.ts";
import { executeCollaborationTurn } from "../src/core/collaboration/turn-runner.ts";

const input = {
	target: "owned-worker",
	terminalId: "owned-terminal",
	turnId: "fresh-answer-turn",
	reportCommand: "pi --collaboration-peer",
	text: "Continue the existing task after this answer.",
	timeoutMs: 1000,
};

function questionBackend(status: CollaborationAgent["status"]) {
	const before: CollaborationAgent = {
		paneId: "owned-pane",
		terminalId: input.terminalId,
		workspaceId: "owned-workspace",
		tabId: "owned-tab",
		name: input.target,
		kind: "pi",
		status,
		interactiveReady: true,
		launchPending: false,
		stateChangeSequence: 4,
		revision: 2,
	};
	const after = { ...before, status: "done" as const, stateChangeSequence: 6, revision: 3 };
	const port = {
		getAgent: vi.fn().mockResolvedValueOnce(before).mockResolvedValue(after),
		prompt: vi.fn<CollaborationBackend["prompt"]>(async () => after),
		answerQuestion: vi.fn<CollaborationBackend["answerQuestion"]>(async () => after),
		readAgent: vi.fn(async () => ({ paneId: before.paneId, text: "TUI footer", truncated: false, revision: 0 })),
	};
	return { before, port, backend: port as unknown as CollaborationBackend };
}

describe("textual and native-dialog collaboration answers", () => {
	it.each(["idle", "done"] as const)("continues an %s textual question on the same native session", async (status) => {
		const { backend, port } = questionBackend(status);
		const result = await executeCollaborationTurn(backend, input, undefined, { text: "Use schema v2." }, () => ({
			turnId: input.turnId,
			status: "done",
			evidence: "Verified schema v2.",
		}));
		expect(result).toMatchObject({ status: "done", evidence: "Verified schema v2." });
		expect(port.answerQuestion).not.toHaveBeenCalled();
		expect(port.prompt).toHaveBeenCalledOnce();
		expect(port.prompt.mock.calls[0]?.[0]).toMatchObject({
			target: input.target,
			terminalId: input.terminalId,
			text: expect.stringContaining("Use schema v2."),
		});
		expect(port.prompt.mock.calls[0]?.[0]).toMatchObject({ text: expect.stringContaining(input.turnId) });
	});

	it("answers a blocked dialog directly without dispatching another prompt", async () => {
		const { backend, port } = questionBackend("blocked");
		await executeCollaborationTurn(backend, input, undefined, { keys: ["enter"] });
		expect(port.prompt).not.toHaveBeenCalled();
		expect(port.answerQuestion).toHaveBeenCalledOnce();
		expect(port.answerQuestion.mock.calls[0]?.[0]).toMatchObject({
			target: input.target,
			terminalId: input.terminalId,
			keys: ["enter"],
		});
	});

	it("refuses keys-only input when there is no blocked dialog", async () => {
		const { backend, port } = questionBackend("idle");
		await expect(executeCollaborationTurn(backend, input, undefined, { keys: ["enter"] })).rejects.toThrow();
		expect(port.getAgent).toHaveBeenCalledOnce();
		expect(port.prompt).not.toHaveBeenCalled();
		expect(port.answerQuestion).not.toHaveBeenCalled();
	});

	it.each(["blocked", "idle"] as const)("never switches transports after uncertain %s input", async (status) => {
		const { backend, port } = questionBackend(status);
		const write = status === "blocked" ? port.answerQuestion : port.prompt;
		write.mockRejectedValueOnce(new Error("Input acknowledgement lost."));
		await expect(executeCollaborationTurn(backend, input, undefined, { text: "Use schema v2." })).rejects.toThrow(
			"Input acknowledgement lost.",
		);
		expect(write).toHaveBeenCalledOnce();
		expect(status === "blocked" ? port.prompt : port.answerQuestion).not.toHaveBeenCalled();
		expect(port.readAgent).not.toHaveBeenCalled();
	});

	it("rejects a replacement occupant before either input transport", async () => {
		const { backend, port, before } = questionBackend("idle");
		port.getAgent.mockReset().mockResolvedValue({ ...before, terminalId: "replacement-terminal" });
		await expect(executeCollaborationTurn(backend, input, undefined, { text: "Use schema v2." })).rejects.toThrow();
		expect(port.getAgent).toHaveBeenCalledOnce();
		expect(port.prompt).not.toHaveBeenCalled();
		expect(port.answerQuestion).not.toHaveBeenCalled();
	});

	it("cancels before inspection or any input write", async () => {
		const { backend, port } = questionBackend("blocked");
		await expect(
			executeCollaborationTurn(backend, input, AbortSignal.abort(), { text: "Use schema v2." }),
		).rejects.toThrow();
		expect(port.getAgent).not.toHaveBeenCalled();
		expect(port.prompt).not.toHaveBeenCalled();
		expect(port.answerQuestion).not.toHaveBeenCalled();
	});

	it("cancels during answer inspection before either input write", async () => {
		const { backend, port, before } = questionBackend("idle");
		const controller = new AbortController();
		port.getAgent.mockReset().mockImplementation(async () => {
			controller.abort();
			return before;
		});
		await expect(
			executeCollaborationTurn(backend, input, controller.signal, { text: "Use schema v2." }),
		).rejects.toThrow();
		expect(port.getAgent).toHaveBeenCalledOnce();
		expect(port.prompt).not.toHaveBeenCalled();
		expect(port.answerQuestion).not.toHaveBeenCalled();
	});
});
