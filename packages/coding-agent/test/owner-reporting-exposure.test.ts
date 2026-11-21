import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configFile } from "../src/core/agent-paths.ts";
import type { MemoryPromptBudget } from "../src/core/context/memory-prompt-budget.ts";
import type { LearningAuditRecord } from "../src/core/learning/learning-audit.ts";
import { KnowledgeProjectionReader } from "../src/core/memory/knowledge-projection.ts";
import { type KnowledgeRecord, knowledgeId } from "../src/core/memory/knowledge-record.ts";
import { KnowledgeStore } from "../src/core/memory/knowledge-store.ts";
import { ownerPreferenceAttestation } from "../src/core/memory/owner-preference-attestations.ts";
import { migrateOwnerPreferenceProofs } from "../src/core/memory/owner-preference-proof-migration.ts";
import {
	classifyOwnerReportingRequirement,
	OwnerReportingAdmission,
	prepareOwnerReportingMemory,
	reportingKnowledgeDigest,
} from "../src/core/memory/owner-reporting-admission.ts";
import { FileStoreProvider } from "../src/core/memory/providers/file-store.ts";
import {
	knowledgeReportingRequirements,
	NO_REPORTING_REQUIREMENTS,
	ReportingRequirementExposure,
	userReportingRequirements,
} from "../src/core/memory/reporting-requirement-exposure.ts";
import {
	formatUserPreferenceLine,
	type ParsedUserPreferenceLine,
} from "../src/core/memory/user-preference-metadata.ts";
import { DecisionLedgerStore } from "../src/core/operator-projection/decision-ledger-store.ts";

const directories: string[] = [];
afterEach(() => {
	for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "pi-reporting-exposure-"));
	directories.push(root);
	return { root, path: join(root, "ledger.sqlite") };
}
function preference(
	text = "Report monetary amounts in EUR, with the currency label.",
	revision = 1,
): ParsedUserPreferenceLine {
	return {
		text,
		metadata: {
			id: "1234abcd",
			revision,
			basis: "explicit",
			observations: 1,
			scope: { kind: "global" },
			sources: [`session/entry-${revision}`],
			evidenceAt: `2026-11-20T00:00:0${revision}.000Z`,
		},
	};
}
function receipt(value: ParsedUserPreferenceLine, removed = false): LearningAuditRecord {
	return {
		id: "audit-00000000-0000-4000-8000-000000000000",
		proposalId: `user-pref-${value.metadata!.id}-r${value.metadata!.revision}`,
		layer: "memory",
		action: "apply",
		summary: "Synthetic owner admission",
		reasonCode: "explicit_owner_preference",
		decision: {
			kind: "apply",
			reasonCode: "explicit_owner_preference",
			confidence: 100,
			summary: "Synthetic",
			requiresApproval: false,
		},
		ownerPreference: ownerPreferenceAttestation(removed ? "" : value.text, value.metadata!, removed),
		createdAt: "2026-11-20T00:00:00.000Z",
	};
}
function exposure(value: ParsedUserPreferenceLine, exposed = true) {
	return { preferences: [{ preference: value, exposed }], complete: true, isCurrent: () => true };
}
function classify(store: DecisionLedgerStore, value: ParsedUserPreferenceLine, reporting: boolean) {
	store.ownerPreferences.classify(ownerPreferenceAttestation(value.text, value.metadata!)!.digest, reporting);
}

