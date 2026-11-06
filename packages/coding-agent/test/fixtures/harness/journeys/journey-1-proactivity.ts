import type { Context } from "@caupulican/pi-ai";
import { createEmptyUsage } from "@caupulican/pi-ai";
import { expect } from "vitest";
import type { AgentSession } from "../../../../src/core/agent-session.ts";
import { sessionSemanticUsageOf } from "../../../../src/core/cost/semantic-usage-delivery.ts";
import { resolveSemanticUsageEntry } from "../../../../src/core/cost/usage-records.ts";
import type { ExtensionUIContext } from "../../../../src/core/extensions/types.ts";
import { HARNESS_NOTICE_CUSTOM_TYPE } from "../../../../src/core/harness-notice.ts";
import { feedbackRecordOf, foldFeedback } from "../../../../src/core/proactivity/proactivity-feedback.ts";
import { isPlainRecord } from "../../../../src/core/util/value-guards.ts";
import { parentInputOf, parentInputOriginalDetails } from "../../../../src/kernel/session/parent-input-ledger.ts";
import type { SessionManager } from "../../../../src/kernel/session/session-manager.ts";
import { formatProactivityStatus } from "../../../../src/modes/interactive/proactivity-commands.ts";
import { calls, createBarrier, type ScriptStep, text } from "../scripted-provider.ts";
import { type HarnessWorld, type ScriptedJudgment, withDeadline } from "../session-fixture.ts";
import { runJourney1ProactivityDurability } from "./journey-1-proactivity-durability.ts";
import { runJourney1ProactivityInvestigation } from "./journey-1-proactivity-investigation.ts";
import { runJourney1ProactivityMemory } from "./journey-1-proactivity-memory.ts";

const NOTE_TEXT = "The changelog entry you asked for is still not written.";
const NOTE_MARKER = "[proactive note]";

/**
 * The judgments System One makes about the previous owner turn when the next one is prepared: whether its words carry
 * forward, what authority they grant, and whether they changed the optional tools. This phase grants nothing.
 */
const OWNER_POLICY_JUDGMENTS = {
	capabilities_authorized: { kind: "noul", probability: 0.02 },
	changes_model_pools: { kind: "noul", probability: 0.02 },
	local_commits_only: { kind: "noul", probability: 0.02 },
	lifts_delivery_block: { kind: "noul", probability: 0.02 },
	full_handoff: { kind: "noul", probability: 0.02 },
	optional_tool_0: { kind: "choice", choice: "unchanged", confidence: 0.97 },
} as const;

const PREVIOUS_TURN_JUDGMENTS = {
	carries_0: { kind: "noul", probability: 0.02 },
	...OWNER_POLICY_JUDGMENTS,
} as const;

/** What the owner's reply did with the one delivered note System One is asked about: neither took it up nor declined it. */
const NOTE_IGNORED_JUDGMENTS = {
	acts_on_note_0: { kind: "noul", probability: 0.1 },
	declines_note_0: { kind: "noul", probability: 0.1 },
} as const;

/**
 * Proactivity: an idle review of the conversation may raise a note the owner did not ask for. One owner turn ends and the
 * review is armed on the proactivity timer; the review sees the owner's standing preferences and the conversation, offers
 * its bounded read tools, and raises a note that reaches the owner's next turn once; a review that raises the same note again, and
 * a review that raises nothing, deliver nothing; the per-session cap stops further reviews; and a session whose owner turned
 * the feature off arms no timer and sends no review request.
 */
