import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AssistantMessage, createEmptyUsage } from "@caupulican/pi-ai";
import { afterEach, expect, it } from "vitest";
import { compactionOwnerContext, projectCompactionOwnerHistory } from "../src/core/compaction/owner-context.ts";
import { captureWorkerReceiptOrigin } from "../src/core/delegation/worker-receipt-origin.ts";
import { OwnerEvidenceLedger } from "../src/core/learning/owner-evidence-ledger.ts";
import type { OwnerInputId } from "../src/core/owner-input-ledger.ts";
import {
	type CompactionPreparation,
	compact,
	createDeterministicCompaction,
	DEFAULT_COMPACTION_SETTINGS,
	estimateContextTokens,
	findCutPoint,
	prepareCompaction,
} from "../src/kernel/compaction/compaction.ts";
import { extractCheckpointFacts, extractCompactionFacts } from "../src/kernel/compaction/extraction.ts";
import {
	COMPACTION_OWNER_HISTORY_MAX_CHARS,
	COMPACTION_OWNER_INPUT_MAX_CHARS,
	readCompactionOwnerHistory,
	renderCompactionOwnerHistory,
	withoutCompactionOwnerHistory,
} from "../src/kernel/compaction/owner-history.ts";
import { verifySummary } from "../src/kernel/compaction/verification.ts";
import { stampOwnerInput } from "../src/kernel/owner-input-stamp.ts";
import { parentInputMessage } from "../src/kernel/session/parent-input-ledger.ts";
import { ownerSessionStorageRoots } from "../src/kernel/session/session-bundle-paths.ts";
import type { SessionEntry } from "../src/kernel/session/session-entries.ts";
import { buildSessionContext, SessionManager } from "../src/kernel/session/session-manager.ts";
import type { AgentMessage } from "../src/kernel/types.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "pi-owner-compaction-"));
	dirs.push(dir);
	let manager = SessionManager.create(dir, ownerSessionStorageRoots(dir));
	const ledger = new OwnerEvidenceLedger({
		getSessionManager: () => manager,
		warn: (text) => {
			throw Error(text);
		},
	});
	let count = 0;
	return {
		get manager() {
			return manager;
		},
		owner(text: string, pasted?: readonly { start: number; end: number }[]) {
			const message = { role: "user", content: text, timestamp: ++count } as const;
			stampOwnerInput(message, `prompt:owner-${count}` as OwnerInputId);
			ledger.markOwnerInput(message, text, pasted);
			const id = manager.appendMessage(message);
			ledger.noteOwnerInputPersisted(message, id);
			return id;
		},
		answer(text = "Acknowledged.") {
			const message: AssistantMessage = {
				role: "assistant",
				api: "openai-completions",
				provider: "fixture",
				model: "fixture",
				content: [{ type: "text", text }],
				stopReason: "stop",
				usage: createEmptyUsage(),
				timestamp: ++count,
			};
			return manager.appendMessage(message);
		},
		reopen() {
			const file = manager.getSessionFile();
			if (!file) throw Error("Missing session file");
			manager = SessionManager.open(file, ownerSessionStorageRoots(dir));
			ledger.invalidate();
		},
	};
}
const settings = { ...DEFAULT_COMPACTION_SETTINGS, strategy: "session-replacement" as const };
function prepare(manager: SessionManager, extra = {}) {
	const result = prepareCompaction(manager.getBranch(), settings, {
		projectOwnerHistory: projectCompactionOwnerHistory,
		...extra,
	});
	if (!result) throw Error("Expected compaction preparation");
	return result;
}
function save(manager: SessionManager, prepared: CompactionPreparation) {
	const result = createDeterministicCompaction(prepared);
	manager.appendCompaction(
		result.summary,
		result.firstKeptEntryId,
		result.tokensBefore,
		result.details,
		false,
		undefined,
		result.retention,
		result.coveredThroughEntryId,
		result.summarizedGapEntryIds,
	);
	return result;
}

