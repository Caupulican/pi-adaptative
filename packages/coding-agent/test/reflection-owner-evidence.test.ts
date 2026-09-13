/**
 * Owner evidence and preference admission at the reflection controller (the existing
 * observation/gate/audit owner). Source identity, quote matching, replay counting, scope, and the
 * apply/candidate outcome are host work and deterministic; whether a quoted sentence really means
 * the preference the model wrote is model work and is not asserted here.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createDeterministicCompaction,
	DEFAULT_COMPACTION_SETTINGS,
	prepareCompaction,
} from "@caupulican/pi-agent-core/compaction";
import { SessionManager } from "@caupulican/pi-agent-core/session";
import { afterEach, describe, expect, it } from "vitest";
import type { LearningDecision } from "../src/core/autonomy/contracts.ts";
import { getLearningAuditSnapshots } from "../src/core/learning/learning-audit.ts";
import { ObservationStore, observationKey } from "../src/core/learning/observation-store.ts";
import type {
	UserPreferenceAdmissionRequest,
	UserPreferenceMetadata,
} from "../src/core/memory/user-preference-metadata.ts";
import {
	OWNER_EVIDENCE_CUSTOM_TYPE,
	ReflectionController,
	type ReflectionControllerDeps,
} from "../src/core/reflection-controller.ts";
import { type Settings, SettingsManager } from "../src/core/settings-manager.ts";

const tempDirs: string[] = [];
afterEach(() => {
	for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function tempDir(): string {
	const directory = join(tmpdir(), `pi-owner-evidence-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(directory, { recursive: true });
	tempDirs.push(directory);
	return directory;
}

function createController(
	sessionManager: SessionManager,
	agentDir: string,
	settings: Partial<Settings> = {},
): { controller: ReflectionController; decisions: LearningDecision[] } {
	const decisions: LearningDecision[] = [];
	const settingsManager = SettingsManager.inMemory({
		autoLearn: { enabled: true, reflectionReview: true },
		...settings,
	});
	const controller = new ReflectionController({
		getSettingsManager: () => settingsManager,
		getSessionManager: () => sessionManager,
		getAgentDir: () => agentDir,
		isChildSession: () => false,
		isDisposed: () => false,
		emitAutonomyTelemetry: () => undefined,
		saveLearningDecisionSnapshot: (decision: LearningDecision) => {
			decisions.push(decision);
			return "decision";
		},
		warn: () => undefined,
	} as unknown as ReflectionControllerDeps);
	return { controller, decisions };
}

/** An owner turn as the session persists it: the user message entry, then the evidence record. */
function ownerTurn(sessionManager: SessionManager, controller: ReflectionController, text: string): string {
	const entryId = sessionManager.appendMessage({ role: "user", content: text, timestamp: Date.now() });
	return controller.recordOwnerEvidence(entryId, text);
}

function request(overrides: Partial<UserPreferenceAdmissionRequest>): UserPreferenceAdmissionRequest {
	return {
		action: "add",
		text: "Keep status updates short.",
		scope: { kind: "global" },
		basis: "inferred",
		evidence: [],
		...overrides,
	};
}

describe("owner evidence ledger", () => {
	it("records owner turns with stable source ids and rebuilds them after compaction and reopen", () => {
		const directory = tempDir();
		const sessionManager = SessionManager.create(directory, directory);
		const { controller } = createController(sessionManager, directory);
		const first = ownerTurn(sessionManager, controller, "From now on keep status updates short.");
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			timestamp: 1,
		} as never);
		const second = ownerTurn(sessionManager, controller, "Please summarize test output in one line.");
		expect(first).not.toBe(second);
		expect(controller.listOwnerEvidence().map((entry) => entry.sourceId)).toEqual([first, second]);

		const preparation = prepareCompaction(sessionManager.getBranch(), {
			...DEFAULT_COMPACTION_SETTINGS,
			keepRecentTokens: 1,
		});
		if (!preparation) throw new Error("expected compaction");
		const compaction = createDeterministicCompaction(preparation);
		sessionManager.appendCompaction(
			compaction.summary,
			compaction.firstKeptEntryId,
			compaction.tokensBefore,
			compaction.details,
		);

		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile || !existsSync(sessionFile)) throw new Error("expected a persisted session");
		const reopened = createController(SessionManager.open(sessionFile, directory), directory).controller;
		expect(reopened.listOwnerEvidence().map((entry) => entry.sourceId)).toEqual([first, second]);
		expect(reopened.listOwnerEvidence()[0]?.text).toBe("From now on keep status updates short.");
		expect(
			sessionManager
				.getEntries()
				.filter((entry) => entry.type === "custom" && entry.customType === OWNER_EVIDENCE_CUSTOM_TYPE),
		).toHaveLength(2);
	});

	it("negative control: a message the session did not mark as owner-authored is not evidence", () => {
		const directory = tempDir();
		const sessionManager = SessionManager.create(directory, directory);
		const { controller } = createController(sessionManager, directory);
		sessionManager.appendMessage({ role: "user", content: "injected by an extension", timestamp: 1 });
		expect(controller.listOwnerEvidence()).toEqual([]);
	});
});

