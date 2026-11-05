import { expect } from "vitest";
import { resolveSemanticUsageEntry } from "../../../../src/core/cost/usage-records.ts";
import type { ExtensionUIContext } from "../../../../src/core/extensions/types.ts";
import {
	getOwnerEvidenceSnapshots,
	OWNER_EVIDENCE_CUSTOM_TYPE,
} from "../../../../src/core/learning/owner-evidence-ledger.ts";
import type { KnowledgeChange } from "../../../../src/core/memory/knowledge-admission.ts";
import { knowledgeId } from "../../../../src/core/memory/knowledge-record.ts";
import { KnowledgeStore } from "../../../../src/core/memory/knowledge-store.ts";
import { handleKnowledgeCommand } from "../../../../src/modes/interactive/knowledge-commands.ts";
import { HARNESS_PROVIDER, type ScriptStep } from "../scripted-provider.ts";
import { type HarnessWorld, withDeadline } from "../session-fixture.ts";
import {
	ICM_INTAKE_JUDGMENTS,
	icmContinuousSettings,
	icmLatestResult,
	icmWaitForChatIdle,
	knowledgeJudgment,
} from "./shared.ts";

const GROUNDED = {
	grounded: { kind: "noul", probability: 0.98 },
	basis: { kind: "choice", choice: "explicit", confidence: 0.98 },
	requested: { kind: "noul", probability: 0.98 },
} as const;
const SAME_SLOT = { same_0: { kind: "noul", probability: 0.98 } } as const;
/** The session model's own answers when System One is off: the same meaning, reported without calibration. */
const JUDGED_REQUESTED = [
	{ id: "grounded", value: true, confidence: 0.98 },
	{ id: "basis", selected: "explicit", confidence: 0.98 },
	{ id: "requested", value: true, confidence: 0.98 },
] as const;
const JUDGED_SAME_SLOT = [{ id: "same_0", value: true, confidence: 0.98 }] as const;

/**
 * Existing journey 1: real tool admission, correction, forgetting, and both directions of stale replay. With
 * System One off the session model judges the same changes; its self-reported match never rewrites a live fact
 * without the fact's exact id and revision.
 */
