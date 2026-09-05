import { expect, it, vi } from "vitest";
import type { CollaborationAgent, CollaborationBackend } from "../src/core/collaboration/backend.ts";
import { decodeCollaborationUsageClaim } from "../src/core/collaboration/launch-profile.ts";
import { executeCollaborationTurn } from "../src/core/collaboration/turn-runner.ts";

const idle: CollaborationAgent = {
	paneId: "w1:p1",
	terminalId: "t1",
	workspaceId: "w1",
	tabId: "w1:t1",
	name: "worker",
	kind: "pi",
	status: "idle",
	interactiveReady: true,
	launchPending: false,
	stateChangeSequence: 2,
	revision: 2,
};
const input = {
	target: "worker",
	terminalId: "t1",
	turnId: "turn-one",
	reportCommand: "pi --collaboration-peer",
	text: "implement",
	timeoutMs: 1000,
};

it("rejects a prompt-echo DONE marker even when it is the snapshot's last line", async () => {
	const backend = {
		prompt: async () => idle,
		getAgent: async () => ({ ...idle, revision: 3 }),
		readAgent: async () => ({ paneId: idle.paneId, text: "PI_COLLAB_turn-one_DONE", truncated: false, revision: 3 }),
	} as unknown as CollaborationBackend;
	expect((await executeCollaborationTurn(backend, input)).status).toBe("blocked");
});

it("accepts an authenticated current-turn report after stop without parsing the TUI footer", async () => {
	const backend = {
		prompt: async () => idle,
		getAgent: async () => ({ ...idle, revision: 3 }),
		readAgent: async () => ({
			paneId: idle.paneId,
			text: "Verified\n> Ask another question\nmodel footer",
			truncated: true,
			revision: 3,
		}),
	} as unknown as CollaborationBackend;
	expect(
		await executeCollaborationTurn(backend, input, undefined, undefined, () => ({
			turnId: "turn-one",
			status: "done",
			evidence: "Verified exact result",
		})),
	).toMatchObject({ status: "done", evidence: "Verified exact result" });
});

it.each([0, 999])("does not compare snapshot revision %s with native agent metadata revision", async (revision) => {
	const stopped = { ...idle, status: "done" as const, revision: 1, stateChangeSequence: 4 };
	const backend = {
		prompt: async () => stopped,
		getAgent: async () => stopped,
		readAgent: async () => ({ paneId: idle.paneId, text: "native TUI footer", truncated: false, revision }),
	} as unknown as CollaborationBackend;
	expect(
		await executeCollaborationTurn(backend, input, undefined, undefined, () => ({
			turnId: input.turnId,
			status: "done",
			evidence: "Verified native result",
		})),
	).toMatchObject({ status: "done" });
	backend.getAgent = async () => ({ ...stopped, revision: 0 });
	await expect(executeCollaborationTurn(backend, input)).rejects.toThrow(/changed/);
	backend.getAgent = async () => ({ ...stopped, stateChangeSequence: 5 });
	await expect(executeCollaborationTurn(backend, input)).rejects.toThrow(/changed/);
});

it("does not read or hand off thoughts/progress while the agent is still working", async () => {
	let stopped!: (state: CollaborationAgent) => void;
	const readAgent = vi.fn(async () => ({
		paneId: idle.paneId,
		text: "verified\nPI_COLLAB_turn-one_DONE",
		truncated: false,
		revision: 3,
	}));
	const backend = {
		prompt: () =>
			new Promise<CollaborationAgent>((resolve) => {
				stopped = resolve;
			}),
		readAgent,
		getAgent: async () => ({ ...idle, revision: 3 }),
	} as unknown as CollaborationBackend;
	const handoff = vi.fn();
	const readClaim = vi.fn(() => ({
		turnId: input.turnId,
		status: "done" as const,
		evidence: "Verified exact result",
	}));
	const running = executeCollaborationTurn(backend, input, undefined, undefined, readClaim).then(handoff);
	await Promise.resolve();
	expect(readAgent).not.toHaveBeenCalled();
	expect(readClaim).not.toHaveBeenCalled();
	expect(handoff).not.toHaveBeenCalled();
	stopped(idle);
	await running;
	expect(readAgent).toHaveBeenCalledTimes(1);
	expect(handoff).toHaveBeenCalledWith(expect.objectContaining({ status: "done" }));
});