export async function runJourney1ProactivityPhase(world: HarnessWorld): Promise<void> {
	const { trace } = world;
	const agentDir = `${world.agentDir}-proactivity`;
	const preferences = "Raise only work I asked for that is still undone.";
	const created = await world.createRootSession("root", {
		agentDir,
		sessionManager: world.createSessionManager(agentDir),
		settings: {
			memorySystem: "okf",
			autoLearn: { enabled: false },
			proactivity: {
				enabled: true,
				idleDelayMs: 1_000,
				minOwnerTurnsBetweenRuns: 1,
				maxRunsPerSession: 3,
				maxNotesPerRun: 2,
				delivery: "note",
				preferences,
			},
		},
	});
	const session: AgentSession = created.session;
	const lanes = session.backgroundLanes;
	const displayedNotes: string[] = [];
	const stopDisplay = session.subscribe((event) => {
		if (
			(event.type === "message_start" || event.type === "message_end") &&
			event.message.role === "custom" &&
			event.message.customType === "proactive-note" &&
			String(event.message.content).includes(NOTE_TEXT)
		)
			displayedNotes.push(event.type);
	});
	expect(created.settingsManager.getProactivitySettings().delivery, "the owner's explicit note choice wins").toBe(
		"note",
	);

	/** Resolves with how the next proactive review ends; the session announces it as an event. */
	const reviewEnds = (): Promise<"raised" | "quiet" | "failed"> =>
		new Promise((resolve) => {
			const off = session.subscribe((event) => {
				if (event.type !== "proactive_review") return;
				off();
				resolve(event.outcome);
			});
		});

	const ownerRequests: string[] = [];
	let turns = 0;
	const ownerTurn = async (
		label: string,
		prompt: string,
		judgments: Readonly<Record<string, ScriptedJudgment>> = {},
	): Promise<void> => {
		world.provider.enqueue("root", {
			name: `${label}-reply`,
			check: (request) => {
				ownerRequests.push(JSON.stringify(request.context.messages));
			},
			reply: { content: [{ type: "text", text: "Understood." }] },
		});
		// A turn's words are judged when the next turn is prepared, so only the later turns have judgments to answer.
		world.systemOne.enterPhase(label, { ...(turns === 0 ? {} : PREVIOUS_TURN_JUDGMENTS), ...judgments });
		turns += 1;
		await withDeadline(trace, `${label} owner turn`, session.prompt(prompt));
	};

	/** One review: arm, script what the model answers, fire the timer, and wait until the review has ended. */
	const review = async (
		label: string,
		answer: readonly ScriptStep[],
		inspect?: (context: Context) => void,
	): Promise<"raised" | "quiet" | "failed"> => {
		await withDeadline(trace, `${label} armed`, world.timers.whenArmed("proactivity"));
		const ended = reviewEnds();
		const reached = createBarrier();
		const [first, ...rest] = answer;
		if (first === undefined) throw new Error(`${label}: the review needs an answer`);
		world.provider.enqueue(
			"root",
			{
				...first,
				check: (request) => {
					inspect?.(request.context);
					reached.release();
				},
			},
			...rest,
		);
		expect(world.timers.advance("proactivity", 1_000), `${label}: the idle delay fires the review once`).toBe(1);
		await withDeadline(trace, `${label} reached the model`, reached.promise);
		return withDeadline(trace, `${label} ended`, ended);
	};

	const noteCount = (request: string): number => request.split(NOTE_MARKER).length - 1;

	// Review 1: the review reads the preferences and conversation, has a read-only surface, and raises one note.
	const seen: { systemPrompt: string; tools: string[]; messages: string }[] = [];
	await ownerTurn(
		"proactivity-1",
		"Finish the migration and update the changelog. I will ask about the changelog later.",
	);
	const first = await review(
		"proactivity-review-1",
		[
			calls("proactivity-review-1-raise", [
				{
					id: "raise-1",
					name: "raise_note",
					arguments: {
						kind: "reminder",
						text: NOTE_TEXT,
						why: "The owner asked for a changelog update and none was written.",
					},
				},
			]),
			text("proactivity-review-1-done", "none"),
		],
		(context) => {
			seen.push({
				systemPrompt: String(context.systemPrompt ?? ""),
				tools: (context.tools ?? []).map((tool) => tool.name),
				messages: JSON.stringify(context.messages),
			});
		},
	);
	expect(first, "a review that raised a note says so").toBe("raised");
	expect(seen[0]?.tools, "the review can read and record a note").toEqual(
		expect.arrayContaining(["read", "raise_note"]),
	);
	expect(
		seen[0]?.tools.every((name) =>
			["read", "grep", "find", "ls", "repo_read", "memory_read", "zoom", "date", "raise_note"].includes(name),
		),
		"the review exposes only bounded reads and note capture",
	).toBe(true);
	expect(seen[0]?.systemPrompt, "the review is told to stay quiet by default").toContain("Stay quiet by default");
	expect(seen[0]?.messages, "the review reads the owner's standing preferences").toContain(preferences);
	expect(seen[0]?.messages, "the review reads the conversation").toContain("Finish the migration");
	expect(displayedNotes, "a deferred note does not interrupt before the owner's next turn").toEqual([]);

	// The note reaches the owner's next turn, once.
	await ownerTurn("proactivity-2", "Thanks.");
	const second = ownerRequests.at(-1) ?? "";
	expect(second, "the raised note is carried with the owner's next turn").toContain(NOTE_TEXT);
	expect(noteCount(second), "the note is delivered once").toBe(1);
	expect(displayedNotes, "the owner's turn displays the accepted note once").toEqual(["message_start", "message_end"]);

	// Review 2 raises the same note again: it is a repeat, so nothing more is delivered.
	const repeat = await review("proactivity-review-2", [
		calls("proactivity-review-2-raise", [
			{
				id: "raise-2",
				name: "raise_note",
				arguments: { kind: "reminder", text: NOTE_TEXT, why: "Still not written." },
			},
		]),
		text("proactivity-review-2-done", "none"),
	]);
	expect(repeat, "a repeated note leaves the review quiet").toBe("quiet");
	// The owner's first reply after the note was shown is judged at the next review's admission: it does not engage it.
	await ownerTurn("proactivity-3", "Still thinking.", NOTE_IGNORED_JUDGMENTS);
	expect(noteCount(ownerRequests.at(-1) ?? ""), "a repeated note is not delivered again").toBe(1);

	// Review 3 raises nothing: the default is quiet.
	const nothing = await review("proactivity-review-3", [text("proactivity-review-3-none", "none")]);
	expect(nothing, "a review with nothing to raise is quiet").toBe("quiet");
	expect(
		feedbackOutcomes(created.sessionManager),
		"the note's outcome is recorded once; without System One nothing is judged or recorded",
	).toEqual(world.systemOne.enabled ? [["ignored"]] : []);
	await ownerTurn("proactivity-4", "Carry on.");
	expect(noteCount(ownerRequests.at(-1) ?? ""), "a review with nothing to raise delivers nothing").toBe(1);
	expect(displayedNotes, "later turns do not redisplay an already shown note").toEqual([
		"message_start",
		"message_end",
	]);
	stopDisplay();

	// The per-session cap is spent: the next idle arms no review.
	expect(world.timers.armedDelays("proactivity"), "no review is armed past the cap").toEqual([]);
	expect(lanes.getLastProactivitySkipReason(), "the cap names itself as the reason").toBe("max_runs_reached");

	// Interrupt a real review after it captured a note, while its second provider response is held.
	created.settingsManager.setProactivitySettings({
		...created.settingsManager.getProactivitySettings(),
		maxRunsPerSession: 12,
	});
	const staleNote = "This note was prepared before the owner changed the context.";
	const receipts = () =>
		created.sessionManager.getEntries().flatMap((entry) => {
			const receipt = resolveSemanticUsageEntry(entry)?.report;
			return receipt?.route === "proactivity" ? [receipt] : [];
		});
	const interruptReview = async (
		label: string,
		change: () => Promise<void> | void,
		immediate = false,
	): Promise<void> => {
		lanes.clearResearchLaneTimer();
		const reached = createBarrier();
		const release = createBarrier();
		const beforeReceipts = receipts().length;
		const warningStart = world.warnings.length;
		const recorded = createBarrier();
		const stopRecording = created.sessionManager.onEntriesPersisted(() => {
			if (receipts().length === beforeReceipts + 2) recorded.release();
		});
		const outcomes: string[] = [];
		const unsubscribe = session.subscribe((event) => {
			if (event.type === "proactive_review") outcomes.push(event.outcome);
		});
		const usage = { ...createEmptyUsage(), input: 16, output: 8, totalTokens: 24 };
		usage.cost.total = 0.001;
		world.provider.enqueue(
			"root",
			calls(`${label}-note`, [
				{
					id: `${label}-note`,
					name: "raise_note",
					arguments: { kind: "reminder", text: staleNote, why: "Earlier context." },
				},
			]),
			{
				name: `${label}-late`,
				check: () => reached.release(),
				gate: release.promise,
				ignoresAbort: true,
				reply: { content: [{ type: "text", text: "none" }], usage },
			},
		);
		const pending = lanes.runProactiveReviewOnce().then(
			(value) => ({ value }),
			(error: unknown) => ({ error }),
		);
		try {
			await withDeadline(trace, `${label} second request reached`, reached.promise);
			await change();
			if (immediate) {
				await withDeadline(trace, `${label} cancels before the provider returns`, pending);
				expect(
					world.warnings
						.slice(warningStart)
						.filter((warning) =>
							/^Provider request [0-9a-f-]{36} ended locally with usage still unknown; its original accounting identity is retained in the session journal\.$/.test(
								warning,
							),
						),
					"the cancellation discloses its one genuinely unsettled provider response",
				).toHaveLength(1);
				expect(receipts().length, "cancellation fabricates no provider receipt").toBe(beforeReceipts + 1);
				expect(
					sessionSemanticUsageOf(created.sessionManager).snapshot().unresolved,
					"the late request keeps its unresolved accounting obligation",
				).toBe(1);
			}
		} finally {
			release.release();
		}
		const settled = await withDeadline(trace, `${label} settled`, pending);
		try {
			await withDeadline(trace, `${label} actual provider receipt persisted`, recorded.promise);
		} finally {
			stopRecording();
		}
		unsubscribe();
		expect("value" in settled ? settled.value.delivered : [], "a stale review delivers no captured note").toEqual([]);
		expect(outcomes, "each interrupted review reports exactly one failed terminal").toEqual(["failed"]);
		const added = receipts().slice(beforeReceipts);
		expect(added, "both paid responses survive cancellation without an aggregate duplicate").toHaveLength(2);
		expect(added.reduce((total, receipt) => total + receipt.usage.cost.total, 0)).toBe(0.001);
		expect(added.every((receipt) => receipt.origin?.sessionId === created.sessionManager.getSessionId())).toBe(true);
		expect(sessionSemanticUsageOf(created.sessionManager).snapshot().unresolved).toBe(0);
	};
	await interruptReview(
		"proactivity-settings-stale",
		() => {
			created.settingsManager.setProactivitySettings({
				...created.settingsManager.getProactivitySettings(),
				enabled: false,
			});
		},
		true,
	);
	await ownerTurn("proactivity-after-settings", "I have completed the changelog now.");
	expect(ownerRequests.at(-1)).not.toContain(staleNote);
	created.settingsManager.setProactivitySettings({
		...created.settingsManager.getProactivitySettings(),
		enabled: true,
	});
	await interruptReview("proactivity-owner-stale", () =>
		ownerTurn("proactivity-during-review", "Please wait; I am changing direction."),
	);
	await interruptReview("proactivity-branch-stale", () => {
		const leaf = created.sessionManager.getLeafId();
		expect(leaf).not.toBeNull();
		created.sessionManager.resetLeaf();
		created.sessionManager.branch(leaf!);
	});
	await ownerTurn("proactivity-after-branch", "The current task is settled.");
	expect(ownerRequests.at(-1)).not.toContain(staleNote);
	created.settingsManager.setProactivitySettings({
		...created.settingsManager.getProactivitySettings(),
		delivery: "turn",
	});
	expect(created.settingsManager.getProactivitySettings().delivery, "an explicit turn choice is preserved").toBe(
		"turn",
	);
	const { delivery, ...defaultDeliverySettings } = created.settingsManager.getProactivitySettings();
	expect(delivery).toBe("turn");
	created.settingsManager.setProactivitySettings(defaultDeliverySettings);
	expect(created.settingsManager.getGlobalSettings().proactivity?.delivery, "delivery is now omitted").toBeUndefined();
	expect(
		created.settingsManager.getProactivitySettings().delivery,
		"omitted delivery wakes the parent by default",
	).toBe("turn");
	lanes.clearResearchLaneTimer();
	const currentNote = "The current review can wake its own parent turn.";
	const parentSettled = createBarrier();
	const stopParent = created.sessionManager.onEntriesPersisted(() => {
		const accepted = created.sessionManager
			.getEntries()
			.some(
				(entry) =>
					entry.type === "custom_message" &&
					entry.customType === "proactive-note" &&
					typeof entry.content === "string" &&
					entry.content.includes(currentNote),
			);
		if (accepted && created.sessionManager.getPendingParentInputs().length === 0) parentSettled.release();
	});
	// This wake is a host-owned custom message, not another owner input to classify.
	world.systemOne.enterPhase("proactivity-turn-delivery", {});
	world.provider.enqueue(
		"root",
		calls("proactivity-turn-note", [
			{
				id: "current-note",
				name: "raise_note",
				arguments: { kind: "follow_up", text: currentNote, why: "Current conversation." },
			},
		]),
		text("proactivity-turn-done", "none"),
		{
			...text("proactivity-turn-parent", "Understood."),
			check: (request) => expect(JSON.stringify(request.context.messages)).toContain(currentNote),
		},
	);
	const deliveredTurn = await withDeadline(
		trace,
		"default proactivity parent turn delivery",
		lanes.runProactiveReviewOnce(),
	);
	expect(
		deliveredTurn.delivered.map((note) => note.text),
		"own parent wake does not invalidate committed delivery",
	).toEqual([currentNote]);
	await withDeadline(trace, "default proactivity parent turn settles", parentSettled.promise);
	stopParent();
	expect(await world.disposeSessionInBody(session), "the proactivity session closes cleanly").toBeUndefined();

	// The actual transport receives a reduced output cap; exhausting it prevents the second call and note delivery.
	const budgetDir = `${world.agentDir}-proactivity-budget`;
	const budget = await world.createRootSession("root", {
		agentDir: budgetDir,
		sessionManager: world.createSessionManager(budgetDir),
		model: {
			...world.provider.model("root"),
			cost: { input: 0, output: 1, cacheRead: 0, cacheWrite: 0, tiers: [{ inputTokensAbove: 0, output: 1_000 }] },
		},
		systemOneEnabled: false,
		settings: {
			memorySystem: "okf",
			autoLearn: { enabled: false },
			proactivity: { enabled: true, minOwnerTurnsBetweenRuns: 1, maxUsd: 0.01 },
		},
	});
	world.provider.enqueue("root", text("proactivity-budget-owner", "Understood."));
	await withDeadline(trace, "budget owner turn", budget.session.prompt("Remind me about this unfinished task."));
	budget.session.backgroundLanes.clearResearchLaneTimer();
	const consumed = { ...createEmptyUsage(), input: 16, output: 10, totalTokens: 26 };
	consumed.cost.output = 0.01;
	consumed.cost.total = 0.01;
	world.provider.enqueue("root", {
		name: "proactivity-budget-note",
		check: (request) =>
			expect(request.options?.maxTokens, "the provider receives the affordable output cap").toBe(10),
		reply: {
			content: [
				{
					type: "toolCall",
					id: "budget-note",
					name: "raise_note",
					arguments: { kind: "reminder", text: staleNote, why: "Unfinished task." },
				},
			],
			stopReason: "toolUse",
			usage: consumed,
		},
	});
	const requestsAtBudget = world.provider.requests.length;
	await expect(
		withDeadline(trace, "budget review", budget.session.backgroundLanes.runProactiveReviewOnce()),
	).rejects.toThrow();
	expect(world.provider.requests.length - requestsAtBudget, "exhausted allowance prevents another transport").toBe(1);
	expect(
		budget.sessionManager
			.getEntries()
			.some((entry) => entry.type === "custom_message" && entry.customType === "proactive-note"),
	).toBe(false);
	world.provider.enqueue("root", {
		...text("proactivity-budget-next-owner", "Understood."),
		check: (request) =>
			expect(
				JSON.stringify(request.context.messages),
				"exhausted review queued no note for the next turn",
			).not.toContain(staleNote),
	});
	await withDeadline(trace, "owner after exhausted review", budget.session.prompt("I have finished that task."));
	expect(await world.disposeSessionInBody(budget.session)).toBeUndefined();

	// Missing configured pricing is a placeholder, not permission to spend for free in the background.
	const unknownDir = `${world.agentDir}-proactivity-unknown-price`;
	const unknown = await world.createRootSession("root", {
		agentDir: unknownDir,
		sessionManager: world.createSessionManager(unknownDir),
		model: { ...world.provider.model("root"), costDefaulted: true },
		systemOneEnabled: false,
		settings: {
			memorySystem: "okf",
			autoLearn: { enabled: false },
			proactivity: { enabled: true, minOwnerTurnsBetweenRuns: 1 },
		},
	});
	world.provider.enqueue("root", text("proactivity-unknown-owner", "Understood."));
	await withDeadline(trace, "unknown price owner turn", unknown.session.prompt("Remind me about this task."));
	unknown.session.backgroundLanes.clearResearchLaneTimer();
	const beforeUnknown = world.provider.requests.length;
	const unknownOutcomes: string[] = [];
	const unsubscribeUnknown = unknown.session.subscribe((event) => {
		if (event.type === "proactive_review") unknownOutcomes.push(event.outcome);
	});
	await expect(
		withDeadline(trace, "unknown price review", unknown.session.backgroundLanes.runProactiveReviewOnce()),
	).rejects.toThrow("no declared price");
	unsubscribeUnknown();
	expect(unknownOutcomes, "the attempted review reaches its terminal without a provider request").toEqual(["failed"]);
	expect(world.provider.requests.length, "unknown pricing never reaches the review transport").toBe(beforeUnknown);
	expect(await world.disposeSessionInBody(unknown.session)).toBeUndefined();

	await runRollingDayBounds(world);
	// Judging a reply needs System One; without it the main session above showed that nothing is asked or recorded.
	if (world.systemOne.enabled) await runNoteFeedback(world);

	// The owner can turn it off: no timer, no review request.
	const offDir = `${world.agentDir}-proactivity-off`;
	const off = await world.createRootSession("root", {
		agentDir: offDir,
		sessionManager: world.createSessionManager(offDir),
		settings: { memorySystem: "okf", autoLearn: { enabled: false }, proactivity: { enabled: false } },
	});
	const requestsBefore = world.provider.requests.length;
	world.provider.enqueue("root", text("proactivity-off-reply", "Understood."));
	world.systemOne.enterPhase("proactivity-off", {});
	await withDeadline(trace, "proactivity-off owner turn", off.session.prompt("Hello."));
	expect(world.timers.armedDelays("proactivity"), "a session without the feature arms no review").toEqual([]);
	expect(off.session.backgroundLanes.getLastProactivitySkipReason(), "the owner turned the feature off").toBe(
		"proactivity_disabled",
	);
	expect(world.provider.requests.length - requestsBefore, "only the owner's own turn reached the provider").toBe(1);

	// Preferences are a normal model tool, but only a settled owner confirmation may change them.
	const settings = off.settingsManager;
	let toolTurns = 0;
	const toolTurn = async (
		label: string,
		action: string,
		expected: string,
		preferencesText?: string,
	): Promise<void> => {
		// Only the first tool turn inherits the unscreened greeting. Each tool call then drains its own policy.
		world.systemOne.enterPhase(label, toolTurns++ === 0 ? PREVIOUS_TURN_JUDGMENTS : OWNER_POLICY_JUDGMENTS);
		world.provider.enqueue(
			"root",
			calls(`${label}-call`, [
				{
					id: label,
					name: "proactivity",
					arguments: { action, ...(preferencesText ? { text: preferencesText } : {}) },
				},
			]),
			{
				...text(`${label}-done`, "Understood."),
				check: (request) => {
					const result = request.context.messages.find(
						(message) => message.role === "toolResult" && message.toolCallId === label,
					);
					expect(result, `${label}: the production tool ran through the provider loop`).toBeDefined();
					expect(JSON.stringify(result), `${label}: the result reports the actual outcome`).toContain(expected);
				},
			},
		);
		await withDeadline(trace, label, off.session.prompt("Update my proactive review preferences."));
	};
	expect(off.session.getActiveToolNames(), "the preferences tool is available by default").toContain("proactivity");
	await toolTurn("preferences-unattended", "turn_on", "owner confirmation is unavailable");
	expect(settings.getProactivitySettings().enabled, "without an owner UI, the tool cannot enable reviews").toBe(false);
	let decision: "decline" | "accept" | "conflict" | "other-setting" | "cancel" = "decline";
	let confirmations = 0;
	const confirmationReached = createBarrier();
	const finishConfirmation = createBarrier();
	const ui = {
		askQuestions: world.humanInput.ui.askQuestions,
		confirm: async (_title: string, message: string) => {
			confirmations += 1;
			expect(message, "the owner sees the concrete proposed change").toContain("Allow the assistant to");
			if (decision === "conflict") {
				settings.setProactivitySettings({
					...settings.getProactivitySettings(),
					preferences: "Owner edited meanwhile.",
				});
			}
			if (decision === "other-setting") {
				settings.setProactivitySettings({ ...settings.getProactivitySettings(), maxRunsPerSession: 7 });
			}
			if (decision === "cancel") {
				confirmationReached.release();
				await finishConfirmation.promise;
			}
			return decision !== "decline";
		},
	} as unknown as ExtensionUIContext;
	await off.session.bindExtensions({ uiContext: ui });
	await toolTurn("preferences-declined", "set_preferences", "owner did not confirm", "No nightly reminders.");
	expect(settings.getProactivitySettings().preferences, "declining preserves the preferences").toBe("");
	decision = "conflict";
	await toolTurn("preferences-conflict", "set_preferences", "changed during confirmation", "No nightly reminders.");
	expect(settings.getProactivitySettings().preferences, "a stale confirmation cannot replace an owner edit").toBe(
		"Owner edited meanwhile.",
	);
	decision = "other-setting";
	await toolTurn("preferences-accepted", "set_preferences", "Saved.", "No nightly reminders.");
	expect(settings.getProactivitySettings().preferences, "the confirmed text is saved").toBe("No nightly reminders.");
	expect(settings.getProactivitySettings().maxRunsPerSession, "an unrelated concurrent setting is retained").toBe(7);
	decision = "accept";
	await toolTurn("preferences-read", "view", "No nightly reminders.");
	expect(confirmations, "reading requires no confirmation").toBe(3);
	await toolTurn("preferences-clear", "clear_preferences", "Saved.");
	expect(settings.getProactivitySettings().preferences, "the confirmed clear removes the text").toBe("");
	await toolTurn("preferences-enable", "turn_on", "Saved.");
	expect(settings.getProactivitySettings().enabled, "the owner can enable reviews through the tool").toBe(true);
	await toolTurn("preferences-disable", "turn_off", "Saved.");
	expect(settings.getProactivitySettings().enabled, "the owner can disable reviews through the tool").toBe(false);

	// Abort after the confirmation boundary was reached, even if a late affirmative answer arrives.
	decision = "cancel";
	world.systemOne.enterPhase("preferences-cancel", OWNER_POLICY_JUDGMENTS);
	world.provider.enqueue(
		"root",
		calls("preferences-cancel-call", [
			{ id: "preferences-cancel", name: "proactivity", arguments: { action: "turn_on" } },
		]),
	);
	const cancelledTurn = off.session.prompt("Enable proactive reviews.");
	await withDeadline(trace, "preferences cancellation reaches confirmation", confirmationReached.promise);
	const abort = off.session.abort("owner cancelled proactivity confirmation");
	finishConfirmation.release();
	await withDeadline(trace, "preferences cancellation settles", Promise.all([abort, cancelledTurn]));
	expect(settings.getProactivitySettings().enabled, "a cancelled request cannot save a late confirmation").toBe(false);
	expect(confirmations, "every mutating call reached the expected owner boundary exactly once").toBe(7);
	expect(await world.disposeSessionInBody(off.session), "the off session closes cleanly").toBeUndefined();
	trace.mark("root", "proactivity.done");
	await runJourney1ProactivityInvestigation(world);
	await runJourney1ProactivityMemory(world);
	await runJourney1ProactivityDurability(world);
}