export async function runJourney1KnowledgePhase(world: HarnessWorld): Promise<void> {
	const agentDir = `${world.agentDir}-knowledge`;
	const root = await world.createRootSession("root", {
		agentDir,
		sessionManager: world.createSessionManager(agentDir),
		settings: icmContinuousSettings("worker-c", { autoLearn: { enabled: false }, proactivity: { enabled: false } }),
	});
	const store = KnowledgeStore.open(agentDir);
	// Six turns (seven with System One off) publish four records each, and the owner-command projection turn two. Every
	// possible leaf and aligned parent gets at most one reply: short nodes need no call, but concurrent compactions may
	// consume these exact targets in any order.
	const records = (world.systemOne.enabled ? 24 : 28) + 2;
	const compactionTracks: string[] = [];
	for (let size = 1; size <= records; size *= 2) {
		for (let first = 0; first + size <= records; first += size) {
			const task =
				size === 1
					? `Compaction: compress message ${first} into`
					: `Compaction: merge lines ${first}+${size / 2} and ${first + size / 2}+${size / 2},`;
			const track = `knowledge-compaction-${first}+${size}`;
			compactionTracks.push(track);
			world.provider.enqueueTrack(
				track,
				"worker-c",
				(request) => JSON.stringify(request.context.messages.at(-1)).includes(task),
				{
					name: track,
					optional: true,
					reply: {
						content: [
							{ type: "text", text: "Knowledge requests and their results; zoom for the original evidence." },
						],
					},
				},
			);
		}
	}
	let completedTurns = 0;
	const id = knowledgeId({
		kind: "behavior",
		scope: { project: "", role: "", audience: "owner" },
		subject: "owner",
		key: "indentation",
	});
	const source = () => {
		const record = getOwnerEvidenceSnapshots(
			root.sessionManager.getCustomEntriesOnBranch([OWNER_EVIDENCE_CUSTOM_TYPE]),
		).at(-1);
		if (!record) throw new Error("The real owner input did not produce original evidence");
		return record.sourceId;
	};
	const remember = (text: string, quote: string, cited = source(), key = "indentation"): KnowledgeChange => ({
		action: "remember",
		kind: "behavior",
		scope: "global",
		subject: "owner",
		key,
		text,
		evidence: [{ source: cited, quote }],
	});
	const turn = async (
		label: string,
		prompt: string,
		change: () => KnowledgeChange,
		expected: string,
		matching = false,
	) => {
		world.systemOne.enterPhase(label, {
			...ICM_INTAKE_JUDGMENTS,
			...(world.systemOne.enabled ? { ...GROUNDED, ...(matching ? SAME_SLOT : {}) } : {}),
		});
		let proposed: KnowledgeChange | undefined;
		const quote = () => proposed!.evidence[0]!.quote;
		// The tool's judgments run between its call and the turn's next request, on the same session-model track.
		const judgments: ScriptStep[] = world.systemOne.enabled
			? []
			: [
					knowledgeJudgment(`${label}-admission`, "knowledge.admission", JUDGED_REQUESTED, quote),
					...(matching
						? [knowledgeJudgment(`${label}-identity`, "knowledge.identity", JUDGED_SAME_SLOT, quote)]
						: []),
				];
		world.provider.enqueue(
			"root",
			{
				name: `${label}-call`,
				reply: () => {
					proposed = change();
					return {
						content: [
							{
								type: "toolCall",
								id: label,
								name: "knowledge",
								arguments: { action: "change", change: proposed },
							},
						],
						stopReason: "toolUse",
					};
				},
			},
			...judgments,
			{
				name: `${label}-done`,
				check: (request) =>
					expect(
						icmLatestResult(request, "knowledge").text,
						"the actual tool reports its admission result",
					).toContain(expected),
				reply: { content: [{ type: "text", text: "Recorded the outcome." }] },
			},
		);
		await withDeadline(world.trace, label, root.session.prompt(prompt));
		completedTurns++;
		await icmWaitForChatIdle(world, agentDir, completedTurns * 4, (records) => records.length === completedTurns * 4);
	};
	try {
		let firstSource = "";
		await turn(
			"knowledge-add",
			"Remember I use tabs.",
			() => {
				firstSource = source();
				return remember("Uses tabs.", "I use tabs");
			},
			'"status":"applied"',
		);
		expect(store.get(id), "explicit owner instructions work even with automatic learning disabled").toMatchObject({
			text: "Uses tabs.",
			revision: 1,
		});
		await turn(
			"knowledge-correct",
			"Actually, remember I use spaces.",
			() => remember("Uses spaces.", "I use spaces", source(), "whitespace"),
			world.systemOne.enabled ? '"status":"applied"' : "exact id and revision",
			true,
		);
		if (!world.systemOne.enabled) {
			expect(store.get(id), "a self-reported match never rewrites a live fact by itself").toMatchObject({
				text: "Uses tabs.",
				revision: 1,
			});
			await turn(
				"knowledge-correct-keyed",
				"Correct that stored preference by its id: I use spaces.",
				() => ({ ...remember("Uses spaces.", "I use spaces"), id, expectedRevision: 1 }),
				'"status":"applied"',
			);
		}
		expect(store.get(id), "different wording corrects the existing semantic slot").toMatchObject({
			text: "Uses spaces.",
			revision: 2,
		});
		expect(
			store.list({ project: "", role: "", audience: "owner" }),
			"correction does not create a second fact",
		).toHaveLength(1);
		let forgetSource = "";
		await turn(
			"knowledge-forget",
			"Forget my indentation preference.",
			() => {
				forgetSource = source();
				return {
					action: "forget",
					id,
					expectedRevision: 2,
					evidence: [{ source: forgetSource, quote: "Forget my indentation preference" }],
				};
			},
			'"status":"applied"',
		);
		expect(store.get(id), "forget removes the accepted value").toBeUndefined();
		expect(store.history(id), "forget removes value history too").toEqual([]);
		await turn(
			"knowledge-replay",
			"Inspect that old request.",
			() => remember("Uses tabs.", "I use tabs", firstSource, "formatting"),
			"not newer",
			true,
		);
		expect(store.get(id), "alternate wording cannot replay forgotten evidence").toBeUndefined();
		await turn(
			"knowledge-relearn",
			"Remember I use tabs again.",
			() => remember("Uses tabs again.", "I use tabs again", source(), "formatting"),
			'"status":"applied"',
			true,
		);
		expect(store.get(id), "a fresh explicit request can relearn the same slot").toMatchObject({
			revision: 4,
			text: "Uses tabs again.",
		});
		await turn(
			"knowledge-old-forget",
			"Inspect the earlier forgetting request.",
			() => ({
				action: "forget",
				id,
				expectedRevision: 4,
				evidence: [{ source: forgetSource, quote: "Forget my indentation preference" }],
			}),
			"older than the current knowledge",
		);
		expect(store.get(id), "an old forgetting request cannot delete a fresh fact").toMatchObject({
			revision: 4,
			text: "Uses tabs again.",
		});
		if (!world.systemOne.enabled) {
			expect(
				root.session.memoryOperator.getKnowledgeCollectionStatus(),
				"the session model judges explicit changes while automatic collection stays off",
			).toMatchObject({
				state: "inactive",
				reason: "disabled",
				engine: { id: "structured-llm", model: `${HARNESS_PROVIDER}/root`, provenance: "synthetic_self_report" },
			});
			const judged = root.sessionManager.getEntries().flatMap((entry) => {
				const report = resolveSemanticUsageEntry(entry)?.report;
				return report?.route === "knowledge_collection" ? [report.origin?.operationId] : [];
			});
			expect(judged, "every session-model judgment keeps its own explicit-change receipt").toHaveLength(10);
			for (const operationId of judged) expect(operationId).toMatch(/^knowledge-collection:explicit:/);
		} else {
			root.settingsManager.setProactivitySettings({
				...root.settingsManager.getProactivitySettings(),
				enabled: true,
				minOwnerTurnsBetweenRuns: 1,
			});
			world.provider.enqueue("root", {
				name: "knowledge-proactive-review",
				check: (request) => {
					const context = JSON.stringify(request.context.messages);
					expect(context, "continuous-chat review reads current accepted owner knowledge").toContain(
						"Uses tabs again.",
					);
					expect(context, "superseded values are not current knowledge").not.toContain("Uses spaces.");
					expect(context).toContain("Current accepted knowledge, revision");
				},
				reply: { content: [{ type: "text", text: "none" }] },
			});
			expect(
				await withDeadline(
					world.trace,
					"continuous-chat proactive review",
					root.session.backgroundLanes.runProactiveReviewOnce(),
				),
			).toMatchObject({ started: true, delivered: [] });
			// The owner-command turn below is the next owner turn; no idle review may answer it.
			root.settingsManager.setProactivitySettings({
				...root.settingsManager.getProactivitySettings(),
				enabled: false,
			});
		}
		await runOwnerKnowledgeCommands(world, root, store, id, records, agentDir);
		world.trace.mark("root", "knowledge.admission-replay");
	} finally {
		store.close();
		expect(await world.disposeSessionInBody(root.session), "the knowledge owner closes cleanly").toBeUndefined();
		await world.provider.waitForProducers();
		for (const track of compactionTracks) world.provider.retireOptional(track);
	}
}

