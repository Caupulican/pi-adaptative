import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CapabilityEnvelope, EvidenceRef, Finding } from "../src/core/autonomy/contracts.ts";
import { isAutomataAvailable } from "../src/core/research/automata-provider.ts";
import { createEvidenceBundle } from "../src/core/research/evidence-bundle.ts";
import { evaluateResearchRequest } from "../src/core/research/research-gate.ts";

describe("Research Gate (Phase 5)", () => {
	describe("createEvidenceBundle", () => {
		it("preserves provenance and copies arrays", () => {
			const sources: EvidenceRef[] = [
				{ id: "s1", kind: "workspace", trusted: true, uri: "/file.ts", metadata: { m1: "v1" } },
			];
			const findings: Finding[] = [{ id: "f1", summary: "found something", evidenceIds: ["s1"] }];
			const bundle = createEvidenceBundle({ query: "q", sources, findings, now: "T1" });

			expect(bundle.query).toBe("q");
			expect(bundle.createdAt).toBe("T1");
			expect(bundle.sources).toEqual(sources);
			expect(bundle.findings).toEqual(findings);
		});

		it("mutating caller sources/findings after bundle creation does not mutate the bundle", () => {
			const sources: EvidenceRef[] = [
				{ id: "s1", kind: "workspace", trusted: true, metadata: { nested: { value: "before" } } },
			];
			const findings: Finding[] = [{ id: "f1", summary: "found something", evidenceIds: ["s1"] }];
			const bundle = createEvidenceBundle({ query: "q", sources, findings, now: "T1" });

			sources.push({ id: "s2", kind: "web", trusted: false });
			findings[0].evidenceIds = ["s1", "s2"];
			const source = sources[0];
			if (!source) throw new Error("Expected source");
			source.metadata = { modified: true };

			expect(bundle.sources.length).toBe(1);
			expect(bundle.findings[0].evidenceIds).toEqual(["s1"]);
			expect(bundle.sources[0].metadata).toEqual({ nested: { value: "before" } });
		});
	});

	describe("evaluateResearchRequest", () => {
		const baseEnvelope: CapabilityEnvelope = { id: "e1", capabilities: [] };

		it("workspace research without read_files/research blocks", () => {
			const outcome = evaluateResearchRequest({
				envelope: baseEnvelope,
				sourceKind: "workspace",
				estimatedUsd: 0,
			});
			expect(outcome.outcome).toBe("block");
			expect(outcome.reasonCode).toBe("missing_capability");
		});

		it("workspace research with read_files allows", () => {
			const outcome = evaluateResearchRequest({
				envelope: { ...baseEnvelope, capabilities: ["read_files"] },
				sourceKind: "workspace",
				estimatedUsd: 0,
			});
			expect(outcome.outcome).toBe("allow");
		});

		it("transcript research without memory_read blocks", () => {
			const outcome = evaluateResearchRequest({
				envelope: baseEnvelope,
				sourceKind: "transcript",
				estimatedUsd: 0,
			});
			expect(outcome.outcome).toBe("block");
			expect(outcome.reasonCode).toBe("missing_capability");
		});

		it("automata/private history without privateHistoryAllowed returns ask-user/block", () => {
			const outcome = evaluateResearchRequest({
				envelope: { ...baseEnvelope, capabilities: ["memory_read"] },
				sourceKind: "automata",
				estimatedUsd: 0,
				privateHistoryAllowed: false,
			});
			expect(outcome.outcome).toBe("ask-user");
			expect(outcome.reasonCode).toBe("private_history_denied");
		});

		it("automata research with memory_read and privateHistoryAllowed allows", () => {
			const outcome = evaluateResearchRequest({
				envelope: { ...baseEnvelope, capabilities: ["memory_read"] },
				sourceKind: "automata",
				estimatedUsd: 0,
				privateHistoryAllowed: true,
			});
			expect(outcome.outcome).toBe("allow");
		});

		it("web research without network blocks", () => {
			const outcome = evaluateResearchRequest({
				envelope: baseEnvelope,
				sourceKind: "web",
				estimatedUsd: 0,
			});
			expect(outcome.outcome).toBe("block");
			expect(outcome.reasonCode).toBe("missing_capability");
		});

		it("over-budget request returns ask-user/block with over_budget", () => {
			const outcome = evaluateResearchRequest({
				envelope: { ...baseEnvelope, maxEstimatedUsd: 1.0, capabilities: ["network"] },
				sourceKind: "web",
				estimatedUsd: 2.0,
			});
			expect(outcome.outcome).toBe("ask-user");
			expect(outcome.reasonCode).toBe("over_budget");
		});

		it("missing/malformed envelope blocks", () => {
			const outcome = evaluateResearchRequest({
				envelope: null,
				sourceKind: "workspace",
				estimatedUsd: 0,
			});
			expect(outcome.outcome).toBe("block");
			expect(outcome.reasonCode).toBe("missing_envelope");
		});

		it("unknown source kind blocks", () => {
			const outcome = evaluateResearchRequest({
				envelope: { ...baseEnvelope, capabilities: ["research"] },
				sourceKind: "unknown",
				estimatedUsd: 0,
			});
			expect(outcome.outcome).toBe("block");
			expect(outcome.reasonCode).toBe("unknown_source_kind");
		});
	});

	describe("isAutomataAvailable", () => {
		let tempDir: string;
		let execPath: string;
		let dbPath: string;

		beforeEach(() => {
			tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-automata-test-"));
			execPath = path.join(tempDir, "automata");
			dbPath = path.join(tempDir, "db.sqlite");
		});

		afterEach(() => {
			fs.rmSync(tempDir, { recursive: true, force: true });
		});

		it("missing Automata executable/db returns unavailable/false without throwing", () => {
			expect(isAutomataAvailable({})).toBe(false);
			expect(isAutomataAvailable({ executablePath: execPath, dbPath: dbPath })).toBe(false);
		});

		it("existing executable and db paths return true", () => {
			fs.writeFileSync(execPath, "");
			fs.writeFileSync(dbPath, "");
			expect(isAutomataAvailable({ executablePath: execPath, dbPath: dbPath })).toBe(true);
		});
	});
});
