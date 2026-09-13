/**
 * The USER.md write transaction with learning metadata at the file-store owner. Admission is a
 * fake here (its real owner is tested in reflection-owner-evidence.test.ts); this file pins that an
 * accepted preference and its metadata land together in one human-readable line, that identity
 * and revision survive replacement, that stale and candidate writes change nothing, that scope is
 * host-checked in every projection, and that archived preferences stay in the projection.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MemoryLifecycleContext } from "../src/core/memory/memory-provider.ts";
import { FileStoreProvider } from "../src/core/memory/providers/file-store.ts";
import {
	newUserPreferenceId,
	parseUserPreferenceLine,
	type UserPreferenceAdmissionRequest,
	type UserPreferenceAdmissionResult,
	type UserPreferenceMetadata,
} from "../src/core/memory/user-preference-metadata.ts";
import { PERSONA_PROJECTION_RULE } from "../src/core/provider-prompt-contracts.ts";
import { getDirectoryResourceProfileInfo } from "../src/core/settings-manager.ts";

type ToolParams = Record<string, unknown>;

describe("USER.md preference writes carry learning metadata", () => {
	let testDir: string;
	let agentDir: string;
	let admissions: UserPreferenceAdmissionRequest[];
	let admit: (request: UserPreferenceAdmissionRequest) => UserPreferenceAdmissionResult;

	beforeEach(() => {
		testDir = mkdtempSync(join(tmpdir(), "pi-user-pref-write-"));
		agentDir = join(testDir, "agent");
		mkdirSync(agentDir, { recursive: true });
		admissions = [];
		admit = (request) => ({
			outcome: "apply",
			reasonCode: "test",
			metadata: {
				id: request.existing?.metadata?.id ?? "0badc0de",
				scope: request.scope,
				basis: request.basis,
				observations: request.evidence.length,
				revision: (request.existing?.metadata?.revision ?? 0) + 1,
				sources: request.evidence.map((citation) => citation.source),
			},
		});
	});
	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	async function start(cwd = testDir, withAdmitter = true) {
		const provider = new FileStoreProvider(
			withAdmitter
				? {
						admitUserPreference: async (request) => {
							admissions.push(request);
							return admit(request);
						},
					}
				: {},
		);
		const ctx: MemoryLifecycleContext = { agentDir, cwd, isChildSession: false };
		await provider.initialize("pref-session", ctx);
		const tool = provider.getToolDefinitions().find((t) => t.name === "memory");
		if (!tool) throw new Error("memory tool missing");
		return {
			provider,
			run: (params: ToolParams) => tool.execute("call", params, undefined, undefined, {} as never),
			user: () => readFileSync(join(agentDir, "USER.md"), "utf8"),
		};
	}

	function details(result: unknown): Record<string, unknown> {
		return ((result as { details?: Record<string, unknown> }).details ?? {}) as Record<string, unknown>;
	}

	it("writes the accepted preference and its metadata as one line, then keeps identity across replace and remove", async () => {
		const { run, user, provider } = await start();
		const added = await run({
			action: "add",
			target: "user",
			content: "Keep status updates short.",
			scope: "global",
			basis: "explicit",
			evidence: [{ source: "s1/e1", quote: "keep status updates short" }],
		});
		expect(details(added).success).toBe(true);
		expect(admissions.at(-1)).toMatchObject({ action: "add", basis: "explicit", scope: { kind: "global" } });
		const line = user().trim();
		expect(line).toBe("Keep status updates short. [pref 0badc0de | global | explicit | n=1 | rev=1 | src=s1/e1]");
		expect(provider.systemPromptBlock()).toContain(
			`## USER.md:\n${PERSONA_PROJECTION_RULE}\n- Keep status updates short. (explicit)`,
		);
		expect(provider.systemPromptBlock()).not.toContain("[pref ");

		const replaced = await run({
			action: "replace",
			target: "user",
			oldContent: "Keep status updates short.",
			content: "Keep status updates to one paragraph.",
			basis: "explicit",
			evidence: [{ source: "s1/e5", quote: "one paragraph" }],
			expectedRevision: 1,
		});
		expect(details(replaced).success).toBe(true);
		expect(admissions.at(-1)?.existing?.metadata).toMatchObject({ id: "0badc0de", revision: 1 });
		const parsed = parseUserPreferenceLine(user().trim());
		expect(parsed.text).toBe("Keep status updates to one paragraph.");
		expect(parsed.metadata).toMatchObject({ id: "0badc0de", revision: 2, sources: ["s1/e5"] });

		const stale = await run({
			action: "replace",
			target: "user",
			oldContent: "Keep status updates to one paragraph.",
			content: "Never mind.",
			expectedRevision: 1,
		});
		expect(details(stale).success).toBe(false);
		expect(details(stale).reasonCode).toBe("stale_revision");
		expect(user()).toContain("rev=2");

		const removed = await run({
			action: "remove",
			target: "user",
			oldContent: "Keep status updates to one paragraph.",
		});
		expect(details(removed).success).toBe(true);
		expect(user().trim()).toBe("");
	});

	it("a candidate outcome changes nothing and is reported as a candidate, not an approval question", async () => {
		const { run, user } = await start();
		admit = () => ({ outcome: "candidate", reasonCode: "insufficient_observations", message: "one source" });
		const result = await run({ action: "add", target: "user", content: "Prefers verbose logs." });
		expect(details(result)).toMatchObject({
			success: false,
			candidate: true,
			reasonCode: "insufficient_observations",
		});
		expect(user().trim()).toBe("");
		const text = (result as { content: Array<{ text?: string }> }).content.map((part) => part.text ?? "").join("");
		expect(text).toContain("candidate");
		expect(text).not.toMatch(/approve|confirm\?/i);
	});

	it("negative control: without an admission owner a write is labelled unverified, never evidence-backed", async () => {
		const { run, user } = await start(testDir, false);
		await run({
			action: "add",
			target: "user",
			content: "Prefers tabs.",
			basis: "explicit",
			evidence: [{ source: "s1/e1" }],
		});
		expect(parseUserPreferenceLine(user().trim()).metadata).toMatchObject({
			basis: "unverified",
			observations: 0,
			sources: [],
		});
	});

	it("leaves legacy lines untouched and never fabricates metadata for them", async () => {
		writeFileSync(join(agentDir, "USER.md"), "Prefers tabs.\n", "utf8");
		const { run, user, provider } = await start();
		await provider.acceptDrift("user");
		await run({
			action: "add",
			target: "user",
			content: "Keep status updates short.",
			basis: "explicit",
			evidence: [{ source: "s1/e1" }],
		});
		const lines = user().trim().split("\n");
		expect(lines[0]).toBe("Prefers tabs.");
		expect(lines[1]).toContain("[pref ");
		expect(provider.systemPromptBlock()).toContain("- Prefers tabs.\n");
		// A near-duplicate add supersedes the legacy line in place; the admission owner sees it as legacy.
		await run({
			action: "add",
			target: "user",
			content: "Prefers tabs, always.",
			basis: "explicit",
			evidence: [{ source: "s1/e2" }],
		});
		expect(admissions.at(-1)?.existing).toEqual({ text: "Prefers tabs." });
		expect(user()).not.toContain("Prefers tabs.\n");
		expect(user()).toContain("Prefers tabs, always. [pref ");
	});

	it("checks project scope by directory key in the static block, the persona record and the handoff guidance", async () => {
		const projectA = join(testDir, "a");
		const projectB = join(testDir, "b");
		mkdirSync(projectA);
		mkdirSync(projectB);
		const a = await start(projectA);
		await a.run({
			action: "add",
			target: "user",
			content: "Keep status updates short.",
			scope: "global",
			basis: "explicit",
			evidence: [{ source: "s/1" }],
		});
		await a.run({
			action: "add",
			target: "user",
			content: "Run the fast shard first here.",
			scope: "project",
			basis: "explicit",
			evidence: [{ source: "s/2" }],
		});
		const keyA = getDirectoryResourceProfileInfo(projectA, agentDir).hash;
		expect(a.user()).toContain(`project=${keyA}`);
		expect(a.provider.systemPromptBlock()).toContain("Run the fast shard first here.");
		a.provider.onSystemPromptBlockFrozen("");
		expect(a.provider.userPersonaProjection()?.content).toContain("Run the fast shard first here.");
		expect(a.provider.getHandoffPersonaGuidance()).toContain("Run the fast shard first here.");

		const b = await start(projectB);
		expect(b.provider.systemPromptBlock()).toContain("Keep status updates short.");
		expect(b.provider.systemPromptBlock()).not.toContain("Run the fast shard first here.");
		b.provider.onSystemPromptBlockFrozen("");
		expect(b.provider.userPersonaProjection()?.content).not.toContain("Run the fast shard first here.");
		expect(b.provider.getHandoffPersonaGuidance()).not.toContain("Run the fast shard first here.");
		expect(b.provider.getHandoffPersonaGuidance()).toContain("Keep status updates short.");
		expect(b.provider.getHandoffPersonaGuidance()).toContain(PERSONA_PROJECTION_RULE);
	});

	it("keeps applicable archived preferences in the projection after USER.md overflows into shards", async () => {
		const { run, provider, user } = await start();
		const metadata: UserPreferenceMetadata = {
			id: "0badc0de",
			scope: { kind: "global" },
			basis: "explicit",
			observations: 1,
			revision: 1,
			sources: ["s/1"],
		};
		admit = (request) => ({
			outcome: "apply",
			reasonCode: "test",
			metadata: {
				...metadata,
				id: request.existing?.metadata?.id ?? Math.random().toString(16).slice(2, 10).padEnd(8, "0"),
			},
		});
		// Distinct sentences: near-duplicate lines would supersede each other instead of accumulating.
		const sentences = [
			"Prefers tabs for indentation in every language.",
			"Runs the focused test file before any commit.",
			"Wants commit messages in the imperative mood.",
			"Reads the diff before the explanation.",
			"Keeps status updates to one paragraph.",
			"Asks for evidence numbers in a table.",
			"Avoids em dashes and parentheses in prose.",
			"Likes headers only in long reports.",
			"Expects failing regressions before fixes.",
			"Never wants artifacts published.",
			"Prefers rebase over merge commits.",
			"Wants adjacent findings listed at the end.",
			"Treats workarounds as failed tasks.",
			"Verifies Windows behavior on the host.",
		];
		for (const sentence of sentences) {
			const result = await run({
				action: "add",
				target: "user",
				content: sentence,
				basis: "explicit",
				evidence: [{ source: "s/1" }],
			});
			expect(details(result).success, JSON.stringify((result as { content: unknown }).content)).toBe(true);
		}
		expect(user()).toContain("Archived preferences:");
		const block = provider.systemPromptBlock();
		expect(block).toContain("Prefers tabs for indentation in every language.");
		expect(block).not.toContain("Archived preferences:");
		expect(block).not.toContain("[pref ");
		// Whole lines only: every USER line of the block is one of the sentences or the footer, never a cut.
		const userSection = block.slice(block.indexOf("## USER.md:")).split("\n").slice(2);
		for (const line of userSection) {
			const isSentence = sentences.some((sentence) => line === `- ${sentence} (explicit)`);
			const isFooter = /^\(\d+ more preference lines? in USER\.md\)$/.test(line);
			expect(isSentence || isFooter, line).toBe(true);
		}
		expect(block).not.toContain("…truncated");
		expect(userSection.length).toBeLessThan(sentences.length + 1);
		const guidance = provider.getHandoffPersonaGuidance() ?? "";
		expect(guidance.length).toBeLessThanOrEqual(800);
		expect(guidance).toContain("Prefers tabs for indentation in every language.");
		expect(guidance).toMatch(/\(\d+ more preference lines? in USER\.md\)$/);
		// The persona record delivers the same selection, still whole lines.
		provider.onSystemPromptBlockFrozen("");
		const record = provider.userPersonaProjection()?.content ?? "";
		for (const line of record.split("\n").filter((candidate) => candidate.startsWith("- "))) {
			expect(
				sentences.some((sentence) => line === `- ${sentence} (explicit)`),
				line,
			).toBe(true);
		}
	});

	it("reports the terminal result to the admission owner once: persisted after commit, refused on a budget error", async () => {
		const reports: unknown[] = [];
		admit = (request) => ({
			outcome: "apply",
			reasonCode: "test",
			metadata: {
				id: request.existing?.metadata?.id ?? "0badc0de",
				scope: request.scope,
				basis: "explicit",
				observations: 1,
				revision: (request.existing?.metadata?.revision ?? 0) + 1,
				sources: ["s/1"],
			},
			commit: (report) => reports.push(report),
		});
		const { run } = await start();
		expect(details(await run({ action: "add", target: "user", content: "Keep status updates short." })).success).toBe(
			true,
		);
		expect(reports).toEqual([{ persisted: true }]);
	});

	it("keeps a legacy line's section heading as context in the block, the record, the handoff, the archive and after reload", async () => {
		writeFileSync(
			join(agentDir, "USER.md"),
			"# User profile\nPrefers tabs.\n## GrimDex engineering roles\nRoot designs; Luna implements.\n### Luna\nLuna owns the UI.\n",
			"utf8",
		);
		const first = await start();
		const block = first.provider.systemPromptBlock();
		expect(block).toContain("- Prefers tabs.\n");
		expect(block).toContain("- GrimDex engineering roles: Root designs; Luna implements.");
		expect(block).toContain("- GrimDex engineering roles › Luna: Luna owns the UI.");
		expect(block).not.toContain("User profile:");
		const guidance = first.provider.getHandoffPersonaGuidance() ?? "";
		expect(guidance).toContain("- GrimDex engineering roles: Root designs; Luna implements.");
		first.provider.onSystemPromptBlockFrozen("");
		expect(first.provider.userPersonaProjection()?.content).toContain(
			"- GrimDex engineering roles: Root designs; Luna implements.",
		);

		// Literal matching is untouched by the rendered form: the file line is what a replace names.
		const replaced = await first.run({
			action: "replace",
			target: "user",
			oldContent: "Root designs; Luna implements.",
			content: "Root designs; Luna implements and reviews.",
			scope: "global",
			basis: "explicit",
			evidence: [{ source: "s/1", quote: "x" }],
		});
		expect(details(replaced).success).toBe(true);
		const afterReplace = first.provider.systemPromptBlock();
		// The annotated replacement carries verified scope and no longer borrows the heading.
		expect(afterReplace).toContain("- Root designs; Luna implements and reviews. (explicit)");
		expect(afterReplace).not.toContain("GrimDex engineering roles: Root designs");
		expect(afterReplace).toContain("- GrimDex engineering roles › Luna: Luna owns the UI.");

		// Overflow: the section travels with the legacy line into the archive shard and back out.
		admit = (request) => ({
			outcome: "apply",
			reasonCode: "test",
			metadata: {
				id: request.existing?.metadata?.id ?? Math.random().toString(16).slice(2, 10).padEnd(8, "0"),
				scope: request.scope,
				basis: "explicit",
				observations: 1,
				revision: (request.existing?.metadata?.revision ?? 0) + 1,
				sources: ["s/1"],
			},
		});
		const fillers = [
			"Runs the focused test file before any commit.",
			"Wants commit messages in the imperative mood.",
			"Reads the diff before the explanation.",
			"Keeps status updates to one paragraph.",
			"Asks for evidence numbers in a table.",
			"Avoids em dashes and parentheses in prose.",
			"Likes headers only in long reports.",
			"Expects failing regressions before fixes.",
			"Never wants artifacts published.",
			"Prefers rebase over merge commits.",
			"Wants adjacent findings listed at the end.",
			"Treats workarounds as failed tasks.",
		];
		for (const sentence of fillers) {
			const result = await first.run({
				action: "add",
				target: "user",
				content: sentence,
				basis: "explicit",
				evidence: [{ source: "s/1" }],
			});
			expect(details(result).success, JSON.stringify((result as { content: unknown }).content)).toBe(true);
		}
		expect(first.user()).toContain("Archived preferences:");
		expect(first.provider.systemPromptBlock()).toContain("- GrimDex engineering roles › Luna: Luna owns the UI.");

		// A fresh provider over the same files re-reads the archive with its headings.
		const second = await start();
		expect(second.provider.systemPromptBlock()).toContain("- GrimDex engineering roles › Luna: Luna owns the UI.");
		expect(second.provider.getHandoffPersonaGuidance() ?? "").toContain(
			"GrimDex engineering roles › Luna: Luna owns the UI.",
		);
	});

	it("scope identity: an add supersedes only its own scope, and a replace never touches another project's line", async () => {
		const projectA = join(testDir, "scope-a");
		const projectB = join(testDir, "scope-b");
		mkdirSync(projectA);
		mkdirSync(projectB);
		// Identity as the real admission owner derives it: text plus project key when scoped.
		admit = (request) => ({
			outcome: "apply",
			reasonCode: "test",
			metadata: {
				id: request.existing?.metadata?.id ?? newUserPreferenceId(request.text, request.scope),
				scope: request.scope,
				basis: request.basis,
				observations: request.evidence.length,
				revision: (request.existing?.metadata?.revision ?? 0) + 1,
				sources: request.evidence.map((citation) => citation.source),
			},
		});
		const a = await start(projectA);
		const b = await start(projectB);
		const text = "Keep status updates short.";
		expect(
			details(
				await a.run({
					action: "add",
					target: "user",
					content: text,
					scope: "project",
					basis: "explicit",
					evidence: [{ source: "s/1", quote: "x" }],
				}),
			).success,
		).toBe(true);
		expect(
			details(
				await b.run({
					action: "add",
					target: "user",
					content: text,
					scope: "project",
					basis: "explicit",
					evidence: [{ source: "s/2", quote: "x" }],
				}),
			).success,
		).toBe(true);
		const lines = () => a.user().trim().split("\n").map(parseUserPreferenceLine);
		expect(lines()).toHaveLength(2);
		expect(lines()[0].metadata?.id).not.toBe(lines()[1].metadata?.id);
		const keyA = getDirectoryResourceProfileInfo(projectA, agentDir).hash;
		const keyB = getDirectoryResourceProfileInfo(projectB, agentDir).hash;
		expect(lines().map((line) => line.metadata?.scope)).toEqual([
			{ kind: "project", projectKey: keyA },
			{ kind: "project", projectKey: keyB },
		]);

		// A same-scope add of a near-duplicate supersedes that scope's line only.
		expect(
			details(
				await a.run({
					action: "add",
					target: "user",
					content: "Keep status updates short, always.",
					scope: "project",
					basis: "explicit",
					evidence: [{ source: "s/3", quote: "x" }],
				}),
			).success,
		).toBe(true);
		expect(lines()).toHaveLength(2);
		expect(lines().map((line) => line.text)).toEqual(["Keep status updates short, always.", text]);

		// Replace from project B names the literal text: only B's line changes.
		expect(
			details(
				await b.run({
					action: "replace",
					target: "user",
					oldContent: text,
					content: "Keep status updates to one line.",
					basis: "explicit",
					evidence: [{ source: "s/4", quote: "x" }],
				}),
			).success,
		).toBe(true);
		expect(lines().map((line) => line.text)).toEqual([
			"Keep status updates short, always.",
			"Keep status updates to one line.",
		]);
		expect(lines()[1].metadata?.scope).toEqual({ kind: "project", projectKey: keyB });

		// Global and this project's line with the same words: the write must name its scope.
		expect(
			details(
				await a.run({
					action: "add",
					target: "user",
					content: "Keep status updates short, always.",
					scope: "global",
					basis: "explicit",
					evidence: [{ source: "s/5", quote: "x" }],
				}),
			).success,
		).toBe(true);
		const ambiguous = await a.run({
			action: "remove",
			target: "user",
			oldContent: "Keep status updates short, always.",
		});
		expect(details(ambiguous).success).toBe(false);
		expect(String((ambiguous as { content: Array<{ text?: string }> }).content[0]?.text)).toContain("pass scope");
		expect(
			details(
				await a.run({
					action: "remove",
					target: "user",
					oldContent: "Keep status updates short, always.",
					scope: "global",
				}),
			).success,
		).toBe(true);
		expect(lines().map((line) => line.metadata?.scope.kind)).toEqual(["project", "project"]);
		// Legacy (global) behavior is unchanged: a global add still supersedes a near-duplicate legacy line.
		writeFileSync(join(agentDir, "USER.md"), `${a.user()}Prefers tabs.\n`, "utf8");
		await a.provider.acceptDrift("user");
		expect(
			details(
				await a.run({
					action: "add",
					target: "user",
					content: "Prefers tabs, always.",
					basis: "explicit",
					evidence: [{ source: "s/6", quote: "x" }],
				}),
			).success,
		).toBe(true);
		expect(a.user()).not.toContain("Prefers tabs.\n");
		expect(a.user()).toContain("Prefers tabs, always. [pref ");
	});

	it("matches against the archive as it is now, not a startup snapshot, when a peer provider changed it", async () => {
		const first = await start();
		admit = (request) => ({
			outcome: "apply",
			reasonCode: "test",
			metadata: {
				id: request.existing?.metadata?.id ?? Math.random().toString(16).slice(2, 10).padEnd(8, "0"),
				scope: request.scope,
				basis: "explicit",
				observations: 1,
				revision: (request.existing?.metadata?.revision ?? 0) + 1,
				sources: ["s/1"],
			},
		});
		const sentences = [
			"Prefers tabs for indentation in every language.",
			"Runs the focused test file before any commit.",
			"Wants commit messages in the imperative mood.",
			"Reads the diff before the explanation.",
			"Keeps status updates to one paragraph.",
			"Asks for evidence numbers in a table.",
			"Avoids em dashes and parentheses in prose.",
			"Likes headers only in long reports.",
			"Expects failing regressions before fixes.",
			"Never wants artifacts published.",
			"Prefers rebase over merge commits.",
			"Wants adjacent findings listed at the end.",
			"Treats workarounds as failed tasks.",
			"Verifies Windows behavior on the host.",
		];
		// A second, long-lived provider over the same agent dir started before any archive existed.
		const peer = await start();
		for (const sentence of sentences) {
			expect(
				details(
					await first.run({
						action: "add",
						target: "user",
						content: sentence,
						basis: "explicit",
						evidence: [{ source: "s/1" }],
					}),
				).success,
			).toBe(true);
		}
		expect(first.user()).toContain("Archived preferences:");
		// The peer never saw the archive being created; its write must still find the archived line.
		const replaced = await peer.run({
			action: "replace",
			target: "user",
			oldContent: "Prefers tabs for indentation in every language.",
			content: "Prefers tabs for indentation everywhere.",
			basis: "explicit",
			evidence: [{ source: "s/9", quote: "x" }],
		});
		expect(details(replaced).success, JSON.stringify((replaced as { content: unknown }).content)).toBe(true);
		expect(peer.provider.systemPromptBlock()).toContain("Prefers tabs for indentation everywhere.");
		expect(peer.provider.systemPromptBlock()).not.toContain("Prefers tabs for indentation in every language.");
	});
});