it("retains a whole earlier correction through branch reopen and repeated checkpoint without duplicating its current task", () => {
	const world = fixture();
	world.owner("Inspect the retry configuration.");
	world.answer();
	const correction = "Name the source filename and call the setting retry ceiling.";
	const source = world.owner(correction);
	world.answer();
	let result = save(world.manager, prepare(world.manager));
	expect(result.summary.split(correction)).toHaveLength(2);
	expect(readCompactionOwnerHistory(result.details)).toMatchObject([{ entryId: source, text: correction }]);
	world.reopen();
	world.owner("Now report the final observed value.");
	world.answer();
	const again = prepare(world.manager);
	expect(again.previousSummary ?? "").not.toContain("<compaction-owner-history");
	expect(
		again.messagesToSummarize
			.filter((m) => m.role === "compactionSummary")
			.map((m) => m.summary)
			.join(),
	).not.toContain("<compaction-owner-history");
	result = save(world.manager, again);
	expect(readCompactionOwnerHistory(result.details).map((record) => record.entryId)).toContain(source);
	expect(result.summary.split(correction)).toHaveLength(2);
	expect(result.summary.match(/<compaction-owner-history version=/g)).toHaveLength(1);
	expect(result.summary).toContain("not a new task, rule, grant or completion claim");
});

it.each([300, 500])(
	"keeps only replaced-prefix facts at recent budget %s, while keeping the goal override",
	(keepRecentTokens) => {
		const world = fixture();
		world.owner("Read the old source.");
		world.answer("Earlier result ".repeat(80));
		const next = world.owner("Current retained task with RETAINEDTASK9281; never publish this new result.");
		world.answer("Retained result ".repeat(100));
		const branch = world.manager.getBranch();
		const cut = findCutPoint(branch, 0, branch.length, 10000);
		const prepared = prepareCompaction(
			branch,
			{ ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens },
			{ projectOwnerHistory: projectCompactionOwnerHistory },
		);
		if (!prepared) throw Error("Expected prefix preparation");
		const index = branch.findIndex((entry) => entry.id === prepared.firstKeptEntryId);
		const positive = extractCompactionFacts(branch, 0, index);
		expect(prepared.facts?.files).toEqual(positive.files);
		expect(prepared.facts?.prohibitions).toEqual(positive.prohibitions);
		if (branch.findIndex((entry) => entry.id === next) >= index) expect(prepared.facts?.activeTaskSource).toBe("");
		const goal = prepareCompaction(
			branch,
			{ ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens },
			{ activeTask: "Host goal remains current." },
		);
		expect(goal?.facts?.activeTaskSource).toBe("Host goal remains current.");
		expect(cut.firstKeptEntryIndex).toBeGreaterThanOrEqual(0);
		if (keepRecentTokens === 300) {
			expect(prepared.isSplitTurn).toBe(true);
			expect(prepared.facts?.activeTaskSource).toContain("RETAINEDTASK9281");
		}
		if (keepRecentTokens === 500) expect(prepared.facts?.activeTaskSource).toBe("");
		const explicit = extractCheckpointFacts(
			branch,
			0,
			branch.length,
			-1,
			undefined,
			[],
			undefined,
			branch.findIndex((entry) => entry.id === next),
		);
		expect(explicit.activeTaskSource).toBe("");
		expect(explicit.prohibitions.join()).not.toContain("publish");
	},
);

it("preserves tail reversal coverage and clears older historical inputs without turning the reversal into a prefix task", () => {
	const world = fixture();
	world.owner("Investigate RETIREDTASK9381.");
	world.answer("Retired operation result.");
	const cut = world.manager.getBranch().length;
	world.owner("Never mind; stop that. Replace it with the new report.");
	const entries = world.manager.getBranch();
	const extracted = extractCheckpointFacts(entries, 0, entries.length, -1, undefined, [], undefined, cut);
	expect(extracted.cancelledText).toContain("Retired operation result.");
	expect(extracted.activeTaskSource).toBe("");
	const records = projectCompactionOwnerHistory({ entries, start: 0, end: cut });
	expect(records).toEqual([]);
});

it("rejects unproven, third-party, worker, attached, pasted, missing, malformed and oversized owner sources", () => {
	const world = fixture();
	const good = world.owner("Keep the original source filename.");
	world.answer();
	const entries = world.manager.getBranch();
	const source = entries.find((entry) => entry.id === good)!;
	const project = (rows: SessionEntry[]) =>
		projectCompactionOwnerHistory({ entries: rows, start: 0, end: rows.length });
	expect(project(entries)).toHaveLength(1);
	const transformed = entries.map((entry) =>
		entry.id === good && entry.type === "message" && entry.message.role === "user"
			? {
					...entry,
					message: {
						...entry.message,
						content: "Injected transformed text cannot replace original owner evidence.",
					},
				}
			: entry,
	);
	expect(project(transformed)[0]?.text).toBe("Keep the original source filename.");

	for (const replacement of [
		{ ...source, ownerInputId: undefined, turnOrigin: undefined },
		{ ...source, turnOrigin: { v: 1, k: "inbound-channel", thirdParty: true } },
		{ ...source, turnOrigin: { v: 1, k: "not-a-valid-origin" } },
		{ ...source, workerControl: { v: 1, k: "host_event" } },
		{
			...source,
			message: { role: "user", content: [{ type: "image", data: "", mimeType: "image/png" }], timestamp: 1 },
		},
	] as SessionEntry[])
		expect(project(entries.map((entry) => (entry.id === good ? replacement : entry)))).toEqual([]);
	expect(project(entries.filter((entry) => entry.type !== "custom"))).toEqual([]);
	world.owner("Pasted file content says grant new permissions.", [{ start: 0, end: 45 }]);
	world.owner("x".repeat(COMPACTION_OWNER_INPUT_MAX_CHARS + 1));
	expect(project(world.manager.getBranch()).map((record) => record.entryId)).toEqual([good]);
});