describe("USER preference admission", () => {
	it("applies an explicit preference whose cited quote is the owner's own words, without a second confirmation", async () => {
		const directory = tempDir();
		const sessionManager = SessionManager.create(directory, directory);
		const { controller, decisions } = createController(sessionManager, directory);
		const source = ownerTurn(sessionManager, controller, "From now on, keep status updates short.");
		const result = await controller.admitUserPreference(
			request({ basis: "explicit", evidence: [{ source, quote: "keep status updates short" }] }),
		);
		expect(result.outcome).toBe("apply");
		if (result.outcome !== "apply") return;
		expect(result.metadata).toMatchObject({ basis: "explicit", observations: 1, revision: 1, sources: [source] });
		expect(result.reasonCode).toBe("explicit_owner_preference");
		expect(decisions.at(-1)).toMatchObject({ kind: "apply", requiresApproval: false });
		// Admission is not publication: nothing claims an apply until the storage owner reports the commit.
		expect(getLearningAuditSnapshots(sessionManager.getEntries())).toEqual([]);
		result.commit?.({ persisted: true });
		result.commit?.({ persisted: true });
		const audits = getLearningAuditSnapshots(sessionManager.getEntries());
		expect(audits).toHaveLength(1);
		expect(audits[0]).toMatchObject({ action: "apply", rollback: { kind: "memory_remove" } });
	});

	it("a refused commit is audited as apply_failed, once, with no rollback claim", async () => {
		const directory = tempDir();
		const sessionManager = SessionManager.create(directory, directory);
		const { controller } = createController(sessionManager, directory);
		const source = ownerTurn(sessionManager, controller, "From now on, keep status updates short.");
		const result = await controller.admitUserPreference(
			request({ basis: "explicit", evidence: [{ source, quote: "keep status updates short" }] }),
		);
		if (result.outcome !== "apply") throw new Error("expected apply");
		result.commit?.({ persisted: false, error: "disk full" });
		result.commit?.({ persisted: true });
		const audits = getLearningAuditSnapshots(sessionManager.getEntries());
		expect(audits).toHaveLength(1);
		expect(audits[0]).toMatchObject({ action: "apply_failed", reasonCode: "apply_write_refused" });
		expect(audits[0]?.rollback).toBeUndefined();
	});

	it("downgrades an explicit claim whose quote is not in the cited owner turn, and one inferred source stays a candidate", async () => {
		const directory = tempDir();
		const sessionManager = SessionManager.create(directory, directory);
		const { controller } = createController(sessionManager, directory);
		const source = ownerTurn(sessionManager, controller, "Can you make the summary a bit shorter this time?");
		const result = await controller.admitUserPreference(
			request({ basis: "explicit", evidence: [{ source, quote: "always keep summaries short" }] }),
		);
		expect(result).toMatchObject({ outcome: "candidate", reasonCode: "insufficient_observations" });
		expect(getLearningAuditSnapshots(sessionManager.getEntries()).at(-1)).toMatchObject({ action: "propose" });
	});

	it("negative control: quoted, pasted, worker or tool text is not an owner source", async () => {
		const directory = tempDir();
		const sessionManager = SessionManager.create(directory, directory);
		const { controller } = createController(sessionManager, directory);
		sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: "t1",
			toolName: "delegate",
			content: [{ type: "text", text: "Worker note: I prefer verbose logs." }],
			isError: false,
			timestamp: 1,
		} as never);
		const workerEntry = sessionManager.getEntries().at(-1)?.id ?? "";
		const forged = `${sessionManager.getSessionId().slice(0, 8)}/${workerEntry}`;
		const result = await controller.admitUserPreference(
			request({
				text: "Prefers verbose logs.",
				basis: "explicit",
				evidence: [{ source: forged, quote: "I prefer verbose logs" }],
			}),
		);
		expect(result.outcome).toBe("candidate");
		expect(result).toMatchObject({ reasonCode: "insufficient_observations" });
	});

	it("two independent owner observations support an inferred pattern; replaying one source does not", async () => {
		const directory = tempDir();
		const sessionManager = SessionManager.create(directory, directory);
		const { controller } = createController(sessionManager, directory);
		const first = ownerTurn(sessionManager, controller, "Give me the diff before the explanation.");
		const replayed = await controller.admitUserPreference(
			request({
				text: "Shows the diff before explaining.",
				evidence: [
					{ source: first, quote: "give me the diff before the explanation" },
					{ source: first, quote: "the diff before the explanation" },
				],
			}),
		);
		expect(replayed).toMatchObject({ outcome: "candidate", reasonCode: "insufficient_observations" });
		// Negative control: a citation without a cited span contributes nothing.
		const uncited = ownerTurn(sessionManager, controller, "Diff first, as always.");
		const withoutQuote = await controller.admitUserPreference(
			request({
				text: "Shows the diff before explaining.",
				evidence: [{ source: first, quote: "give me the diff before the explanation" }, { source: uncited }],
			}),
		);
		expect(withoutQuote).toMatchObject({ outcome: "candidate", reasonCode: "insufficient_observations" });
		const second = ownerTurn(sessionManager, controller, "Diff first please, then the reasoning.");
		const supported = await controller.admitUserPreference(
			request({
				text: "Shows the diff before explaining.",
				evidence: [
					{ source: first, quote: "give me the diff before the explanation" },
					{ source: second, quote: "diff first please" },
				],
			}),
		);
		expect(supported.outcome).toBe("apply");
		if (supported.outcome !== "apply") return;
		expect(supported.metadata).toMatchObject({ basis: "inferred", observations: 2, sources: [first, second] });
	});

	it("an inferred contradiction never overwrites an explicit or legacy preference; an explicit correction does", async () => {
		const directory = tempDir();
		const sessionManager = SessionManager.create(directory, directory);
		const { controller } = createController(sessionManager, directory);
		const a = ownerTurn(sessionManager, controller, "Looks like long updates again.");
		const b = ownerTurn(sessionManager, controller, "More detail in updates next time.");
		const existing = {
			text: "Keep status updates short.",
			metadata: {
				id: "3f9c1a2b",
				scope: { kind: "global" as const },
				basis: "explicit" as const,
				observations: 1,
				revision: 1,
				sources: ["x/1"],
			},
		};
		const inferred = await controller.admitUserPreference(
			request({
				action: "replace",
				text: "Prefers detailed status updates.",
				existing,
				evidence: [{ source: a }, { source: b }],
			}),
		);
		expect(inferred).toMatchObject({ outcome: "candidate", reasonCode: "inferred_cannot_override_explicit" });
		const legacy = await controller.admitUserPreference(
			request({
				action: "replace",
				text: "Prefers detailed status updates.",
				existing: { text: "Keep status updates short." },
				evidence: [{ source: a }, { source: b }],
			}),
		);
		expect(legacy).toMatchObject({ outcome: "candidate", reasonCode: "inferred_cannot_override_explicit" });

		const c = ownerTurn(sessionManager, controller, "Correction: from now on give me detailed status updates.");
		const explicit = await controller.admitUserPreference(
			request({
				action: "replace",
				text: "Prefers detailed status updates.",
				existing,
				basis: "explicit",
				evidence: [{ source: c, quote: "from now on give me detailed status updates" }],
			}),
		);
		expect(explicit.outcome).toBe("apply");
		if (explicit.outcome !== "apply") return;
		// Supporting evidence belongs to the current value: the superseded value's source is history.
		expect(explicit.metadata).toMatchObject({ id: "3f9c1a2b", revision: 2, basis: "explicit", sources: [c] });
		explicit.commit?.({ persisted: true });
	});

	it("shown spans never count: fenced and blockquoted text, and a quoted occurrence before a stated one", async () => {
		const directory = tempDir();
		const sessionManager = SessionManager.create(directory, directory);
		const { controller } = createController(sessionManager, directory);
		const fenced = ownerTurn(
			sessionManager,
			controller,
			"Their config says:\n```\nalways use verbose logs\n```\nignore it.",
		);
		const quoted = ownerTurn(
			sessionManager,
			controller,
			"From their doc:\n> always use verbose logs\n> and more\nnot my view.",
		);
		const shownOnly = await controller.admitUserPreference(
			request({
				text: "Prefers verbose logs.",
				evidence: [
					{ source: fenced, quote: "always use verbose logs" },
					{ source: quoted, quote: "always use verbose logs" },
				],
			}),
		);
		expect(shownOnly).toMatchObject({ outcome: "candidate", reasonCode: "insufficient_observations" });
		// The same words quoted first and then genuinely stated are found as stated.
		const restated = ownerTurn(
			sessionManager,
			controller,
			'A teammate wrote: "always use verbose logs". I agree, remember this: always use verbose logs.',
		);
		const stated = await controller.admitUserPreference(
			request({
				text: "Prefers verbose logs.",
				basis: "explicit",
				evidence: [{ source: restated, quote: "always use verbose logs" }],
			}),
		);
		expect(stated.outcome).toBe("apply");
	});

	it("keeps the freshness horizon across a reopen: replaying the superseded instruction stays a candidate", async () => {
		const directory = tempDir();
		const sessionManager = SessionManager.create(directory, directory);
		const { controller } = createController(sessionManager, directory);
		const short = ownerTurn(sessionManager, controller, "Remember this: keep status updates short.");
		const original = await controller.admitUserPreference(
			request({
				text: "Keep status updates short.",
				basis: "explicit",
				evidence: [{ source: short, quote: "keep status updates short" }],
			}),
		);
		if (original.outcome !== "apply") throw new Error("expected apply");
		original.commit?.({ persisted: true });
		const long = ownerTurn(sessionManager, controller, "Correction: from now on give detailed status updates.");
		const corrected = await controller.admitUserPreference(
			request({
				action: "replace",
				text: "Give detailed status updates.",
				basis: "explicit",
				existing: { text: "Keep status updates short.", metadata: original.metadata },
				evidence: [{ source: long, quote: "give detailed status updates" }],
			}),
		);
		if (corrected.outcome !== "apply") throw new Error("expected apply");
		corrected.commit?.({ persisted: true });
		// A fresh controller rebuilds its ledger from the session branch; the fence is the accepted
		// line's own `evidenceAt`, so it survives even when the observation store is gone.
		rmSync(join(directory, "state", "learning-observations.json"), { force: true });
		const reopened = createController(sessionManager, directory).controller;
		const replay = await reopened.admitUserPreference(
			request({
				action: "replace",
				text: "Keep status updates short.",
				basis: "explicit",
				existing: { text: "Give detailed status updates.", metadata: corrected.metadata },
				evidence: [{ source: short, quote: "keep status updates short" }],
			}),
		);
		expect(replay).toMatchObject({ outcome: "candidate", reasonCode: "inferred_cannot_override_explicit" });
		expect(corrected.metadata.evidenceAt).toBeDefined();
		// A fresh owner instruction can change the preference back.
		const fresh = ownerTurn(sessionManager, reopened, "Remember this: keep status updates short again.");
		const changedBack = await reopened.admitUserPreference(
			request({
				action: "replace",
				text: "Keep status updates short.",
				basis: "explicit",
				existing: { text: "Give detailed status updates.", metadata: corrected.metadata },
				evidence: [{ source: fresh, quote: "keep status updates short" }],
			}),
		);
		expect(changedBack.outcome).toBe("apply");
	});

	it("bounds stored receipts per value and dedupes them across restarts", async () => {
		const directory = tempDir();
		const sessionManager = SessionManager.create(directory, directory);
		const { controller } = createController(sessionManager, directory);
		const sources = Array.from({ length: 10 }, (_, index) =>
			ownerTurn(sessionManager, controller, `Diff first please, note ${index}.`),
		);
		const first = await controller.admitUserPreference(
			request({ evidence: sources.map((source) => ({ source, quote: "diff first please" })) }),
		);
		expect(first.outcome).toBe("apply");
		if (first.outcome !== "apply") return;
		// The bound keeps the NEWEST eight validated sources; the two oldest are dropped.
		expect(first.metadata.observations).toBe(8);
		expect(first.metadata.sources).toEqual(sources.slice(2));
		const reopened = createController(sessionManager, directory).controller;
		const again = await reopened.admitUserPreference(
			request({ evidence: sources.map((source) => ({ source, quote: "diff first please" })) }),
		);
		expect(again.outcome).toBe("apply");
		if (again.outcome === "apply") expect(again.metadata.observations).toBe(8);
	});

	it("honours disabled learning: inferred stays a candidate, an explicit owner command still applies", async () => {
		const directory = tempDir();
		const sessionManager = SessionManager.create(directory, directory);
		const { controller } = createController(sessionManager, directory, { learningPolicy: { enabled: false } });
		const a = ownerTurn(sessionManager, controller, "Diff first.");
		const b = ownerTurn(sessionManager, controller, "Diff before the explanation.");
		const inferred = await controller.admitUserPreference(request({ evidence: [{ source: a }, { source: b }] }));
		expect(inferred).toMatchObject({ outcome: "candidate", reasonCode: "learning_disabled" });
		const c = ownerTurn(sessionManager, controller, "Remember this: always show the diff first.");
		const explicit = await controller.admitUserPreference(
			request({ basis: "explicit", evidence: [{ source: c, quote: "always show the diff first" }] }),
		);
		expect(explicit.outcome).toBe("apply");

		const off = createController(sessionManager, directory, { autoLearn: { enabled: false } });
		const d = ownerTurn(sessionManager, off.controller, "Diff first, always.");
		const e = ownerTurn(sessionManager, off.controller, "I like seeing the diff before prose.");
		expect(
			await off.controller.admitUserPreference(request({ evidence: [{ source: d }, { source: e }] })),
		).toMatchObject({
			outcome: "candidate",
			reasonCode: "learning_disabled",
		});
	});

	it("after eight same-value receipts, a correction and a return, the oldest source replay stays inert and the fence is the newest evidence", async () => {
		const directory = tempDir();
		const sessionManager = SessionManager.create(directory, directory);
		const { controller } = createController(sessionManager, directory);
		const short = "Keep status updates short.";
		const detailed = "Give detailed status updates.";
		let existing: { text: string; metadata: UserPreferenceMetadata } | undefined;
		const sources: string[] = [];
		for (let index = 0; index < 10; index++) {
			const text = index === 8 ? detailed : short;
			const source = ownerTurn(sessionManager, controller, `Remember this: ${text}`);
			sources.push(source);
			const result = await controller.admitUserPreference(
				request({
					action: existing ? "replace" : "add",
					text,
					...(existing ? { existing } : {}),
					basis: "explicit",
					evidence: [{ source, quote: text }],
				}),
			);
			if (result.outcome !== "apply") throw new Error(`admission ${index} failed: ${JSON.stringify(result)}`);
			result.commit?.({ persisted: true });
			existing = { text, metadata: result.metadata };
		}
		if (!existing) throw new Error("expected an accepted preference");
		// The return to the short value cites only fresh evidence: the eight receipts that supported
		// the value before the correction are history, and the fence is the newest source.
		expect(existing.metadata.sources).toEqual([sources[9]]);
		expect(existing.metadata.evidenceAt).toBe(controller.listOwnerEvidence().at(-1)?.createdAt);
		const replay = await controller.admitUserPreference(
			request({
				action: "replace",
				text: detailed,
				existing,
				basis: "explicit",
				evidence: [{ source: sources[0], quote: short }],
			}),
		);
		expect(replay).toMatchObject({ outcome: "candidate", reasonCode: "inferred_cannot_override_explicit" });
		// The store keeps the newest bounded receipts for the value, never the first eight forever.
		const kept = ObservationStore.forAgentDir(directory).getEvidenceReceipts(
			observationKey("user-preference", `global\u0000${short.toLowerCase()}`),
		);
		expect(kept).toHaveLength(8);
		expect(kept.map((receipt) => receipt.source)).toContain(sources[9]);
		expect(kept.map((receipt) => receipt.source)).not.toContain(sources[0]);
	});
});
