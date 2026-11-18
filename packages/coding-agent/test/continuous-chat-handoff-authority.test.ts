import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AssistantMessage, createEmptyUsage, type UserMessage } from "@caupulican/pi-ai";
import { expect, it } from "vitest";
import { recordLiveWorkerHandoff, recordLiveWorkerReport } from "../src/core/delegation/worker-handoff-provenance.ts";
import { ContinuousChatHost } from "../src/core/memory/continuous-chat-host.ts";
import { CONTINUOUS_CHAT_WORK_REPORT_CUSTOM_TYPE } from "../src/core/memory/continuous-chat-ingest.ts";
import {
	continuousChatNodeFirstMessage,
	continuousChatNodeMessageCount,
} from "../src/core/memory/continuous-chat-tree.ts";
import { ownerSessionStorageRoots } from "../src/core/orchestration/session-bundle-lifecycle.ts";
import { BACKGROUND_WORKER_COMPLETION_CUSTOM_TYPE } from "../src/core/proof/proof-sheet.ts";
import { createCustomMessage } from "../src/kernel/messages.ts";
import { SessionManager } from "../src/kernel/session/session-manager.ts";

it("proves two ordered work reports against the pinned chat view and revokes the handoff on a branch change", async () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-handoff-history-"));
	const manager = SessionManager.create(directory, ownerSessionStorageRoots(directory), join(directory, "sessions"));
	const closing = new AbortController();
	let host: ContinuousChatHost | undefined;
	try {
		host = await ContinuousChatHost.open({
			agentDir: directory,
			projectKey: "ab".repeat(8),
			sessionId: manager.getSessionId(),
			prefixHead: () => ({ systemPrompt: "", tools: [] }),
			resetCompactionPrefix: () => {},
			resolveWorker: () => undefined,
			compaction: {
				validate() {},
				open() {
					throw new Error("Unexpected model compaction");
				},
			},
			closing: closing.signal,
			legacy: { sessions: async () => ({ sessions: [], invalid: [], blocked: [] }), isForgotten: async () => false },
			readEntry: (id) => manager.getEntry(id),
			entryIds: () => manager.getEntries().map((e) => e.id),
			isEntryPersisted: (id) => manager.isEntryPersisted(id),
			subscribeEntriesPersisted: (listener) => manager.onEntriesPersisted(listener),
			getParentInputConsumptionSource: () => manager.getParentInputConsumptionSource(),
			readLiveBranchMessageEntry: (message) => {
				const id = manager.getMessageEntryId(message);
				return id && manager.isEntryOnDurableBranch(id) ? manager.getEntry(id) : undefined;
			},
			isLiveBranchEntry: (id) => manager.isEntryOnDurableBranch(id),
			warn: () => {},
		});
		await host.start();
		let owner = true;
		const source = host.projectionSource(
			() => manager.getSessionId(),
			() => owner,
			undefined,
		);
		const before = await host.turns.begin();
		const user: UserMessage = { role: "user", content: "Start two workers.", timestamp: 1 };
		before.markStart(user);
		manager.appendMessage(user);
		const answer: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "Both started." }],
			provider: "xai",
			model: "fixture",
			api: "openai-responses",
			usage: createEmptyUsage(),
			stopReason: "stop",
			timestamp: 2,
		};
		const parent = manager.appendMessage(answer);
		host.turns.end(before);
		const records = [{ attemptId: "first" }, { attemptId: "second" }];
		for (const { attemptId } of records) {
			const report = {
				version: 1,
				name: "Builder",
				claimId: attemptId,
				text: `Evidence from ${attemptId}`,
				timestamp: 3,
			};
			recordLiveWorkerReport(report);
			manager.appendCustomEntry(CONTINUOUS_CHAT_WORK_REPORT_CUSTOM_TYPE, report);
		}
		const details = { records };
		const handoff = createCustomMessage(
			BACKGROUND_WORKER_COMPLETION_CUSTOM_TYPE,
			"Both workers finished.",
			true,
			details,
			new Date(4).toISOString(),
		);
		recordLiveWorkerHandoff(details, "Both workers finished.", records, records.length);
		manager.appendCustomMessageEntry(handoff.customType, handoff.content, true, details, handoff);
		manager.flushBufferedEntries();
		const after = await host.turns.begin();
		after.markStart(handoff, true);
		expect(source.readLiveHandoffAttempts?.(handoff)).toEqual(["first", "second"]);
		const prove = () => source.proveContinuation?.(before, after, [user, answer], handoff);
		const proof = prove();
		expect(proof?.work?.text).toContain("chat ID 2");
		expect(proof?.work?.text).toContain("chat ID 3");
		expect(proof!.work!.text.indexOf("chat ID 2")).toBeLessThan(proof!.work!.text.indexOf("chat ID 3"));
		const pinnedRows = after.boundary.view.split("\n").slice(1, -1);
		for (const [index, coordinate] of after.boundary.viewCache.lines.entries()) {
			const first = continuousChatNodeFirstMessage(coordinate);
			const end = first + continuousChatNodeMessageCount(coordinate.level);
			if (first < 4 && end > 2)
				expect(proof!.work!.text.split("\n").filter((line) => line === pinnedRows[index])).toHaveLength(1);
		}
		expect(prove()?.work?.text).toEqual(proof?.work?.text);
		expect(proof?.work?.isCurrent()).toBe(true);
		owner = false;
		expect(prove()).toBeUndefined();
		owner = true;
		manager.branch(parent);
		expect(proof?.work?.isCurrent()).toBe(false);
		expect(source.readLiveHandoffAttempts?.(handoff)).toBeUndefined();
		expect(prove()).toBeUndefined();
	} finally {
		closing.abort();
		try {
			await host?.dispose();
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	}
});