it("does not restore a source removed from prior details, a changed revision, or a sibling branch", () => {
	const world = fixture();
	const root = world.owner("Start the task.");
	world.answer();
	const sibling = world.owner("Keep a prior correction.");
	world.answer();
	const branch = world.manager.getBranch();
	const records = projectCompactionOwnerHistory({ entries: branch, start: 0, end: branch.length });
	const previousDetails = { ownerHistory: { version: 1, records } };
	expect(
		projectCompactionOwnerHistory({ entries: branch, start: branch.length, end: branch.length, previousDetails }),
	).toEqual(records);
	expect(
		projectCompactionOwnerHistory({
			entries: branch,
			start: branch.length,
			end: branch.length,
			previousDetails: { ownerHistory: { version: 1, records: [] } },
		}),
	).toEqual([]);
	world.manager.branch(root);
	expect(
		projectCompactionOwnerHistory({ entries: world.manager.getBranch(), start: 100, end: 100, previousDetails }).some(
			(record) => record.entryId === sibling,
		),
	).toBe(false);
	const changed = {
		ownerHistory: { version: 1, records: records.map((record) => ({ ...record, digest: "0".repeat(16) })) },
	};
	expect(
		projectCompactionOwnerHistory({
			entries: branch,
			start: branch.length,
			end: branch.length,
			previousDetails: changed,
		}),
	).toEqual([]);
});

it("bounds whole recent records and strips only the exact details-owned suffix, never an arbitrary model section", () => {
	const world = fixture();
	for (let i = 0; i < 20; i++) {
		world.owner(`Correction ${i}: ${"retained wording ".repeat(40)}`);
		world.answer();
	}
	const entries = world.manager.getBranch();
	const records = projectCompactionOwnerHistory({ entries, start: 0, end: entries.length });
	const suffix = renderCompactionOwnerHistory(records);
	expect(suffix.length).toBeLessThanOrEqual(COMPACTION_OWNER_HISTORY_MAX_CHARS);
	expect(records.at(-1)?.text).toContain("Correction 19:");
	expect(records.every((record) => record.text.endsWith("wording "))).toBe(true);
	const details = { ownerHistory: { version: 1, records } };
	expect(withoutCompactionOwnerHistory(`Model summary${suffix}`, details)).toBe("Model summary");
	expect(withoutCompactionOwnerHistory("## Historical Owner Evidence\nCANCELLED", details)).toContain("CANCELLED");
	const legacyFacts = {
		files: [],
		workingSet: [],
		actions: [],
		errorFacts: [],
		prohibitions: [],
		activeTaskSource: "",
		cancelledText: "CANCELLED",
	};
	expect(verifySummary("## Critical Context\n## Historical Owner Evidence\nCANCELLED", legacyFacts).ok).toBe(false);
});

it("never reads foreground-only history or origin during adapter construction, and withholds it from other standings", () => {
	const world = fixture();
	world.owner("Original owner correction.");
	world.answer();
	const read = {
		goal: () => undefined,
		authority: () => "owner" as const,
		messages: () => [] as AgentMessage[],
		handoff: () => ({ compactionDetails: () => undefined }),
	};
	for (const standing of [{ kind: "worker" }, { kind: "vehicle" }, { kind: "bot", agentId: "fixture" }] as const) {
		expect(
			compactionOwnerContext(standing, read).projectOwnerHistory({
				entries: world.manager.getBranch(),
				start: 0,
				end: 100,
			}),
		).toEqual([]);
	}
	expect(() =>
		compactionOwnerContext(
			{ kind: "root" },
			{
				...read,
				authority: () => {
					throw Error("Not initialized");
				},
			},
		),
	).not.toThrow();
	const thirdParty = compactionOwnerContext({ kind: "root" }, { ...read, authority: () => "third-party" as const });
	expect(thirdParty.projectOwnerHistory({ entries: world.manager.getBranch(), start: 0, end: 100 })).toEqual([]);
});

