import { Agent } from "@caupulican/pi-agent-core";
import { SessionManager } from "@caupulican/pi-agent-core/node";
import { getModel } from "@caupulican/pi-ai";
import { describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import {
	appendWorkerResultSnapshot,
	getWorkerResultSnapshots,
	WORKER_RESULT_CUSTOM_TYPE,
} from "../src/core/delegation/session-worker-result.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { createEvidenceBundle } from "../src/core/research/evidence-bundle.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createTestResourceLoader } from "./utilities.ts";

describe("Phase 9C: Worker Result Session Persistence", () => {
	it("appendWorkerResultSnapshot stores a custom entry with WORKER_RESULT_CUSTOM_TYPE", () => {
		const sessionManager = SessionManager.inMemory();
		const result = {
			requestId: "req-1",
			status: "completed" as const,
			summary: "Done",
			changedFiles: [],
		};

		const entryId = appendWorkerResultSnapshot(sessionManager, result);
		expect(typeof entryId).toBe("string");

		const entries = sessionManager.getEntries();
		expect(entries.length).toBe(1);
		const entry = entries[0];
		expect(entry?.type).toBe("custom");
		if (entry?.type !== "custom") throw new Error("Expected custom entry");
		expect(entry.customType).toBe(WORKER_RESULT_CUSTOM_TYPE);
	});

	it("getWorkerResultSnapshots returns all valid snapshots in chronological order", () => {
		const sessionManager = SessionManager.inMemory();
		const result1 = { requestId: "req-1", status: "completed" as const, summary: "R1", changedFiles: [] };
		appendWorkerResultSnapshot(sessionManager, result1);

		const result2 = { requestId: "req-2", status: "blocked" as const, summary: "R2", changedFiles: [] };
		appendWorkerResultSnapshot(sessionManager, result2);

		const snapshots = getWorkerResultSnapshots(sessionManager.getEntries());
		expect(snapshots.length).toBe(2);
		expect(snapshots[0].requestId).toBe("req-1");
		expect(snapshots[1].requestId).toBe("req-2");
	});

	it("malformed worker_result entries are ignored and do not throw", () => {
		const sessionManager = SessionManager.inMemory();

		sessionManager.appendCustomEntry(WORKER_RESULT_CUSTOM_TYPE, null); // Null payload
		sessionManager.appendCustomEntry(WORKER_RESULT_CUSTOM_TYPE, []); // Array payload
		sessionManager.appendCustomEntry(WORKER_RESULT_CUSTOM_TYPE, { version: 1 }); // Missing result
		sessionManager.appendCustomEntry(WORKER_RESULT_CUSTOM_TYPE, { version: 2, result: {} }); // Wrong version
		sessionManager.appendCustomEntry(WORKER_RESULT_CUSTOM_TYPE, "malformed"); // Not an object

		const validResult = { requestId: "req-valid", status: "completed" as const, summary: "Valid", changedFiles: [] };
		appendWorkerResultSnapshot(sessionManager, validResult);

		sessionManager.appendCustomEntry(WORKER_RESULT_CUSTOM_TYPE, { version: 1, result: { invalid: true } }); // Invalid result

		const nonPlainResult = Object.assign(new Date(0), {
			requestId: "req-non-plain",
			status: "completed",
			summary: "Invalid non-plain",
			changedFiles: [],
		});
		sessionManager.appendCustomEntry(WORKER_RESULT_CUSTOM_TYPE, { version: 1, result: nonPlainResult });

		const validResult2 = {
			requestId: "req-valid-2",
			status: "completed" as const,
			summary: "Valid 2",
			changedFiles: [],
		};
		const payload = Object.assign(new Date(0), { version: 1, result: validResult2 });
		sessionManager.appendCustomEntry(WORKER_RESULT_CUSTOM_TYPE, payload);

		const snapshots = getWorkerResultSnapshots(sessionManager.getEntries());
		expect(snapshots.length).toBe(1);
		expect(snapshots[0].requestId).toBe("req-valid");
	});

	it("invalid nested evidence causes that worker_result snapshot to be ignored", () => {
		const sessionManager = SessionManager.inMemory();

		const validResult = { requestId: "req-valid", status: "completed" as const, summary: "Valid", changedFiles: [] };
		appendWorkerResultSnapshot(sessionManager, validResult);

		sessionManager.appendCustomEntry(WORKER_RESULT_CUSTOM_TYPE, {
			version: 1,
			result: {
				requestId: "req-invalid",
				status: "completed",
				summary: "Invalid",
				changedFiles: [],
				evidence: {
					query: "test",
					sources: [{ id: "src-1", kind: "workspace", trusted: true, metadata: [] }], // Invalid evidence metadata
					findings: [],
				},
			},
		});

		const snapshots = getWorkerResultSnapshots(sessionManager.getEntries());
		expect(snapshots.length).toBe(1);
		expect(snapshots[0].requestId).toBe("req-valid");
	});

	it("snapshots do not retain caller-owned nested references", () => {
		const sessionManager = SessionManager.inMemory();
		const changedFiles = ["file.ts"];
		const blockers = ["blocked"];
		const metadata = { test: 1 };
		const evidenceIds = ["ev-1"];

		const result = {
			requestId: "req-1",
			status: "blocked" as const,
			summary: "Test",
			changedFiles,
			blockers,
			evidence: createEvidenceBundle({
				query: "q",
				sources: [{ id: "src-1", kind: "workspace", trusted: true, metadata }],
				findings: [{ id: "f-1", summary: "f", evidenceIds }],
			}),
		};

		appendWorkerResultSnapshot(sessionManager, result);

		changedFiles.push("other.ts");
		blockers.push("other");
		metadata.test = 2;
		evidenceIds.push("ev-2");

		const snapshots = getWorkerResultSnapshots(sessionManager.getEntries());
		const snapshot = snapshots[0];

		expect(snapshot.changedFiles).toEqual(["file.ts"]);
		expect(snapshot.changedFiles).not.toBe(changedFiles);

		expect(snapshot.blockers).toEqual(["blocked"]);
		expect(snapshot.blockers).not.toBe(blockers);

		expect(snapshot.evidence?.sources[0].metadata).toEqual({ test: 1 });
		expect(snapshot.evidence?.sources[0].metadata).not.toBe(metadata);

		expect(snapshot.evidence?.findings[0].evidenceIds).toEqual(["ev-1"]);
		expect(snapshot.evidence?.findings[0].evidenceIds).not.toBe(evidenceIds);
	});

	it("AgentSession accessors save and restore snapshots with an in-memory SessionManager", () => {
		const sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.inMemory();
		const model = getModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Missing test model");

		const agent = new Agent({
			getApiKey: () => "test",
			initialState: {
				model,
				systemPrompt: "test",
				tools: [],
				thinkingLevel: "off",
			},
		});
		const session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			resourceLoader: createTestResourceLoader(),
			cwd: process.cwd(),
			modelRegistry: ModelRegistry.inMemory(AuthStorage.inMemory()),
		});

		session.saveWorkerResultSnapshot({
			requestId: "req-1",
			status: "completed",
			summary: "Test Accessors",
			changedFiles: [],
		});

		const snapshots = session.getWorkerResultSnapshots();
		expect(snapshots.length).toBe(1);
		expect(snapshots[0].summary).toBe("Test Accessors");
	});
});