/** Each recorded note message's outcomes, in branch order. */
function feedbackOutcomes(manager: SessionManager): string[][] {
	return manager.getEntries().flatMap((entry) => {
		const record = feedbackRecordOf(entry);
		return record ? [record.notes.map((note) => note.outcome)] : [];
	});
}

/**
 * What the owner does with delivered notes. System One judges only the owner's first typed reply after a note was shown,
 * at the next review's admission; code counts. A reply in the middle band counts nothing; two notes on the same topic
 * left unanswered in a row set the topic aside, silently: the next review starts nothing and asks nothing. Changed
 * standing inputs lift it, and a note the owner takes up clears the count.
 */
async function runNoteFeedback(world: HarnessWorld): Promise<void> {
	const { trace } = world;
	const agentDir = `${world.agentDir}-proactivity-feedback`;
	const root = await world.createRootSession("root", {
		agentDir,
		sessionManager: world.createSessionManager(agentDir),
		settings: {
			memorySystem: "okf",
			autoLearn: { enabled: false },
			proactivity: {
				enabled: true,
				minOwnerTurnsBetweenRuns: 1,
				maxRunsPerSession: 12,
				maxNotesPerRun: 2,
				delivery: "note",
				preferences: "Raise only open release work.",
			},
		},
	});
	const lanes = root.session.backgroundLanes;
	const noteA = "The release plan still names no owner for the rollback step.";
	const noteB = "The release plan still has no freeze date.";
	const noteC = "The rollback step in the release plan still has no owner.";
	const noteD = "The release plan could name who signs off the freeze.";
	let turns = 0;
	const ownerTurn = async (
		label: string,
		prompt: string,
		judgments: Readonly<Record<string, ScriptedJudgment>> = {},
		...carries: string[]
	): Promise<void> => {
		world.provider.enqueue("root", {
			...text(`${label}-reply`, "Understood."),
			check: (request) => {
				const messages = JSON.stringify(request.context.messages);
				for (const note of carries) expect(messages, `${label}: the note rides this owner turn`).toContain(note);
			},
		});
		world.systemOne.enterPhase(label, { ...(turns++ === 0 ? {} : PREVIOUS_TURN_JUDGMENTS), ...judgments });
		await withDeadline(trace, label, root.session.prompt(prompt));
		root.session.backgroundLanes.clearResearchLaneTimer();
	};
	const review = (label: string, notes: readonly string[]) => {
		world.provider.enqueue(
			"root",
			...(notes.length === 0
				? [text(`${label}-none`, "none")]
				: [
						calls(
							`${label}-raise`,
							notes.map((note, index) => ({
								id: `${label}-${index}`,
								name: "raise_note",
								arguments: { kind: "follow_up", text: note, why: "The owner asked for the release plan." },
							})),
						),
						text(`${label}-done`, "none"),
					]),
		);
		return withDeadline(trace, label, lanes.runProactiveReviewOnce());
	};
	const status = () => formatProactivityStatus({ settingsManager: root.settingsManager, session: root.session });
	const conversation = () =>
		foldFeedback(
			root.sessionManager.getEntries(),
			root.settingsManager.getProactivityFeedbackSettings(),
			Date.now(),
		).topics.get("conversation");
	const feedbackRequests = (phase: string) =>
		world.systemOne.decoded.filter((request) => request.phase === phase && "acts_on_note_0" in request.questions);

	await ownerTurn("feedback-1", "Draft the release plan with a rollback step.");
	// Sibling raise_note calls run as one parallel group, so the witness does not depend on their order.
	expect((await review("feedback-review-1", [noteA, noteB])).delivered.map((note) => note.text).sort()).toEqual(
		[noteA, noteB].sort(),
	);
	// The turn that carries the notes was typed before they were shown: only the reply after it is read.
	await ownerTurn("feedback-2", "Noted.", {}, noteA, noteB);
	const reply = "Let us outline the plan sections first.";
	await ownerTurn("feedback-3", reply, {
		acts_on_note_0: { kind: "noul", probability: 0.5 },
		declines_note_0: { kind: "noul", probability: 0.1 },
		acts_on_note_1: { kind: "noul", probability: 0.1 },
		declines_note_1: { kind: "noul", probability: 0.1 },
	});
	expect((await review("feedback-review-2", [noteC])).delivered.map((note) => note.text)).toEqual([noteC]);
	expect(
		feedbackRequests("feedback-3"),
		"one System One request judges both notes on the reply's typed words",
	).toHaveLength(1);
	expect(feedbackRequests("feedback-3")[0]?.state).toMatchObject({
		notes: expect.arrayContaining([
			{ kind: "follow_up", text: noteA, ownerReply: expect.stringContaining(reply) },
			{ kind: "follow_up", text: noteB, ownerReply: expect.stringContaining(reply) },
		]),
	});
	expect(feedbackOutcomes(root.sessionManager), "an undecided reply counts nothing").toEqual([["unknown", "ignored"]]);
	expect(conversation(), "one unanswered note in a row sets nothing aside").toMatchObject({
		missedInARow: 1,
		level: 0,
	});

	await ownerTurn("feedback-4", "Noted.", {}, noteC);
	await ownerTurn("feedback-5", "Go on with the plan sections.", NOTE_IGNORED_JUDGMENTS);
	const beforeSuppressed = world.provider.requests.length;
	expect(
		await withDeadline(trace, "feedback set aside", lanes.runProactiveReviewOnce()),
		"the second unanswered note in a row sets the topic aside",
	).toEqual({ started: false, skipReason: "topic_suppressed", delivered: [] });
	expect(world.provider.requests.length - beforeSuppressed, "a set-aside topic spends no review").toBe(0);
	expect(lanes.getLastProactivitySkipReason()).toBe("topic_suppressed");
	expect(feedbackOutcomes(root.sessionManager)).toEqual([["unknown", "ignored"], ["ignored"]]);
	expect(conversation()?.suppressed?.until, "the first set-aside lasts seven days").toBeGreaterThan(
		Date.now() + 6 * 24 * 60 * 60 * 1000,
	);
	expect(status(), "status shows the set-aside topic and its end").toContain(
		"Set aside after unanswered or declined notes: conversation, until ",
	);
	expect(
		root.sessionManager.getEntries().filter((entry) => {
			const details = parentInputOriginalDetails(entry);
			return (
				entry.type === "custom_message" &&
				entry.customType === HARNESS_NOTICE_CUSTOM_TYPE &&
				isPlainRecord(details) &&
				details.kind === "proactive-review"
			);
		}),
		"setting a topic aside sends no notice",
	).toEqual([]);
	const judgedBefore = world.systemOne.decoded.length;
	expect((await withDeadline(trace, "feedback set aside again", lanes.runProactiveReviewOnce())).skipReason).toBe(
		"topic_suppressed",
	);
	expect(world.systemOne.decoded.length - judgedBefore, "a set-aside topic asks System One nothing").toBe(0);
	expect(world.provider.requests.length - beforeSuppressed).toBe(0);

	// Changed standing inputs lift it; a note the owner then takes up clears the count.
	root.settingsManager.setProactivitySettings({
		...root.settingsManager.getProactivitySettings(),
		preferences: "Raise open release work, including sign-off.",
	});
	expect(status(), "changed inputs lift the set-aside topic").not.toContain("Set aside");
	expect((await review("feedback-review-4", [noteD])).delivered.map((note) => note.text)).toEqual([noteD]);
	await ownerTurn("feedback-6", "Noted.", {}, noteD);
	await ownerTurn("feedback-7", "Yes, name the sign-off owner in the plan.", {
		acts_on_note_0: { kind: "noul", probability: 0.95 },
		declines_note_0: { kind: "noul", probability: 0.05 },
	});
	expect((await review("feedback-review-5", [])).started, "the review runs after the owner took a note up").toBe(true);
	expect(feedbackOutcomes(root.sessionManager).at(-1)).toEqual(["acted"]);
	expect(conversation(), "a taken-up note clears the count and the set-aside").toMatchObject({
		missedInARow: 0,
		level: 0,
	});
	expect(conversation()?.suppressed).toBeUndefined();
	expect(await world.disposeSessionInBody(root.session)).toBeUndefined();
}