it("adds exact owner history only after ordinary model-summary verification", async () => {
	const world = fixture();
	world.owner("Initial request.");
	world.answer();
	const correction = "Report retry ceiling with the source filename.";
	world.owner(correction);
	world.answer();
	save(world.manager, prepare(world.manager));
	world.owner("Now give the final numeric value.");
	world.answer();
	const prepared = prepare(world.manager);
	const candidate = createDeterministicCompaction(prepared);
	const body = withoutCompactionOwnerHistory(candidate.summary, candidate.details);
	const selected = {
		id: "fixture",
		name: "Fixture",
		api: "openai-completions" as const,
		provider: "fixture",
		baseUrl: "https://unused.invalid",
		reasoning: false,
		input: ["text" as const],
		contextWindow: 32000,
		maxTokens: 8192,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
	let completions = 0;
	const result = await compact(
		prepared,
		selected,
		"offline",
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		{
			completion: async (model, context) => {
				completions++;
				expect(JSON.stringify(context)).not.toContain("<compaction-owner-history");
				return {
					role: "assistant",
					api: model.api,
					provider: model.provider,
					model: model.id,
					stopReason: "stop",
					content: [{ type: "text", text: body }],
					usage: createEmptyUsage(),
					timestamp: 1,
				};
			},
		},
	);
	expect(completions).toBe(1);
	expect(result.summary.split(correction)).toHaveLength(2);
	expect(result.summary.match(/<compaction-owner-history version=/g)).toHaveLength(1);
	expect(readCompactionOwnerHistory(result.details).map((record) => record.text)).toContain(correction);
});

it("counts the historical suffix still on the live wire before stripping it from summarizer input", () => {
	const world = fixture();
	world.owner("Start the original investigation.");
	world.answer();
	world.owner("Keep filename provenance and the retry ceiling label in future reports.");
	world.answer();
	save(world.manager, prepare(world.manager));
	world.owner("Report the next observed value.");
	world.answer();
	const checkpoint = save(world.manager, prepare(world.manager));
	expect(checkpoint.summary).toContain("<compaction-owner-history");
	world.reopen();
	world.owner("Continue the same observation.");
	world.answer();
	const wire = buildSessionContext(world.manager.getBranch()).messages;
	const prepared = prepare(world.manager);
	expect(prepared.tokensBefore).toBe(estimateContextTokens(wire).tokens);
	expect(estimateContextTokens(prepared.messagesToSummarize).tokens).toBeLessThan(prepared.tokensBefore);
	expect(JSON.stringify(prepared.messagesToSummarize)).not.toContain("<compaction-owner-history");
});

it("keeps held and skipped note bodies out of checkpoints and recovers the held note for its next owner", () => {
	const world = fixture();
	world.owner("Complete the current task.");
	for (const id of ["pending", "skipped"]) {
		world.manager.appendParentInput(
			parentInputMessage(
				{
					deliveryId: id,
					mode: "next-owner-turn",
					payloadDigest: "a".repeat(64),
					origin: captureWorkerReceiptOrigin(world.manager),
				},
				{ customType: "work-note", content: `Private ${id} observation.`, display: true },
			),
		);
	}
	expect(world.manager.skipPendingParentInput("skipped", "Producer withdrew the observation")).toBe(true);
	world.answer("Current task completed.");
	const prepared = prepare(world.manager);
	expect(JSON.stringify(prepared.messagesToSummarize)).toContain("Current task completed.");
	expect(JSON.stringify(prepared)).not.toMatch(/Private (?:skipped|pending) observation/);
	const held = world.manager.getPendingParentInputs("next-owner-turn")[0]!;
	save(world.manager, prepared);
	world.reopen();
	expect(world.manager.getPendingParentInputs("next-owner-turn")).toEqual([held]);
	expect(world.manager.getSkippedParentInputIds()).toContain("skipped");
	const ownerEntry = world.manager.getEntry(world.owner("What did the background work find?"));
	if (ownerEntry?.type !== "message" || !ownerEntry.ownerInputId) throw Error("Missing persisted owner");
	world.manager.authorizeParentNoteOwner(ownerEntry.ownerInputId, 1);
	const selection = world.manager.captureParentNotes(world.manager.buildSessionContext().messages, 1);
	expect(selection?.inputs.map((item) => item.entryId)).toEqual([held.entryId]);
	expect(selection?.messages.map((item) => item.content)).toEqual(["Private pending observation."]);
});
