import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MemoryScope } from "../src/core/context/context-item.ts";
import { formatOkfMemoryDocument, PI_OKF_PROVIDER_ID, type PiOkfType } from "../src/core/context/okf-memory.ts";
import {
	createOkfMemoryProvider,
	listOkfMemoryKinds,
	listOkfMemoryScopes,
	loadOkfMemoryBundle,
} from "../src/core/context/okf-memory-provider.ts";

function okfDocument(
	title: string,
	description: string,
	body: string,
	type: PiOkfType = "Design Decision",
	scope: MemoryScope = "project",
): string {
	return formatOkfMemoryDocument({
		type,
		title,
		description,
		scope,
		body,
		evidenceRefs: ["transcript:accepted-review"],
		timestamp: "2026-06-30T00:00:00Z",
	});
}

describe("Pi OKF memory provider", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-okf-memory-provider-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("loads valid OKF files, reports invalid files, and summarizes available scopes/kinds", () => {
		mkdirSync(join(tempDir, "nested"));
		writeFileSync(
			join(tempDir, "artifact-output.okf.md"),
			okfDocument(
				"Artifact output",
				"Large grep/find output must be artifact-backed.",
				"Implementation details for artifact-backed output.",
			),
			"utf8",
		);
		writeFileSync(join(tempDir, "nested", "broken.okf.md"), "---\ntype: [bad\n---\nbody", "utf8");

		const report = loadOkfMemoryBundle({ rootDir: tempDir });

		expect(report.entries).toHaveLength(1);
		expect(report.entries[0]?.relativePath).toBe("artifact-output.okf.md");
		expect(report.entries[0]?.parsed.item).toMatchObject({
			providerId: PI_OKF_PROVIDER_ID,
			id: "artifact-output.okf.md",
			kind: "design_decision",
			scope: "project",
		});
		expect(report.diagnostics).toHaveLength(1);
		expect(report.diagnostics[0]?.diagnostics[0]?.code).toBe("invalid_yaml");
		expect(listOkfMemoryScopes(report)).toEqual(["project"]);
		expect(listOkfMemoryKinds(report)).toEqual(["design_decision"]);
	});

	it("searches local OKF memory without external egress and respects scope, kind, and result caps", async () => {
		writeFileSync(
			join(tempDir, "artifact-output.okf.md"),
			okfDocument(
				"Artifact output",
				"Large grep/find output must be artifact-backed.",
				"Search results include artifact refs for retrieval.",
			),
			"utf8",
		);
		writeFileSync(
			join(tempDir, "settings-playbook.okf.md"),
			okfDocument(
				"Settings playbook",
				"User-facing settings need settings-menu exposure.",
				"Runtime-only facts are not user settings.",
				"Tooling Playbook",
			),
			"utf8",
		);
		const provider = createOkfMemoryProvider({ rootDir: tempDir });

		expect(provider.source).toBe("pi_native");
		expect(provider.capabilities.localOnly).toBe(true);
		expect(provider.capabilities.write).toBe(false);

		const artifactHits = await provider.search({
			query: "artifact grep retrieval",
			scope: "project",
			kinds: ["design_decision"],
			maxResults: 1,
		});
		expect(artifactHits).toHaveLength(1);
		expect(artifactHits[0]?.item.id).toBe("artifact-output.okf.md");
		expect(artifactHits[0]?.reason).toContain("local OKF match score");

		const noScopeHits = await provider.search({ query: "artifact", scope: "user", maxResults: 5 });
		expect(noScopeHits).toEqual([]);
	});

	it("fetches by normalized memory ref and ignores refs for other providers", async () => {
		writeFileSync(
			join(tempDir, "artifact-output.okf.md"),
			okfDocument("Artifact output", "Large grep/find output must be artifact-backed.", "Details."),
			"utf8",
		);
		const provider = createOkfMemoryProvider({ rootDir: tempDir });
		const hits = await provider.search({ query: "artifact", scope: "project", maxResults: 1 });
		const ref = hits[0]?.item.refs[0];
		expect(ref).toBeDefined();
		if (ref === undefined) throw new Error("expected memory ref");

		expect(await provider.fetch(ref)).toEqual(hits[0]?.item);
		expect(await provider.fetch({ ...ref, providerId: "other-provider" })).toBeUndefined();
	});

	it("caps document loading and skips oversized files", () => {
		writeFileSync(
			join(tempDir, "small.okf.md"),
			okfDocument("Small", "Small OKF memory should load.", "small body"),
			"utf8",
		);
		writeFileSync(
			join(tempDir, "oversize.okf.md"),
			`${okfDocument("Huge", "Huge file", "body")}\n${"x".repeat(1_000)}`,
			"utf8",
		);

		const report = loadOkfMemoryBundle({ rootDir: tempDir, maxFileBytes: 600, maxDocuments: 10 });
		expect(report.entries.map((entry) => entry.relativePath)).toEqual(["small.okf.md"]);
	});
});