describe("owner reporting requirement exposure", () => {
	it("keeps failed reads empty only while SQLite can exclude a relevant positive proof", () => {
		const { path } = fixture();
		const ledger = new DecisionLedgerStore({ databasePath: path });
		const scope = { project: "aaaa1111", role: "", audience: "owner" };
		const proofs = ledger.ownerPreferences;
		const missingKnowledge = () => knowledgeReportingRequirements(undefined, undefined, scope, proofs);
		const missingUser = (projectKey: string) => userReportingRequirements(undefined, proofs, projectKey);
		try {
			const value = preference();
			const local = {
				...value,
				metadata: { ...value.metadata!, scope: { kind: "project" as const, projectKey: scope.project } },
			};
			proofs.observe(receipt(local));
			proofs.classify("0".repeat(64), false);
			const beforeKnowledge = missingKnowledge();
			const beforeUser = missingUser(scope.project);
			const healthyUser = userReportingRequirements(exposure(local), proofs);
			expect(healthyUser.complete && healthyUser.isCurrent()).toBe(true);
			expect(beforeKnowledge.complete && beforeKnowledge.isCurrent()).toBe(true);
			expect(beforeUser.complete && beforeUser.isCurrent()).toBe(true);
			classify(ledger, local, true);
			expect(beforeKnowledge.isCurrent()).toBe(false);
			expect(beforeUser.isCurrent()).toBe(false);
			expect(healthyUser.isCurrent()).toBe(false);
			expect(missingKnowledge().complete).toBe(false);
			expect(missingUser(scope.project).complete).toBe(false);
			expect(missingUser("bbbb2222").complete).toBe(true);
			expect(userReportingRequirements(exposure(local), undefined).complete).toBe(false);
			expect(knowledgeReportingRequirements(undefined, undefined, scope).complete).toBe(false);
		} finally {
			ledger.close();
		}
	});

	it("keeps manually seeded explicit trailers advisory, and retains exact admitted reporting proof across reopen", () => {
		const { path } = fixture();
		const value = preference();
		let ledger = new DecisionLedgerStore({ databasePath: path });
		try {
			expect(userReportingRequirements(exposure(value), ledger.ownerPreferences).requirements).toEqual([]);
			ledger.ownerPreferences.observe(receipt(value));
			classify(ledger, value, true);
			for (let i = 0; i < 300; i++) ledger.ownerPreferences.classify(i.toString(16).padStart(64, "0"), false);
		} finally {
			ledger.close();
		}
		ledger = new DecisionLedgerStore({ databasePath: path });
		try {
			expect(userReportingRequirements(exposure(value), ledger.ownerPreferences).requirements).toEqual([
				{ id: "user:1234abcd:1", text: value.text },
			]);
			for (const changed of [
				{ ...value, text: "Different instruction" },
				{ ...value, metadata: { ...value.metadata!, scope: { kind: "project" as const, projectKey: "abcdef12" } } },
			]) {
				expect(userReportingRequirements(exposure(changed), ledger.ownerPreferences).requirements).toEqual([]);
			}
		} finally {
			ledger.close();
		}
	});

	it("excludes unrelated confirmed preferences and only holds an omitted reporting obligation", () => {
		const { path } = fixture();
		const ledger = new DecisionLedgerStore({ databasePath: path });
		try {
			const coding = preference("Use dependency injection in production code.");
			ledger.ownerPreferences.observe(receipt(coding));
			classify(ledger, coding, false);
			expect(userReportingRequirements(exposure(coding, false), ledger.ownerPreferences)).toMatchObject({
				requirements: [],
				complete: true,
			});
			const reporting = preference();
			ledger.ownerPreferences.observe(receipt(preference("", 2), true));
			const current = preference(reporting.text, 3);
			ledger.ownerPreferences.observe(receipt(current));
			classify(ledger, current, true);
			expect(userReportingRequirements(exposure(current, false), ledger.ownerPreferences)).toMatchObject({
				requirements: [],
				complete: false,
			});
		} finally {
			ledger.close();
		}
	});

	it("fences a captured obligation on revocation and refuses a stale successful receipt replay", () => {
		const { path } = fixture();
		const ledger = new DecisionLedgerStore({ databasePath: path });
		try {
			const value = preference();
			ledger.ownerPreferences.observe(receipt(value));
			classify(ledger, value, true);
			const projected = userReportingRequirements(exposure(value), ledger.ownerPreferences);
			expect(projected.isCurrent()).toBe(true);
			ledger.ownerPreferences.observe(receipt(preference("", 2), true));
			ledger.ownerPreferences.observe(receipt(value));
			expect(projected.isCurrent()).toBe(false);
			expect(userReportingRequirements(exposure(value), ledger.ownerPreferences).requirements).toEqual([]);
			const restated = {
				...value,
				metadata: {
					...value.metadata!,
					sources: ["session/new-owner-statement"],
					evidenceAt: "2026-11-20T00:00:03.000Z",
				},
			};
			ledger.ownerPreferences.observe(receipt(restated));
			classify(ledger, restated, true);
			expect(userReportingRequirements(exposure(restated), ledger.ownerPreferences).requirements).toHaveLength(1);
		} finally {
			ledger.close();
		}
	});

	it("classifies an exact confirmed revision once, including a retained ambiguous result, without exporting legacy notes", async () => {
		const { path } = fixture();
		const ledger = new DecisionLedgerStore({ databasePath: path });
		try {
			const value = preference();
			ledger.ownerPreferences.observe(receipt(value));
			const admission = new OwnerReportingAdmission();
			const seen: string[] = [];
			const input = {
				admission,
				store: ledger.ownerPreferences,
				user: exposure(value),
				isCurrent: () => true,
				classify: async (input: { preference: string }) => {
					seen.push(input.preference);
					return undefined;
				},
			};
			await prepareOwnerReportingMemory(input);
			await prepareOwnerReportingMemory(input);
			expect(seen).toEqual([value.text]);
			expect(userReportingRequirements(exposure(value), ledger.ownerPreferences).requirements).toEqual([]);
			await prepareOwnerReportingMemory({ ...input, user: exposure(preference("Imported unrelated text")) });
			expect(seen).toHaveLength(1);
		} finally {
			ledger.close();
		}
	});

	it("clears accepted disabled exposure and removes stale or unreadable contents before a display or verifier reads it", () => {
		const owner = new ReportingRequirementExposure();
		expect(owner.current()).toMatchObject({ requirements: [], complete: false });
		let enabled = true;
		owner.publish({
			requirements: [{ id: "test", text: "Private requirement" }],
			complete: true,
			isCurrent: () => enabled,
		});
		expect(owner.current().requirements).toHaveLength(1);
		enabled = false;
		expect(owner.current()).toMatchObject({ requirements: [], complete: false });
		owner.clear();
		expect(owner.current()).toMatchObject({ requirements: [], complete: false });
		owner.publish(NO_REPORTING_REQUIREMENTS);
		expect(owner.current()).toMatchObject({ requirements: [], complete: true });
		owner.publish({
			requirements: [{ id: "test", text: "Private requirement" }],
			complete: true,
			isCurrent: () => {
				throw new Error("Closed storage");
			},
		});
		expect(owner.current()).toMatchObject({ requirements: [], complete: false });
	});

	it("does not block an existing explicit preference admission on a subtype transport failure", async () => {
		expect(
			await classifyOwnerReportingRequirement(async () => {
				throw new Error("Synthetic transport failure");
			}, "Report amounts in EUR"),
		).toBeUndefined();
	});

	it("opportunistically migrates exact prior audit plus original scoped owner statement, rejecting shown or changed scope", () => {
		const { path } = fixture();
		const ledger = new DecisionLedgerStore({ databasePath: path });
		try {
			const value = preference();
			const audit = {
				...receipt(value),
				ownerPreference: undefined,
				rollback: {
					kind: "memory_remove" as const,
					target: value.text,
					instructions: "Remove added USER preference",
				},
			};
			const statement = `Remember globally: ${value.text}`;
			const original = {
				sourceId: value.metadata!.sources[0]!,
				entryId: "entry-1",
				createdAt: value.metadata!.evidenceAt!,
				text: statement,
			};
			migrateOwnerPreferenceProofs({
				preferences: [value],
				audits: [audit],
				originals: [{ ...original, pasted: [{ start: 0, end: statement.length }] }],
				store: ledger.ownerPreferences,
			});
			expect(ledger.ownerPreferences.confirms(value)).toBe(false);
			migrateOwnerPreferenceProofs({
				preferences: [
					{ ...value, metadata: { ...value.metadata!, scope: { kind: "project", projectKey: "abcd1234" } } },
				],
				audits: [audit],
				originals: [original],
				store: ledger.ownerPreferences,
			});
			expect(ledger.ownerPreferences.confirms(value)).toBe(false);
			const sourceProject = {
				...value,
				metadata: { ...value.metadata!, scope: { kind: "project" as const, projectKey: "aaaa1111" } },
			};
			const forgedProject = {
				...sourceProject,
				metadata: { ...sourceProject.metadata, scope: { kind: "project" as const, projectKey: "bbbb2222" } },
			};
			migrateOwnerPreferenceProofs({
				preferences: [forgedProject],
				audits: [audit],
				originals: [{ ...original, text: `Remember for this project: ${value.text}` }],
				store: ledger.ownerPreferences,
			});
			expect(ledger.ownerPreferences.confirms(forgedProject)).toBe(false);
			migrateOwnerPreferenceProofs({
				preferences: [value],
				audits: [
					{
						...audit,
						ownerPreference: ownerPreferenceAttestation("Mismatched authoritative value", value.metadata!),
					},
				],
				originals: [original],
				store: ledger.ownerPreferences,
			});
			expect(ledger.ownerPreferences.confirms(value)).toBe(false);
			migrateOwnerPreferenceProofs({
				preferences: [value],
				audits: [audit],
				originals: [original],
				store: ledger.ownerPreferences,
			});
			expect(ledger.ownerPreferences.confirms(value)).toBe(true);
		} finally {
			ledger.close();
		}
	});

	it("keeps knowledge reporting bound to exact revision, scope, validity and forgetting", () => {
		const { root, path } = fixture();
		const ledger = new DecisionLedgerStore({ databasePath: path });
		const store = KnowledgeStore.open(join(root, "agent"));
		const scope = { project: "synthetic-project", role: "", audience: "owner" };
		const identity = { kind: "behavior" as const, scope, subject: "owner", key: "reporting" };
		const record: KnowledgeRecord = {
			...identity,
			id: knowledgeId(identity),
			revision: 1,
			text: "Include the source filename when reporting a retry ceiling.",
			basis: "explicit",
			firstEvidencedAt: "2026-01-01T00:00:00.000Z",
			lastEvidencedAt: "2026-01-01T00:00:00.000Z",
			validFrom: "2026-01-01T00:00:00.000Z",
			citations: [
				{
					sourceId: "owner-command:synthetic",
					sessionId: "synthetic",
					quote: "Confirmed synthetic requirement",
					at: "2026-01-01T00:00:00.000Z",
				},
			],
		};
		const budget: MemoryPromptBudget = {
			enabled: true,
			compact: false,
			maxLines: 500,
			maxChars: 100000,
			maxEstimatedTokens: 25000,
			maxResults: 100,
		};
		try {
			store.put(record, 0, () => {});
			const reader = new KnowledgeProjectionReader(store);
			const pending = knowledgeReportingRequirements(
				reader.preview(scope, budget),
				store,
				scope,
				ledger.ownerPreferences,
			);
			expect(pending.isCurrent()).toBe(true);
			ledger.ownerPreferences.classify(reportingKnowledgeDigest(record), true);
			expect(pending.isCurrent()).toBe(false);
			const captured = knowledgeReportingRequirements(
				reader.preview(scope, budget),
				store,
				scope,
				ledger.ownerPreferences,
			);
			expect(captured.requirements).toHaveLength(1);
			expect(captured.isCurrent()).toBe(true);
			const omitted = knowledgeReportingRequirements(
				reader.preview(scope, { ...budget, maxChars: 1 }),
				store,
				scope,
				ledger.ownerPreferences,
			);
			expect(omitted).toMatchObject({ requirements: [], complete: false });
			const other = { ...scope, project: "another-project" };
			expect(knowledgeReportingRequirements(undefined, store, other, ledger.ownerPreferences).complete).toBe(true);
			expect(knowledgeReportingRequirements(undefined, store, scope, ledger.ownerPreferences).complete).toBe(false);
			expect(
				knowledgeReportingRequirements(reader.preview(other, budget), store, other, ledger.ownerPreferences),
			).toMatchObject({ requirements: [], complete: true });
			const corrected = {
				...record,
				revision: 2,
				text: "Use the newly confirmed reporting format.",
				lastEvidencedAt: "2026-01-02T00:00:00.000Z",
				citations: [{ ...record.citations[0]!, at: "2026-01-02T00:00:00.000Z" }],
			};
			store.put(corrected, 1, () => {});
			expect(captured.isCurrent()).toBe(false);
			expect(
				knowledgeReportingRequirements(reader.preview(scope, budget), store, scope, ledger.ownerPreferences)
					.requirements,
			).toEqual([]);
			ledger.ownerPreferences.classify(reportingKnowledgeDigest(corrected), true);
			store.forget(record.id, 2, [{ ...record.citations[0]!, at: "2026-01-03T00:00:00.000Z" }], () => {});
			expect(
				knowledgeReportingRequirements(reader.preview(scope, budget), store, scope, ledger.ownerPreferences),
			).toMatchObject({ requirements: [], complete: true });
		} finally {
			store.close();
			ledger.close();
		}
	});

	it("does not open excluded owner proofs and contains a failed lazy proof read", () => {
		const owner = new ReportingRequirementExposure();
		const scope = { project: "synthetic-project", role: "", audience: "owner" };
		const getProofs = vi.fn(() => {
			throw new Error("Synthetic unavailable proof store");
		});
		expect(owner.projectKnowledge(false, undefined, undefined, scope, getProofs)).toBe(NO_REPORTING_REQUIREMENTS);
		expect(getProofs).not.toHaveBeenCalled();
		const unavailable = owner.projectKnowledge(true, undefined, undefined, scope, getProofs);
		expect(getProofs).toHaveBeenCalledTimes(1);
		expect(unavailable.complete).toBe(false);
		expect(unavailable.isCurrent()).toBe(false);
	});

	it.each([
		...[99, 100, 101, 201].flatMap((count) =>
			(["behavior", "taste"] as const).map((kind) => ({ count, kind, positiveAtCapture: true })),
		),
		{ count: 201, kind: "taste" as const, positiveAtCapture: false },
		{ count: 10000, kind: "behavior" as const, positiveAtCapture: false },
	])(
		"discovers whole $kind rules across $count records (positive at capture: $positiveAtCapture)",
		({ count, kind, positiveAtCapture }) => {
			const { root, path } = fixture();
			const ledger = new DecisionLedgerStore({ databasePath: path });
			const store = KnowledgeStore.open(join(root, "agent"));
			const scope = { project: "synthetic-project", role: "", audience: "owner" };
			const records: KnowledgeRecord[] = [];
			if (positiveAtCapture) ledger.ownerPreferences.classify("f".repeat(64), true);
			try {
				for (let index = 0; index < count; index++) {
					const identity = { kind, scope, subject: "owner", key: `rule-${index}` };
					const at = index === 0 ? "2026-01-01T00:00:00.000Z" : "2026-01-02T00:00:00.000Z";
					const record: KnowledgeRecord = {
						...identity,
						id: knowledgeId(identity),
						revision: 1,
						text: `Confirmed instruction ${index}`,
						basis: "explicit",
						firstEvidencedAt: at,
						lastEvidencedAt: at,
						validFrom: at,
						...(index === 0 ? { validUntil: "2099-01-01T00:00:00.000Z" } : {}),
						citations: [
							{
								sourceId: "owner-command:synthetic",
								sessionId: "synthetic",
								quote: "Confirmed instruction",
								at,
							},
						],
					};
					store.put(record, 0, () => {});
					records.push(record);
				}
				const snapshot = vi.spyOn(store, "snapshot");
				const list = vi.spyOn(store, "list");
				const projection = { references: [], isCurrent: () => true } as unknown as ReturnType<
					KnowledgeProjectionReader["preview"]
				>;
				const capture = () => knowledgeReportingRequirements(projection, store, scope, ledger.ownerPreferences);
				const started = performance.now();
				const pending = capture();
				const captureMs = performance.now() - started;
				expect(pending.complete && pending.isCurrent()).toBe(true);
				expect(snapshot).toHaveBeenCalledTimes(1);
				const pages = count < 100 ? 0 : Math.floor(count / 100) + 1;
				expect(list).toHaveBeenCalledTimes(positiveAtCapture ? pages : 0);
				for (const [index, call] of list.mock.calls.entries()) {
					expect(call[1]).toMatchObject({ kind, limit: 100 });
					if (index > 0) expect(call[1]!.after).toBe(list.mock.results[index - 1]!.value.at(-1).id);
					expect(list.mock.results[index]!.value.length).toBeLessThanOrEqual(100);
				}
				for (let index = 0; index < 3; index++) expect(pending.isCurrent()).toBe(true);
				expect(snapshot).toHaveBeenCalledTimes(1);
				expect(list).toHaveBeenCalledTimes(positiveAtCapture ? pages : 0);
				if (!positiveAtCapture) {
					ledger.ownerPreferences.classify("f".repeat(64), true);
					const started = performance.now();
					expect(pending.isCurrent()).toBe(true);
					const deferredMs = performance.now() - started;
					expect(list).toHaveBeenCalledTimes(pages);
					for (let index = 0; index < 3; index++) expect(pending.isCurrent()).toBe(true);
					expect(list).toHaveBeenCalledTimes(pages);
					expect(snapshot).toHaveBeenCalledTimes(1);
					if (count === 10000)
						process.stdout.write(
							`${JSON.stringify({
								scenario: "zero-positive-knowledge-capture",
								count,
								captureMs,
								deferredMs,
								snapshots: snapshot.mock.calls.length,
								pages,
								returnedRows: list.mock.results.reduce((sum, result) => sum + result.value.length, 0),
								maximumPage: Math.max(...list.mock.results.map((result) => result.value.length)),
							})}\n`,
						);
				}
				ledger.ownerPreferences.classify(reportingKnowledgeDigest(records[0]!), true);
				expect(pending.isCurrent()).toBe(false);
				const confirmed = capture();
				expect(confirmed.complete).toBe(false);
				expect(confirmed.isCurrent()).toBe(true);
				expect(confirmed.requirements).toEqual([]);
				if (count === 201 && kind === "behavior" && positiveAtCapture) {
					const owner = new ReportingRequirementExposure();
					let proofChecks = 0;
					const captureProof = ledger.ownerPreferences.captureReportingProofs.bind(ledger.ownerPreferences);
					const proofCapture = vi
						.spyOn(ledger.ownerPreferences, "captureReportingProofs")
						.mockImplementation((candidates) => {
							const proof = captureProof(candidates);
							return {
								...proof,
								isCurrent: () => {
									proofChecks++;
									return proof.isCurrent();
								},
							};
						});
					const project = (view = projection, viewScope = scope, proofs = ledger.ownerPreferences) =>
						owner.projectKnowledge(true, view, store, viewScope, () => proofs);
					const first = project();
					const pageReads = list.mock.calls.length;
					const snapshotReads = snapshot.mock.calls.length;
					for (let index = 0; index < 3; index++) expect(project()).toBe(first);
					expect(proofCapture).toHaveBeenCalledTimes(1);
					expect(proofChecks).toBe(3);
					expect(list).toHaveBeenCalledTimes(pageReads);
					expect(snapshot).toHaveBeenCalledTimes(snapshotReads);
					owner.publish(first, () => true);
					expect(project()).toBe(first);
					ledger.ownerPreferences.classify(reportingKnowledgeDigest(records[1]!), true);
					expect(project()).not.toBe(first);
					const revised = {
						...records[1]!,
						revision: 2,
						text: "Revised non-reporting instruction",
						lastEvidencedAt: "2026-01-03T00:00:00.000Z",
						citations: [{ ...records[1]!.citations[0]!, at: "2026-01-03T00:00:00.000Z" }],
					};
					store.put(revised, 1, () => {});
					records[1] = revised;
					const changed = project();
					expect(changed).not.toBe(first);
					const visible = { ...projection, references: [{ id: records[0]!.id, revision: 1 }] };
					expect(project(visible)).toMatchObject({ complete: true, requirements: [{ text: records[0]!.text }] });
					const other = { ...scope, project: "unrelated-project" };
					expect(project(projection, other)).toMatchObject({ complete: true, requirements: [] });
					const otherLedger = new DecisionLedgerStore({ databasePath: join(root, "other-ledger.sqlite") });
					try {
						expect(project(projection, scope, otherLedger.ownerPreferences)).toMatchObject({
							complete: true,
							requirements: [],
						});
					} finally {
						otherLedger.close();
					}
					const beforeClear = project();
					owner.clear();
					expect(project()).not.toBe(beforeClear);
					const beforeExcluded = project();
					expect(owner.projectKnowledge(false, projection, store, scope, () => ledger.ownerPreferences)).toBe(
						NO_REPORTING_REQUIREMENTS,
					);
					expect(project()).not.toBe(beforeExcluded);
					const beforeLegacy = project();
					owner.publish(NO_REPORTING_REQUIREMENTS);
					expect(project()).not.toBe(beforeLegacy);
					const beforeExpiry = project();
					vi.useFakeTimers();
					vi.setSystemTime(new Date("2099-01-01T00:00:00.000Z"));
					expect(project()).not.toBe(beforeExpiry);
					expect(project().complete).toBe(true);
					vi.useRealTimers();
				}
				vi.useFakeTimers();
				vi.setSystemTime(new Date("2099-01-01T00:00:00.000Z"));
				expect(confirmed.isCurrent()).toBe(false);
				expect(capture().complete).toBe(true);
				vi.useRealTimers();
				expect(knowledgeReportingRequirements(undefined, store, scope, ledger.ownerPreferences).complete).toBe(
					false,
				);
				const other = { ...scope, project: "unrelated-project" };
				expect(knowledgeReportingRequirements(undefined, store, other, ledger.ownerPreferences).complete).toBe(
					true,
				);
				store.forget(
					records[0]!.id,
					1,
					[{ ...records[0]!.citations[0]!, at: "2026-01-03T00:00:00.000Z" }],
					() => {},
				);
				expect(confirmed.isCurrent()).toBe(false);
				expect(capture().complete).toBe(true);
				if (count > 100) {
					let mutated = false;
					list.mockImplementationOnce((...args) => {
						const page = KnowledgeStore.prototype.list.call(store, ...args);
						store.put(
							{
								...records[1]!,
								revision: records[1]!.revision + 1,
								text: "Changed during the scan",
								lastEvidencedAt: "2026-01-04T00:00:00.000Z",
								citations: [{ ...records[1]!.citations[0]!, at: "2026-01-04T00:00:00.000Z" }],
							},
							records[1]!.revision,
							() => {},
						);
						mutated = true;
						return page;
					});
					expect(capture()).toMatchObject({ complete: false });
					expect(mutated).toBe(true);
				}
			} finally {
				vi.useRealTimers();
				vi.restoreAllMocks();
				store.close();
				ledger.close();
			}
		},
	);

	it("uses actual FileStore whole-line static and current persona exposure, and fences a replaced snapshot", async () => {
		const { root } = fixture();
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		mkdirSync(agentDir);
		mkdirSync(cwd);
		const value = preference();
		const userPath = configFile(agentDir, "USER.md");
		mkdirSync(join(userPath, ".."), { recursive: true });
		writeFileSync(userPath, formatUserPreferenceLine(value.text, value.metadata!));
		const writer = new FileStoreProvider();
		await writer.initialize("synthetic", {
			agentDir,
			cwd,
			readsOwnerMemory: true,
			ownsMemoryWrites: true,
			ownsHistory: true,
			isChildSession: false,
		});
		writer.onSystemPromptBlockFrozen(writer.systemPromptBlock());
		const initial = writer.userPreferenceExposure()!;
		expect(initial.preferences[0]?.exposed).toBe(true);
		writer.onSystemPromptBlockFrozen("");
		expect(initial.isCurrent()).toBe(false);
		const tiny: MemoryPromptBudget = {
			enabled: true,
			compact: false,
			maxLines: 0,
			maxChars: 1,
			maxEstimatedTokens: 1,
			maxResults: 1,
		};
		expect(writer.userPreferenceExposure(tiny)?.preferences[0]?.exposed).toBe(false);
		expect(writer.userPreferenceExposure()?.preferences[0]?.exposed).toBe(true);
	});
});
