import { describe, expect, it } from "vitest";
import {
	formatOkfMemoryDocument,
	okfMemoryItemToWriteRequest,
	PI_OKF_AUTHORITY,
	PI_OKF_PROVIDER_ID,
	parseOkfMemoryDocument,
	validateOkfProjectRulePromotion,
} from "../src/core/context/okf-memory.ts";

function validDocument(
	overrides: Partial<{ type: string; scope: string; authority: string; evidenceRefs: string[] }> = {},
): string {
	const type = overrides.type ?? "Design Decision";
	const scope = overrides.scope ?? "project";
	const authority = overrides.authority ?? PI_OKF_AUTHORITY;
	const evidenceRefs = overrides.evidenceRefs ?? ["artifact:tool-output:abc123", "transcript:entry-1"];
	return `---
type: ${type}
title: Context management uses artifact-backed tool output
description: Large tool outputs are stored out of prompt and referenced by artifact id.
tags: [context-management, artifacts, cost]
timestamp: 2026-06-30T00:00:00Z
pi:
  scope: ${scope}
  authority: ${authority}
  evidence_refs:
${evidenceRefs.map((ref) => `    - ${ref}`).join("\n")}
---

Decision body with implementation details.
`;
}

describe("Pi OKF memory profile", () => {
	it("parses a strict OKF design decision into a Pi-native durable memory item", () => {
		const parsed = parseOkfMemoryDocument(validDocument(), { uri: "okf://project/context-output" });

		expect(parsed.diagnostics).toEqual([]);
		expect(parsed.body).toBe("Decision body with implementation details.");
		expect(parsed.item).toMatchObject({
			providerId: PI_OKF_PROVIDER_ID,
			source: "pi_native",
			kind: "design_decision",
			scope: "project",
			durability: "durable",
			title: "Context management uses artifact-backed tool output",
			summary: "Large tool outputs are stored out of prompt and referenced by artifact id.",
			content: "Decision body with implementation details.",
			timestamp: "2026-06-30T00:00:00Z",
		});
		const item = parsed.item;
		expect(item).toBeDefined();
		if (item === undefined) throw new Error("expected parsed item");
		expect(item.refs).toEqual([
			{
				providerId: PI_OKF_PROVIDER_ID,
				itemId: item.id,
				scope: "project",
				kind: "design_decision",
				uri: "okf://project/context-output",
			},
		]);
		expect(item.evidenceRefs).toEqual([
			{
				type: "external",
				id: "artifact:tool-output:abc123",
				providerId: PI_OKF_PROVIDER_ID,
				description: "OKF evidence_ref",
			},
			{
				type: "external",
				id: "transcript:entry-1",
				providerId: PI_OKF_PROVIDER_ID,
				description: "OKF evidence_ref",
			},
		]);
	});

	it("formats OKF documents that round-trip through the strict parser", () => {
		const formatted = formatOkfMemoryDocument({
			type: "Tooling Playbook",
			title: "Review before commit",
			description: "Run focused tests and npm run check before committing source changes.",
			scope: "project",
			body: "Use explicit staging paths; never git add -A.",
			tags: ["workflow", "git"],
			timestamp: "2026-06-30T01:00:00Z",
			evidenceRefs: ["transcript:review-accepted"],
		});

		const parsed = parseOkfMemoryDocument(formatted, { fallbackId: "playbook-1" });
		expect(parsed.diagnostics).toEqual([]);
		expect(parsed.item).toMatchObject({
			id: "playbook-1",
			kind: "procedure",
			title: "Review before commit",
			summary: "Run focused tests and npm run check before committing source changes.",
			content: "Use explicit staging paths; never git add -A.",
		});
	});

	it("returns diagnostics and no item for missing or invalid authority fields", () => {
		const parsed = parseOkfMemoryDocument(validDocument({ scope: "team", authority: "trusted_project_rule" }));

		expect(parsed.item).toBeUndefined();
		expect(parsed.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["invalid_scope", "invalid_authority"]);
	});

	it("returns diagnostics for missing frontmatter and invalid YAML without throwing", () => {
		expect(parseOkfMemoryDocument("No frontmatter here").diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
			"missing_frontmatter",
		]);
		expect(parseOkfMemoryDocument("---\ntype: [bad\n---\nbody").diagnostics[0]?.code).toBe("invalid_yaml");
	});

	it("keeps project-rule candidates as memory until explicitly promoted", () => {
		const parsed = parseOkfMemoryDocument(validDocument({ type: "Project Rule Candidate" }), {
			fallbackId: "rule-1",
		});
		expect(parsed.item).toMatchObject({ kind: "project_rule_candidate", source: "pi_native", durability: "durable" });

		const item = parsed.item;
		expect(item).toBeDefined();
		if (item === undefined) throw new Error("expected parsed item");
		expect(validateOkfProjectRulePromotion({ item })).toEqual(["missing_explicit_promotion_authority"]);
		expect(validateOkfProjectRulePromotion({ item, approvalId: "approval-1" })).toEqual([]);
	});

	it("blocks stale or conflicting project-rule candidates even when promotion authority exists", () => {
		const parsed = parseOkfMemoryDocument(validDocument({ type: "Project Rule Candidate" }), {
			fallbackId: "rule-1",
		});
		const item = parsed.item;
		expect(item).toBeDefined();
		if (item === undefined) throw new Error("expected parsed item");

		expect(
			validateOkfProjectRulePromotion({
				item: { ...item, stale: true, conflict: "current repo instructions supersede this memory" },
				approvalId: "approval-1",
			}),
		).toEqual(["stale_or_conflicting_memory"]);
	});

	it("converts parsed OKF memory into an approval-gated write request shape", () => {
		const parsed = parseOkfMemoryDocument(validDocument({ type: "User Preference", scope: "user" }), {
			fallbackId: "pref-1",
		});
		const item = parsed.item;
		expect(item).toBeDefined();
		if (item === undefined) throw new Error("expected parsed item");

		const writeRequest = okfMemoryItemToWriteRequest(item, "import existing OKF memory");
		expect(writeRequest).toMatchObject({
			providerId: PI_OKF_PROVIDER_ID,
			scope: "user",
			kind: "user_preference",
			title: "Context management uses artifact-backed tool output",
			sensitivity: "normal",
			reason: "import existing OKF memory",
		});
		expect(writeRequest.evidenceRefs).toHaveLength(2);
	});
});