it("surfaces a question only at the blocked boundary, keeping its context", async () => {
	const backend = {
		prompt: async () => ({ ...idle, status: "blocked" }),
		getAgent: async () => ({ ...idle, status: "blocked", revision: 3 }),
		readAgent: async () => ({
			paneId: idle.paneId,
			text: "Which schema version must this migration target?",
			truncated: false,
			revision: 3,
		}),
	} as unknown as CollaborationBackend;
	expect(await executeCollaborationTurn(backend, input)).toMatchObject({
		status: "blocked",
		evidence: expect.stringContaining("Which schema version"),
	});
});

it("surfaces the native blocked question before its terminal UI has rendered it", async () => {
	const stopped = { ...idle, status: "blocked" as const, question: "Which schema version should I use?" };
	const backend = {
		prompt: async () => stopped,
		getAgent: async () => ({ ...stopped, revision: 3 }),
		readAgent: async () => ({ paneId: idle.paneId, text: "previous progress output", truncated: false, revision: 3 }),
	} as unknown as CollaborationBackend;
	expect(await executeCollaborationTurn(backend, input)).toMatchObject({
		status: "blocked",
		evidence: expect.stringContaining("Native agent question (peer-provided):\nWhich schema version should I use?"),
	});
	backend.getAgent = async () => ({ ...stopped, question: "A different question", revision: 3 });
	await expect(executeCollaborationTurn(backend, input)).rejects.toThrow(/changed/);
});

it("does not infer completion from idle, progress, stale markers, or replaced pane output", async () => {
	const backend = {
		prompt: async () => idle,
		getAgent: async () => ({ ...idle, revision: 3 }),
		readAgent: vi.fn(async () => ({
			paneId: idle.paneId,
			text: "PI_COLLAB_old_DONE\nStill thinking",
			truncated: false,
			revision: 3,
		})),
	} as unknown as CollaborationBackend;
	expect((await executeCollaborationTurn(backend, input)).status).toBe("blocked");
	backend.readAgent = async () => ({
		paneId: "w1:p2",
		text: "PI_COLLAB_turn-one_DONE",
		truncated: false,
		revision: 3,
	});
	await expect(executeCollaborationTurn(backend, input)).rejects.toThrow("pane");
	backend.prompt = async () => ({ ...idle, status: "working" });
	await expect(executeCollaborationTurn(backend, input)).rejects.toThrow("stopped");
});

it.each([
	{ status: "working" as const },
	{ terminalId: "replacement" },
	{ stateChangeSequence: idle.stateChangeSequence + 2 },
])("rejects state changes during evidence capture: %j", async (change) => {
	const backend = {
		prompt: async () => idle,
		readAgent: async () => ({
			paneId: idle.paneId,
			text: "verified\nPI_COLLAB_turn-one_DONE",
			truncated: false,
			revision: 3,
		}),
		getAgent: async () => ({ ...idle, ...change, revision: 3 }),
	} as unknown as CollaborationBackend;
	await expect(executeCollaborationTurn(backend, input)).rejects.toThrow(/changed|stopped/i);
});

it("a marker inside progress is not a final completion", async () => {
	const backend = {
		prompt: async () => idle,
		readAgent: async () => ({
			paneId: idle.paneId,
			text: "PI_COLLAB_turn-one_DONE\nStill doing another step",
			truncated: false,
			revision: 3,
		}),
		getAgent: async () => ({ ...idle, revision: 3 }),
	} as unknown as CollaborationBackend;
	expect((await executeCollaborationTurn(backend, input)).status).toBe("blocked");
});

it("does not submit an answer after cancellation", async () => {
	const answerQuestion = vi.fn(async () => idle);
	const getAgent = vi.fn(async () => idle);
	await expect(
		executeCollaborationTurn(
			{ answerQuestion, getAgent } as unknown as CollaborationBackend,
			input,
			AbortSignal.abort(),
			{ text: "Answer" },
		),
	).rejects.toThrow();
	expect(answerQuestion).not.toHaveBeenCalled();
	expect(getAgent).not.toHaveBeenCalled();
});

