import { Agent } from "@caupulican/pi-agent-core";
import { getModel } from "@caupulican/pi-ai";
import { describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { createEvidenceBundle } from "../src/core/research/evidence-bundle.ts";
import {
	appendEvidenceBundleSnapshot,
	EVIDENCE_BUNDLE_CUSTOM_TYPE,
	getLatestEvidenceBundleSnapshot,
} from "../src/core/research/session-evidence-bundle.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createTestResourceLoader } from "./utilities.ts";

describe("Phase 9B: Evidence Bundle Session Persistence", () => {
	it("appendEvidenceBundleSnapshot stores a custom entry with customType 'evidence_bundle'", () => {
		const sessionManager = SessionManager.inMemory();
		const bundle = createEvidenceBundle({
			query: "Find bug",
			sources: [],
			findings: [],
			now: "T0",
		});

		const entryId = appendEvidenceBundleSnapshot(sessionManager, bundle);
		expect(typeof entryId).toBe("string");

		const entries = sessionManager.getEntries();
		expect(entries.length).toBe(1);
		const entry = entries[0];
		expect(entry?.type).toBe("custom");
		if (entry?.type !== "custom") throw new Error("Expected custom entry");
		expect(entry.customType).toBe(EVIDENCE_BUNDLE_CUSTOM_TYPE);
	});

	it("getLatestEvidenceBundleSnapshot returns the newest valid bundle when multiple snapshots exist", () => {
		const sessionManager = SessionManager.inMemory();
		const bundle1 = createEvidenceBundle({ query: "Search 1", sources: [], findings: [], now: "T0" });
		appendEvidenceBundleSnapshot(sessionManager, bundle1);

		const bundle2 = createEvidenceBundle({ query: "Search 2", sources: [], findings: [], now: "T1" });
		appendEvidenceBundleSnapshot(sessionManager, bundle2);

		const latest = getLatestEvidenceBundleSnapshot(sessionManager.getEntries());
		expect(latest).toBeDefined();
		expect(latest?.createdAt).toBe("T1");
		expect(latest?.query).toBe("Search 2");
	});

	it("malformed evidence_bundle entries are ignored and do not throw", () => {
		const sessionManager = SessionManager.inMemory();

		sessionManager.appendCustomEntry(EVIDENCE_BUNDLE_CUSTOM_TYPE, { version: 1 }); // Missing bundle
		sessionManager.appendCustomEntry(EVIDENCE_BUNDLE_CUSTOM_TYPE, { version: 2, bundle: {} }); // Wrong version
		sessionManager.appendCustomEntry(EVIDENCE_BUNDLE_CUSTOM_TYPE, "malformed"); // Not an object

		const bundle = createEvidenceBundle({ query: "Valid search", sources: [], findings: [], now: "T0" });
		appendEvidenceBundleSnapshot(sessionManager, bundle);

		sessionManager.appendCustomEntry(EVIDENCE_BUNDLE_CUSTOM_TYPE, { version: 1, bundle: { invalid: true } }); // Invalid bundle

		const latest = getLatestEvidenceBundleSnapshot(sessionManager.getEntries());
		expect(latest).toBeDefined();
		expect(latest?.query).toBe("Valid search");
	});

	it("invalid/non-plain evidence bundle payload is ignored while an older valid snapshot remains", () => {
		const sessionManager = SessionManager.inMemory();

		const validBundle = createEvidenceBundle({ query: "Valid", sources: [], findings: [], now: "T0" });
		appendEvidenceBundleSnapshot(sessionManager, validBundle);

		const newerValidBundle = createEvidenceBundle({ query: "Ignore me", sources: [], findings: [], now: "T1" });
		const payload = Object.assign(new Date(0), { version: 1, bundle: newerValidBundle });
		sessionManager.appendCustomEntry(EVIDENCE_BUNDLE_CUSTOM_TYPE, payload);

		const latest = getLatestEvidenceBundleSnapshot(sessionManager.getEntries());
		expect(latest?.query).toBe("Valid");
	});

	it("non-plain source or infinite confidence finding is ignored while older valid snapshot remains", () => {
		const sessionManager = SessionManager.inMemory();

		const validBundle = createEvidenceBundle({ query: "Valid", sources: [], findings: [], now: "T0" });
		appendEvidenceBundleSnapshot(sessionManager, validBundle);

		sessionManager.appendCustomEntry(EVIDENCE_BUNDLE_CUSTOM_TYPE, {
			version: 1,
			bundle: {
				query: "Bad source",
				sources: [Object.assign(new Date(0), { id: "src", kind: "workspace", trusted: true })],
				findings: [],
				createdAt: "T1",
			},
		});

		sessionManager.appendCustomEntry(EVIDENCE_BUNDLE_CUSTOM_TYPE, {
			version: 1,
			bundle: {
				query: "Bad finding",
				sources: [],
				findings: [{ id: "f1", summary: "finding", confidence: Infinity, evidenceIds: [] }],
				createdAt: "T2",
			},
		});

		const latest = getLatestEvidenceBundleSnapshot(sessionManager.getEntries());
		expect(latest?.query).toBe("Valid");
	});

	it("snapshots do not retain caller-owned nested references", () => {
		const sessionManager = SessionManager.inMemory();

		const metadata = { count: 1 };
		const evidenceIds = ["ev-1"];

		const bundle = createEvidenceBundle({
			query: "Find references",
			sources: [{ id: "src-1", kind: "workspace", trusted: true, metadata }],
			findings: [{ id: "f-1", summary: "Found it", evidenceIds }],
			now: "T0",
		});

		appendEvidenceBundleSnapshot(sessionManager, bundle);

		metadata.count = 2;
		evidenceIds.push("ev-2");

		const latest = getLatestEvidenceBundleSnapshot(sessionManager.getEntries());
		expect(latest?.sources[0].metadata).toEqual({ count: 1 });
		expect(latest?.sources[0].metadata).not.toBe(metadata);
		expect(latest?.findings[0].evidenceIds).toEqual(["ev-1"]);
		expect(latest?.findings[0].evidenceIds).not.toBe(evidenceIds);
	});

	it("invalid metadata objects are rejected and fallback to older snapshot", () => {
		const sessionManager = SessionManager.inMemory();

		const validBundle = createEvidenceBundle({
			query: "Valid",
			sources: [{ id: "src-1", kind: "workspace", trusted: true, metadata: { count: 1 } }],
			findings: [],
			now: "T0",
		});
		appendEvidenceBundleSnapshot(sessionManager, validBundle);

		sessionManager.appendCustomEntry(EVIDENCE_BUNDLE_CUSTOM_TYPE, {
			version: 1,
			bundle: {
				query: "Invalid Undefined",
				sources: [{ id: "src-2", kind: "workspace", trusted: true, metadata: { bad: undefined } }],
				findings: [],
				createdAt: "T1",
			},
		});

		sessionManager.appendCustomEntry(EVIDENCE_BUNDLE_CUSTOM_TYPE, {
			version: 1,
			bundle: {
				query: "Invalid Array",
				sources: [{ id: "src-3", kind: "workspace", trusted: true, metadata: [] }],
				findings: [],
				createdAt: "T2",
			},
		});

		sessionManager.appendCustomEntry(EVIDENCE_BUNDLE_CUSTOM_TYPE, {
			version: 1,
			bundle: {
				query: "Invalid Date",
				sources: [{ id: "src-4", kind: "workspace", trusted: true, metadata: new Date(0) }],
				findings: [],
				createdAt: "T3",
			},
		});

		sessionManager.appendCustomEntry(EVIDENCE_BUNDLE_CUSTOM_TYPE, {
			version: 1,
			bundle: {
				query: "Invalid Nested Date",
				sources: [{ id: "src-5", kind: "workspace", trusted: true, metadata: { date: new Date(0) } }],
				findings: [],
				createdAt: "T4",
			},
		});

		const latest = getLatestEvidenceBundleSnapshot(sessionManager.getEntries());
		expect(latest).toBeDefined();
		expect(latest?.query).toBe("Valid");
	});

	it("AgentSession accessors save and restore the latest snapshot using an in-memory SessionManager", () => {
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

		const bundle = createEvidenceBundle({ query: "Save test", sources: [], findings: [], now: "T0" });
		session.saveEvidenceBundleSnapshot(bundle);

		const restored = session.getEvidenceBundleSnapshot();
		expect(restored).toBeDefined();
		expect(restored?.query).toBe("Save test");
	});
});
