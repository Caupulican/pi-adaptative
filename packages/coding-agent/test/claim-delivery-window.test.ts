import { SessionManager } from "@caupulican/pi-agent-core/session";
import type { AssistantMessage, ToolResultMessage } from "@caupulican/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@caupulican/pi-ai";
import { describe, expect, it } from "vitest";
import {
	type ClaimReceipts,
	collectClaimReceipts,
	judgeClaims,
	mergeClaimReceipts,
} from "../src/core/system-one/claim-delivery.ts";
import { openWorkUnit, WORKER_RECEIPTS_CUSTOM_TYPE, workUnitWindow } from "../src/core/work-units.ts";

const yes = { type: "noul", noul: 0.97 };

function receiptsOf(manager: SessionManager, turnOnly: readonly AssistantMessage[] = []): ClaimReceipts {
	const window = workUnitWindow(manager, WORKER_RECEIPTS_CUSTOM_TYPE);
	if (!window) return collectClaimReceipts(turnOnly);
	return mergeClaimReceipts([collectClaimReceipts(window.messages), ...(window.customs as ClaimReceipts[])]);
}

function commitTurn(manager: SessionManager): void {
	manager.appendMessage({ role: "user", content: "commit f.txt", timestamp: 1 });
	manager.appendMessage(
		fauxAssistantMessage([fauxToolCall("bash", { command: "git commit -m add-f" }, { id: "c1" })], {
			stopReason: "toolUse",
		}),
	);
	// The first call that may change the world opened the work unit, before its result arrived.
	openWorkUnit(manager, { kind: "enforced", reason: "first mutating call: bash" });
	const result: ToolResultMessage = {
		role: "toolResult",
		toolCallId: "c1",
		toolName: "bash",
		content: [{ type: "text", text: "[master abc] add-f" }],
		isError: false,
		timestamp: 2,
	};
	manager.appendMessage(result);
	manager.appendMessage(fauxAssistantMessage("done"));
}

describe("claims over the work-unit window", () => {
	it("backs a recap of a commit made earlier in the same work", () => {
		const manager = SessionManager.inMemory();
		commitTurn(manager);
		// The owner asks later; the answer recaps the commit with no tool call of its own.
		manager.appendMessage({ role: "user", content: "did you commit it?", timestamp: 3 });
		manager.appendMessage(fauxAssistantMessage("Yes, f.txt was committed."));
		expect(judgeClaims({ states_committed: yes }, receiptsOf(manager))).toEqual([]);
	});

	it("still flags a delivery claim with no work behind it", () => {
		const manager = SessionManager.inMemory();
		manager.appendMessage({ role: "user", content: "status?", timestamp: 1 });
		const answer = fauxAssistantMessage("All tests pass.");
		manager.appendMessage(answer);
		expect(judgeClaims({ states_tests_pass: yes }, receiptsOf(manager, [answer]))).toEqual([
			expect.objectContaining({ kind: "tests_pass", verdict: "unsupported" }),
		]);
	});

	it("lets an accepted worker's receipts back the root's claim", () => {
		const manager = SessionManager.inMemory();
		commitTurn(manager);
		const worker: ClaimReceipts = {
			tests: { passed: 1, failed: 0, lastPassed: true },
			commits: { succeeded: 0, failed: 0 },
			pushes: { succeeded: 0, failed: 0 },
			publishes: { succeeded: 0, failed: 0 },
			filesChanged: ["src/a.ts"],
			toolCalls: 2,
			succeededToolCalls: 2,
		};
		manager.appendCustomEntry(WORKER_RECEIPTS_CUSTOM_TYPE, worker);
		manager.appendMessage(fauxAssistantMessage("The worker ran the tests and they pass."));
		expect(judgeClaims({ states_tests_pass: yes, states_files_changed: yes }, receiptsOf(manager))).toEqual([]);
	});
});