it("never obtains success or usage from raw terminal marker text", async () => {
	let text = 'PI_COLLAB_turn-one_USAGE {"input":100,"output":50,"cost":{"total":0.003}}\nPI_COLLAB_turn-one_DONE';
	const backend = {
		prompt: async () => idle,
		getAgent: async () => ({ ...idle, revision: 3 }),
		readAgent: async () => ({ paneId: idle.paneId, text, truncated: false, revision: 3 }),
	} as unknown as CollaborationBackend;
	expect(await executeCollaborationTurn(backend, input)).toMatchObject({ status: "blocked", usage: undefined });
	for (const invalid of [
		'PI_COLLAB_old_USAGE {"input":100}',
		"PI_COLLAB_turn-one_USAGE nope",
		"PI_COLLAB_turn-one_USAGE null",
		"PI_COLLAB_turn-one_USAGE {}\nPI_COLLAB_turn-one_USAGE {}",
		`PI_COLLAB_turn-one_USAGE {"extra":"${"x".repeat(9000)}"}`,
		'PI_COLLAB_turn-one_USAGE {"input":100}\nPI_COLLAB_turn-one_BLOCKED\nWhich branch?\nAnswer received; verified',
	]) {
		text = `${invalid}\nPI_COLLAB_turn-one_DONE`;
		expect((await executeCollaborationTurn(backend, input)).usage).toBeUndefined();
	}
});

it("never charges a previous question's usage again after an answer creates a fresh dispatch identity", async () => {
	const backend = {
		prompt: async () => idle,
		getAgent: async () => ({ ...idle, revision: 3 }),
		readAgent: async () => ({
			paneId: idle.paneId,
			text: 'PI_COLLAB_turn-one_USAGE {"input":100}\nPI_COLLAB_turn-one_DONE',
			truncated: false,
			revision: 3,
		}),
	} as unknown as CollaborationBackend;
	const answered = { ...input, turnId: "answer-turn" };
	const claim = {
		turnId: input.turnId,
		status: "done" as const,
		evidence: "Verified",
		usage: decodeCollaborationUsageClaim({ input: 100 }),
	};
	expect(
		(await executeCollaborationTurn(backend, answered, undefined, { text: "Answer" }, () => claim)).usage,
	).toBeUndefined();
	expect(
		await executeCollaborationTurn(backend, answered, undefined, { text: "Answer" }, () => ({
			...claim,
			turnId: answered.turnId,
		})),
	).toMatchObject({ status: "done", usage: { input: 100 } });
});

it("preserves full authenticated blocked evidence instead of terminal placeholders", async () => {
	const state = { ...idle, status: "blocked" as const };
	const backend = {
		prompt: async () => state,
		getAgent: async () => state,
		readAgent: async () => ({ paneId: idle.paneId, text: "rendering", truncated: true, revision: 0 }),
	} as unknown as CollaborationBackend;
	const evidence = `${"界".repeat(2720)}Final choices: A or B.1234567890`;
	expect(Buffer.byteLength(evidence)).toBe(8192);
	const claim = { turnId: input.turnId, status: "blocked" as const, evidence };
	expect(await executeCollaborationTurn(backend, input, undefined, undefined, () => claim)).toMatchObject({
		status: "blocked",
		evidence,
	});
	const question = { turnId: input.turnId, requestId: "human:one", evidence };
	expect(
		await executeCollaborationTurn(backend, input, undefined, undefined, undefined, () => question),
	).toMatchObject({ status: "blocked", evidence });
	const stale = { ...question, turnId: "old" };
	expect(
		(await executeCollaborationTurn(backend, input, undefined, undefined, undefined, () => stale)).evidence,
	).not.toContain("Final choices");
	for (const changed of [
		undefined,
		{ ...question, requestId: "human:two" },
		{ ...question, evidence: "Changed options" },
	]) {
		const readQuestion = vi.fn().mockReturnValueOnce(question).mockReturnValue(changed);
		await expect(
			executeCollaborationTurn(backend, input, undefined, undefined, undefined, readQuestion),
		).rejects.toThrow(/question.*changed/);
	}
});

it("never lets a done report override a native blocked question", async () => {
	const state = { ...idle, status: "blocked" as const, question: "Select a target branch" };
	const backend = {
		prompt: async () => state,
		getAgent: async () => ({ ...state, revision: 3 }),
		readAgent: async () => ({ paneId: idle.paneId, text: "UI still rendering", truncated: false, revision: 3 }),
	} as unknown as CollaborationBackend;
	expect(
		await executeCollaborationTurn(backend, input, undefined, undefined, () => ({
			turnId: input.turnId,
			status: "done",
			evidence: "Claimed done too early",
		})),
	).toMatchObject({ status: "blocked", evidence: expect.stringContaining("Select a target branch") });
});