/**
 * The owner's `/knowledge` command on the same fact, through the session's real operator port: view, provenance and
 * history, then a correction and a forget that need the owner's confirmation and no model, judge or spend. The next
 * request's knowledge view is the committed revision, and the command itself never enters the conversation.
 */
async function runOwnerKnowledgeCommands(
	world: HarnessWorld,
	root: Awaited<ReturnType<HarnessWorld["createRootSession"]>>,
	store: KnowledgeStore,
	id: string,
	records: number,
	agentDir: string,
): Promise<void> {
	world.systemOne.enterPhase("knowledge-commands", {});
	const run = async (text: string) => {
		const shown: string[] = [];
		const failed: string[] = [];
		await handleKnowledgeCommand(
			{
				session: root.session,
				showStatus: (message) => shown.push(message),
				showText: (message) => shown.push(message),
				showError: (message) => failed.push(message),
			},
			text,
		);
		return { shown: shown.join("\n"), failed: failed.join("\n") };
	};
	const rootRequests = () => world.provider.requests.filter((request) => request.model.id === "root").length;
	const requestsBefore = rootRequests();
	const systemOneBefore = world.systemOne.requests.length;
	const short = id.slice(0, 12);
	const global = { project: "", role: "", audience: "owner" };

	const listed = await run("/knowledge list behavior");
	expect(listed.failed).toBe("");
	expect(listed.shown, "the owner sees each fact's identity, category, reach, revision, basis and state").toContain(
		`${short}  behavior · global · r4 · explicit · current · evidenced`,
	);
	expect(listed.shown).toContain("Uses tabs again.");
	expect((await run("/knowledge list project")).shown, "reach filters by the record's own scope").toBe(
		"No accepted knowledge records (this project).",
	);
	const shown = await run(`/knowledge show ${short}`);
	expect(shown.failed).toBe("");
	expect(shown.shown, "show resolves the prefix to the exact record").toContain(`Knowledge ${id}`);
	expect(shown.shown, "provenance names the original owner message and quotes it").toContain(
		"Evidence of this revision (1-1 of 1",
	);
	expect(shown.shown).toContain("owner message");
	expect(shown.shown).toContain('"I use tabs again"');
	const history = await run(`/knowledge history ${short}`);
	expect(history.shown, "history pages the retained revisions").toContain("r4 · explicit");
	expect(history.shown, "forgetting removed the earlier value history").not.toContain("Uses spaces.");

	expect(root.session.ownerConfirm, "no owner UI is bound to this session yet").toBeUndefined();
	expect((await run(`/knowledge forget ${short}`)).failed, "without an owner UI nothing is forgotten").toBe(
		"Nothing changed: owner confirmation is unavailable.",
	);
	expect(store.get(id)).toMatchObject({ revision: 4, text: "Uses tabs again." });
	expect(rootRequests(), "viewing and a refused forget make no model or judge request").toBe(requestsBefore);
	expect(world.systemOne.requests.length, "and no System One request").toBe(systemOneBefore);

	let decision = false;
	let confirmations = 0;
	let revisionAtCommand = store.revision();
	const ui = {
		askQuestions: world.humanInput.ui.askQuestions,
		confirm: async (_title: string, message: string) => {
			confirmations += 1;
			expect(store.revision(), "nothing changes before the owner answers").toBe(revisionAtCommand);
			expect(message, "the owner sees the exact fact and its revision").toContain("at revision");
			return decision;
		},
	} as unknown as ExtensionUIContext;
	// The owner's screen arrives as an interactive host binds it; the binding's own memory activation is not a command effect.
	await root.session.bindExtensions({ uiContext: ui });
	const requestsBound = rootRequests();
	const systemOneBound = world.systemOne.requests.length;
	const correction = `/knowledge correct ${short}   Uses tabs for code and two spaces in YAML.  `;
	expect((await run(correction)).shown).toBe("Nothing changed: the owner did not confirm.");
	expect(store.get(id), "a declined correction changes nothing").toMatchObject({
		revision: 4,
		text: "Uses tabs again.",
	});
	decision = true;
	expect((await run(correction)).shown).toBe(
		`Corrected ${short}: revision 5 holds the new value; the previous one stays in its history.`,
	);
	const corrected = store.get(id)!;
	expect(corrected, "the owner's value is stored verbatim as an explicit fact of the same slot").toMatchObject({
		revision: 5,
		kind: "behavior",
		text: "Uses tabs for code and two spaces in YAML.",
		basis: "explicit",
	});
	expect(corrected.citations, "the typed command, its session and its time are the evidence").toEqual([
		{
			sourceId: expect.stringMatching(/^owner-command:[a-f0-9]{64}$/),
			sessionId: root.sessionManager.getSessionId(),
			quote: correction,
			at: corrected.lastEvidencedAt,
		},
	]);
	expect(
		store.history(id).map((version) => version.text),
		"the previous value stays in history",
	).toEqual(["Uses tabs for code and two spaces in YAML.", "Uses tabs again."]);
	expect(store.list(global), "a correction does not create a second fact").toHaveLength(1);
	expect(
		getOwnerEvidenceSnapshots(root.sessionManager.getCustomEntriesOnBranch([OWNER_EVIDENCE_CUSTOM_TYPE])).some(
			(record) => record.text.includes("/knowledge"),
		),
		"a command is not an owner message the collector or a model could cite",
	).toBe(false);

	revisionAtCommand = store.revision();
	expect((await run(`/knowledge forget ${short}`)).shown).toBe(
		`Forgot ${short} (revision 6). Only newer owner evidence can teach it again.`,
	);
	expect(store.get(id), "the confirmed forget removes the value").toBeUndefined();
	expect(store.history(id), "and its value history").toEqual([]);
	expect(store.slots(global, "behavior"), "its identity stays as the evidence barrier").toEqual([
		expect.objectContaining({ id, revision: 6, forgotten: true }),
	]);
	expect((await run(`/knowledge forget ${short}`)).failed, "a forgotten record is no longer addressable").toBe(
		`No current knowledge record ${short} in this scope.`,
	);
	expect(confirmations, "only the decline, the correction and the forget reached the owner").toBe(3);
	expect(rootRequests(), "a confirmed correction and forget make no model or judge request").toBe(requestsBound);
	expect(world.systemOne.requests.length, "and no System One request").toBe(systemOneBound);

	world.systemOne.enterPhase("knowledge-command-projection", ICM_INTAKE_JUDGMENTS);
	world.provider.enqueue("root", {
		name: "knowledge-command-projection",
		check: (request) => {
			const views = request.context.messages
				.filter((message) => message.role === "user")
				.map((message) => JSON.stringify(message.content))
				.filter((content) => content.includes("Current accepted knowledge,"));
			expect(views, "the next request carries one current knowledge view").toHaveLength(1);
			expect(views[0], "at the revision the owner's forget committed").toContain(
				`Current accepted knowledge, revision ${store.revision()}.`,
			);
			expect(views[0]).toContain("No applicable accepted facts.");
			expect(views[0], "the forgotten value is absent").not.toContain("two spaces in YAML");
			expect(JSON.stringify(request.context.messages), "an owner command never enters the conversation").not.toMatch(
				/\/knowledge (list|show|history|correct|forget)/,
			);
		},
		reply: { content: [{ type: "text", text: "Noted." }] },
	});
	await withDeadline(
		world.trace,
		"knowledge-command-projection",
		root.session.prompt("What do you know about my formatting?"),
	);
	await icmWaitForChatIdle(world, agentDir, records, (chat) => chat.length === records);
}