/**
 * The rolling-day bounds hold across the sessions stored together. Within both bounds an accepted note wakes its parent
 * turn (the normal order). Once the day's wakes reach their bound, the next accepted note starts no parent turn and rides
 * the owner's next turn. A new session of the same store, with a fresh per-session count, starts no review once the
 * day's review spend reaches its bound; raising that bound admits a review whose note the first session's wake holds.
 */
async function runRollingDayBounds(world: HarnessWorld): Promise<void> {
	const { trace } = world;
	const agentDir = `${world.agentDir}-proactivity-daily`;
	// An exact binary fraction: two paid reviews reach the spend bound exactly, the second spending exactly its remainder.
	const reviewUsd = 0.03125;
	const settings = {
		memorySystem: "okf" as const,
		autoLearn: { enabled: false },
		proactivity: { enabled: true, minOwnerTurnsBetweenRuns: 1, maxUsdPerDay: 2 * reviewUsd, maxTurnWakesPerDay: 1 },
	};
	const wokenNote = "The release note promised for Friday is still unwritten.";
	const heldNote = "The migration rollback plan was promised and is still missing.";
	const crossNote = "The next task still has no acceptance check.";
	type Root = Awaited<ReturnType<HarnessWorld["createRootSession"]>>;
	const ownerTurn = async (root: Root, label: string, prompt: string, ...carries: string[]): Promise<void> => {
		world.provider.enqueue("root", {
			...text(label, "Understood."),
			check: (request) => {
				const messages = JSON.stringify(request.context.messages);
				expect(messages, `${label}: the owner's words reach the request`).toContain(prompt);
				for (const carried of carries)
					expect(messages, `${label}: the held input rides this owner turn`).toContain(
						JSON.stringify(carried).slice(1, -1),
					);
			},
		});
		await withDeadline(trace, label, root.session.prompt(prompt));
		root.session.backgroundLanes.clearResearchLaneTimer();
	};
	const raise = (label: string, note: string, usd: number): ScriptStep => {
		const usage = { ...createEmptyUsage(), input: 16, output: 8, totalTokens: 24 };
		usage.cost.total = usd;
		return {
			name: label,
			reply: {
				content: [
					{
						type: "toolCall",
						id: label,
						name: "raise_note",
						arguments: { kind: "reminder", text: note, why: "The owner asked for it." },
					},
				],
				stopReason: "toolUse",
				usage,
			},
		};
	};
	const isNote = (entry: ReturnType<SessionManager["getEntries"]>[number], note: string) =>
		entry.type === "custom_message" &&
		entry.customType === "proactive-note" &&
		typeof entry.content === "string" &&
		entry.content.includes(note);
	const acceptedMode = (root: Root, note: string) => {
		const entry = root.sessionManager.getEntries().find((candidate) => isNote(candidate, note));
		return entry === undefined ? undefined : parentInputOf(entry)?.metadata.mode;
	};
	const recordedReviewUsd = (root: Root) =>
		root.sessionManager.getEntries().reduce((sum, entry) => {
			const receipt = resolveSemanticUsageEntry(entry);
			return receipt?.report.route === "proactivity" ? sum + receipt.cost.total : sum;
		}, 0);
	const status = (root: Root) =>
		formatProactivityStatus({ settingsManager: root.settingsManager, session: root.session });

	const first = await world.createRootSession("root", {
		agentDir,
		sessionManager: world.createSessionManager(agentDir),
		systemOneEnabled: false,
		settings,
	});
	const lanes = first.session.backgroundLanes;

	// Normal order: within both bounds, the accepted note wakes its parent turn.
	await ownerTurn(first, "daily-owner-1", "Write the release note before Friday.");
	const wakeSettled = createBarrier();
	const stopWake = first.sessionManager.onEntriesPersisted(() => {
		const accepted = first.sessionManager.getEntries().some((entry) => isNote(entry, wokenNote));
		if (accepted && first.sessionManager.getPendingParentInputs().length === 0) wakeSettled.release();
	});
	world.provider.enqueue(
		"root",
		raise("daily-review-1-note", wokenNote, reviewUsd),
		text("daily-review-1-done", "none"),
		{
			...text("daily-review-1-wake", "Noted."),
			check: (request) =>
				expect(JSON.stringify(request.context.messages), "the woken parent turn carries the note").toContain(
					wokenNote,
				),
		},
	);
	const control = await withDeadline(trace, "daily bounds: review within both bounds", lanes.runProactiveReviewOnce());
	expect(control.delivered.map((note) => note.text)).toEqual([wokenNote]);
	expect(control.deliveryHold, "nothing holds a delivery within both bounds").toBeUndefined();
	await withDeadline(trace, "daily bounds: the woken parent turn settles", wakeSettled.promise);
	stopWake();
	// The note is consumed at its request's terminal; the woken turn ends before the owner's next prompt.
	await withDeadline(trace, "daily bounds: the woken parent turn ends", first.session.agent.waitForIdle());
	expect(acceptedMode(first, wokenNote), "the note was accepted as a parent wake").toBe("turn");
	expect(lanes.getProactivityDailyState()).toMatchObject({
		measured: { reviewUsd: 0, turnWakes: 0 },
		lastDelivery: { mode: "turn" },
	});

	// Wake bound reached: the review still runs, and its note starts no parent turn but rides the owner's next turn.
	await ownerTurn(first, "daily-owner-2", "Plan the database migration.");
	world.provider.enqueue(
		"root",
		raise("daily-review-2-note", heldNote, reviewUsd),
		text("daily-review-2-done", "none"),
	);
	const beforeHeld = world.provider.requests.length;
	const held = await withDeadline(trace, "daily bounds: review past the wake bound", lanes.runProactiveReviewOnce());
	expect(
		held.delivered.map((note) => note.text),
		"the accepted note is delivered, never dropped",
	).toEqual([heldNote]);
	expect(held.deliveryHold, "the reached wake bound names itself").toBe("max_turn_wakes_per_day_reached");
	expect(world.provider.requests.length - beforeHeld, "only the review's own two requests reach the provider").toBe(2);
	expect(acceptedMode(first, heldNote), "the note is accepted for the owner's next turn").toBe("next-owner-turn");
	expect(first.sessionManager.getPendingParentInputs("turn"), "no parent wake is pending").toEqual([]);
	expect(first.sessionManager.getPendingParentInputs("next-owner-turn"), "the held note waits").toHaveLength(1);
	expect(lanes.getProactivityDailyState()).toMatchObject({
		measured: { reviewUsd, turnWakes: 1 },
		lastDelivery: { mode: "next-owner-turn", hold: "max_turn_wakes_per_day_reached" },
	});
	expect(status(first), "status shows why the note waits").toContain(
		"Last note delivery: waits for the owner's next turn (max_turn_wakes_per_day_reached)",
	);
	const beforeOwner = world.provider.requests.length;
	await ownerTurn(first, "daily-owner-3", "What is still open?", heldNote);
	expect(world.provider.requests.length - beforeOwner, "the owner's turn is the only request").toBe(1);
	expect(first.sessionManager.getPendingParentInputs(), "the owner's turn consumed the held note").toEqual([]);

	// Both reviews' spend is in the first session's file before it closes, where the next session reads it.
	const spendRecorded = createBarrier();
	const stopSpend = first.sessionManager.onEntriesPersisted(() => {
		if (recordedReviewUsd(first) >= 2 * reviewUsd) spendRecorded.release();
	});
	if (recordedReviewUsd(first) >= 2 * reviewUsd) spendRecorded.release();
	await withDeadline(trace, "daily bounds: review spend is recorded", spendRecorded.promise);
	stopSpend();
	expect(await world.disposeSessionInBody(first.session)).toBeUndefined();

	// A new session of the same store has a fresh per-session count, but the day's review spend is reached.
	const second = await world.createRootSession("root", {
		agentDir,
		sessionManager: world.createSessionManager(agentDir),
		systemOneEnabled: false,
		settings,
	});
	const secondLanes = second.session.backgroundLanes;
	await ownerTurn(second, "daily-owner-4", "Start the next task.");
	const notices = (root: Root) =>
		root.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "custom_message" && entry.customType === HARNESS_NOTICE_CUSTOM_TYPE);
	// The reached spend bound is a gate the owner can act on: the harness saves one notice for their next turn by itself.
	const noticeSaved = createBarrier();
	const stopNotice = second.sessionManager.onEntriesPersisted(() => {
		if (notices(second).length > 0) noticeSaved.release();
	});
	const beforeRefused = world.provider.requests.length;
	const refused = await withDeadline(
		trace,
		"daily bounds: review past the spend bound",
		secondLanes.runProactiveReviewOnce(),
	);
	expect(refused, "no review starts past the day's spend").toEqual({
		started: false,
		skipReason: "max_usd_per_day_reached",
		delivered: [],
	});
	await withDeadline(trace, "daily bounds: the spend gate's notice is saved", noticeSaved.promise);
	stopNotice();
	const [spendNotice] = notices(second);
	if (spendNotice?.type !== "custom_message" || typeof spendNotice.content !== "string")
		throw new Error("The spend gate's notice is not a saved text message.");
	expect(parentInputOf(spendNotice)?.metadata.mode, "the notice never wakes a turn").toBe("next-owner-turn");
	expect(parentInputOriginalDetails(spendNotice)).toEqual({
		kind: "proactive-review",
		reason: "max_usd_per_day_reached",
		generation: 0,
	});
	const spendNoticeText = "reached proactivity.maxUsdPerDay";
	expect(spendNotice.content, "the notice names the bound the owner can raise").toContain(spendNoticeText);
	expect(second.sessionManager.getPendingParentInputs("turn"), "no parent wake is pending").toEqual([]);
	expect(world.provider.requests.length - beforeRefused, "a refused review and its notice send no request").toBe(0);
	// The same gate observed again is the same state: no second notice.
	const refusedAgain = await withDeadline(
		trace,
		"daily bounds: review past the spend bound again",
		secondLanes.runProactiveReviewOnce(),
	);
	expect(refusedAgain.skipReason).toBe("max_usd_per_day_reached");
	expect(world.provider.requests.length - beforeRefused, "the repeated gate sends no request").toBe(0);
	expect(secondLanes.getLastProactivitySkipReason()).toBe("max_usd_per_day_reached");
	expect(secondLanes.getProactivityDailyState().measured, "the first session's spend and wake").toMatchObject({
		reviewUsd: 2 * reviewUsd,
		turnWakes: 1,
	});
	expect(status(second), "status names the spend bound").toContain("Last gate: max_usd_per_day_reached");

	// Raising the spend bound admits a review; the first session's wake still holds this session's note.
	second.settingsManager.setProactivitySettings({
		...second.settingsManager.getProactivitySettings(),
		maxUsdPerDay: 4 * reviewUsd,
	});
	world.provider.enqueue("root", raise("daily-review-3-note", crossNote, 0), text("daily-review-3-done", "none"));
	const beforeCross = world.provider.requests.length;
	const cross = await withDeadline(
		trace,
		"daily bounds: review under a raised bound",
		secondLanes.runProactiveReviewOnce(),
	);
	expect(cross.delivered.map((note) => note.text)).toEqual([crossNote]);
	expect(cross.deliveryHold, "another session's wake counts toward the bound").toBe("max_turn_wakes_per_day_reached");
	expect(world.provider.requests.length - beforeCross).toBe(2);
	expect(second.sessionManager.getPendingParentInputs("turn"), "no parent wake is pending").toEqual([]);
	// The owner's next turn carries the notice and shows it on their screen, once; nothing else is bought for it.
	const shownNotices: string[] = [];
	const stopShown = second.session.subscribe((event) => {
		if (
			event.type === "message_start" &&
			event.message.role === "custom" &&
			event.message.customType === HARNESS_NOTICE_CUSTOM_TYPE &&
			typeof event.message.content === "string"
		)
			shownNotices.push(event.message.content);
	});
	const beforeOwner5 = world.provider.requests.length;
	await ownerTurn(second, "daily-owner-5", "Continue.", crossNote, spendNoticeText);
	stopShown();
	expect(world.provider.requests.length - beforeOwner5, "the owner's turn is the only request").toBe(1);
	expect(shownNotices, "the owner sees the notice with their turn").toEqual([spendNotice.content]);
	expect(second.sessionManager.getPendingParentInputs(), "the owner's turn consumed the notice").toEqual([]);
	expect(notices(second), "the review started after the raise and the owner's turn add no second notice").toHaveLength(
		1,
	);
	expect(await world.disposeSessionInBody(second.session)).toBeUndefined();
}
