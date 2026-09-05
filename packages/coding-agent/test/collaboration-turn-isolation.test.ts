import { expect, it } from "vitest";
import type { CollaborationAgent, CollaborationBackend } from "../src/core/collaboration/backend.ts";
import { collaborationPrompt, executeCollaborationTurn } from "../src/core/collaboration/turn-runner.ts";

it("keeps stale, echoed, and unfinished marker text from settling the current turn", async () => {
	const state: CollaborationAgent = {
		paneId: "pane",
		terminalId: "terminal",
		workspaceId: "workspace",
		tabId: "tab",
		status: "idle",
		interactiveReady: true,
		launchPending: false,
		stateChangeSequence: 2,
		revision: 2,
	};
	const input = {
		target: "worker",
		terminalId: "terminal",
		turnId: "current",
		reportCommand: "pi --collaboration-peer",
		text: "work",
		timeoutMs: 1000,
	};
	let text = "PI_COLLAB_old_DONE";
	const backend = {
		prompt: async () => state,
		getAgent: async () => state,
		readAgent: async () => ({ paneId: state.paneId, text, truncated: false, revision: 2 }),
	} as unknown as CollaborationBackend;
	for (const candidate of [
		"PI_COLLAB_old_DONE",
		collaborationPrompt(input),
		"P I _ C O L L A B _ c u r r e n t _ D O N E",
		"PI_COLLAB_current_DONE\nstill working",
	]) {
		text = candidate;
		expect((await executeCollaborationTurn(backend, input)).status).toBe("blocked");
	}
	text = "PI_COLLAB_old_DONE\nverified current work\nPI_COLLAB_current_DONE";
	expect((await executeCollaborationTurn(backend, input)).status).toBe("blocked");
	expect(
		await executeCollaborationTurn(backend, input, undefined, undefined, () => ({
			turnId: "current",
			status: "done",
			evidence: "verified current work",
		})),
	).toMatchObject({
		status: "done",
		evidence: expect.stringContaining("verified current work"),
	});
});
