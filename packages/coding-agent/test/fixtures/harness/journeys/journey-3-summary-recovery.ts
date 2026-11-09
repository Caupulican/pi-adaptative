import { join } from "node:path";
import { expect } from "vitest";
import type { AgentSession } from "../../../../src/core/agent-session.ts";
import {
	type TranscriptSummaryManifest,
	TranscriptSummaryStore,
} from "../../../../src/core/memory/transcript-summary-store.ts";
import { getDirectoryResourceProfileInfo } from "../../../../src/core/settings/settings-rules.ts";
import type { SessionManager } from "../../../../src/kernel/session/session-manager.ts";
import { HARNESS_PROVIDER, text } from "../scripted-provider.ts";
import { HARNESS_PROJECT_CWD, type HarnessWorld, type ScriptedJudgment, withDeadline } from "../session-fixture.ts";

/** The retention window unit of the summary catalog (`transcriptRetentionCutoff`). */
const DAY_MS = 24 * 60 * 60 * 1000;

/** The admitted h5 hierarchy the recovery legs start from: one accepted model summary, one summarizer call. */
export interface SummaryRecoveryContext {
	readonly label: string;
	readonly session: AgentSession;
	readonly manager: SessionManager;
	readonly store: TranscriptSummaryStore;
	/** How many summarizer requests the h5 hierarchy track has answered so far. */
	readonly summaryCalls: () => number;
}

function hierarchyOf(session: AgentSession) {
	return session.getTranscriptHistoryStatus().hierarchy;
}

/** The durable store as a reader loads it: the manifest tables and the accepted model summaries. */
async function loadSummaries(store: TranscriptSummaryStore, what: string) {
	const state = await store.load();
	if (!("nodes" in state)) throw new Error(`${what}: summary store unavailable: ${state.reason}`);
	if (state.manifest === undefined) throw new Error(`${what}: summary manifest missing`);
	const manifest: TranscriptSummaryManifest = state.manifest;
	return { manifest, models: [...state.nodes.values()].filter((node) => node.quality === "model_summary") };
}

/** Admission judge requests the System One transport decoded so far (each asks `summary_supported`). */
function summaryJudgeRequests(world: HarnessWorld): number {
	return world.systemOne.decoded.filter((request) => "summary_supported" in request.questions).length;
}

/**
 * Fault legs of the h5 history hierarchy, run on its admitted summary in order: a branch switch revokes the dead
 * coverage and switching back republishes the parked node without a model call; then a forget whose removal write
 * fails is retried on the store backoff until the derived data is gone.
 */
export async function runJourney3SummaryRecoveryLegs(
	world: HarnessWorld,
	context: SummaryRecoveryContext,
): Promise<void> {
	await revokeAndReuseBranchCoverage(world, context);
	await forgetWithDeferredRemoval(world, context);
}

/**
 * revokeDeadCoverage through index invalidation: the recall index posts a branch switch (a lineage that no longer
 * extends the previous one), the coordinator marks the session due and the next read revokes the leaf whose spans
 * left the lineage, parking it dormant. Switching back re-enumerates the same leaf identity, and reusableDormantNode
 * republishes it before any summarizer or admission call.
 */
async function revokeAndReuseBranchCoverage(world: HarnessWorld, context: SummaryRecoveryContext): Promise<void> {
	const { label, session, manager, store } = context;
	const trace = world.trace;
	const admitted = await loadSummaries(store, `${label}: before the branch switch`);
	expect(admitted.models).toHaveLength(1);
	const node = admitted.models[0]!;
	const judgeRequests = summaryJudgeRequests(world);
	const mainLeaf = manager.getLeafId();
	const mainLeafEntry = mainLeaf === null ? undefined : manager.getEntry(mainLeaf);
	if (
		mainLeafEntry === undefined ||
		mainLeafEntry.type === "custom_message" ||
		(mainLeafEntry.type === "message" && mainLeafEntry.message.role === "user")
	) {
		throw new Error(`${label}: the main leaf is not an entry navigation can select as the leaf itself`);
	}
	const firstReply = manager
		.getBranch()
		.find((entry) => entry.type === "message" && entry.message.role === "assistant");
	if (firstReply === undefined) throw new Error(`${label}: no assistant reply on the main branch`);

	const away = await withDeadline(
		trace,
		`${label}: switch to a branch after the first reply`,
		session.navigateTree(firstReply.id, { summarize: false }),
	);
	expect(away.cancelled).toBe(false);
	expect(manager.getLeafId()).toBe(firstReply.id);
	world.provider.enqueue("root", text(`${label}-branch-reply`, "The other path is noted."));
	await withDeadline(trace, `${label}: owner turn on the branch`, session.prompt("Take the other path from here."));
	await withDeadline(trace, `${label}: branch turn idle`, session.waitForForegroundIdle());
	await withDeadline(
		trace,
		`${label}: the branch switch revokes the dead leaf`,
		world.io.waitForMutation(() => {
			const hierarchy = hierarchyOf(session);
			return hierarchy?.lastRevocation?.reason === "invalidated" && hierarchy.acceptedNodes === 0;
		}),
	);
	expect(hierarchyOf(session)?.lastRevocation).toMatchObject({ reason: "invalidated", revokedNodes: 1 });
	const parked = await loadSummaries(store, `${label}: after the branch switch`);
	expect(parked.models).toEqual([]);
	expect(parked.manifest.acceptedNodes[node.id]).toBeUndefined();
	expect(parked.manifest.dormant[node.id]?.sessionId).toBe(node.sessionId);

	const back = await withDeadline(
		trace,
		`${label}: switch back to the main leaf`,
		session.navigateTree(mainLeaf as string, { summarize: false }),
	);
	expect(back.cancelled).toBe(false);
	expect(manager.getLeafId()).toBe(mainLeaf);
	world.provider.enqueue("root", text(`${label}-main-reply`, "Back on the main path."));
	await withDeadline(trace, `${label}: owner turn on the main path`, session.prompt("Return to the main path."));
	await withDeadline(trace, `${label}: main turn idle`, session.waitForForegroundIdle());
	await withDeadline(
		trace,
		`${label}: the parked leaf is republished`,
		world.io.waitForMutation(() => hierarchyOf(session)?.acceptedNodes === 1),
	);
	const reused = await loadSummaries(store, `${label}: after switching back`);
	expect(
		reused.models.map((model) => ({ id: model.id, text: model.text, admission: model.admission?.disposition })),
	).toEqual([{ id: node.id, text: node.text, admission: "accepted" }]);
	expect(reused.manifest.acceptedNodes[node.id]?.sessionId).toBe(node.sessionId);
	// The dormant identity is published again as parked: no summarizer request and no admission judgment.
	expect(context.summaryCalls()).toBe(1);
	expect(summaryJudgeRequests(world)).toBe(judgeRequests);
}

/**
 * forgetSession with its removal unavailable: the marker is durable (recordForget), the revocation write fails, so
 * applyForgottenSession defers it (deferStoreWork, StoreRetryState on the 1 s RetryBackoff) and the outcome carries
 * cleanupPending. The lifecycle timer then runs retryStoreWork: a retry that fails again advances the backoff once
 * (2 s), and the next one revokes the session's nodes and drops its cursor.
 */
async function forgetWithDeferredRemoval(world: HarnessWorld, context: SummaryRecoveryContext): Promise<void> {
	const { label, session, store } = context;
	const trace = world.trace;
	const admitted = await loadSummaries(store, `${label}: before the forget`);
	expect(admitted.models).toHaveLength(1);
	const node = admitted.models[0]!;
	const sessionId = node.sessionId;
	const judgeRequests = summaryJudgeRequests(world);
	expect(world.timers.armedDelays("history"), "an idle hierarchy arms no lifecycle wake").toEqual([]);

	const manifestPath = join(store.root, "manifest.json");
	const forgetPath = join(store.root, "forgotten-sessions.json");
	const faultName = `${label}-forget-removal-unavailable`;
	const faultsBefore = world.io.consumedFaults.filter((name) => name === faultName).length;
	// Only the manifest commits after the durable forget marker fail: the removal and its first retry, never an earlier
	// write. The second retry finds the store available again.
	let forgetDurable = false;
	world.io.failNext({
		name: faultName,
		kind: "rename",
		matches: (operation) => {
			if (operation.destination === forgetPath) {
				forgetDurable = true;
				return false;
			}
			return forgetDurable && operation.destination === manifestPath;
		},
		code: "EIO",
		times: 2,
	});
	const faultsSince = () => world.io.consumedFaults.filter((name) => name === faultName).length - faultsBefore;
	const answer = await withDeadline(
		trace,
		`${label}: forget with the removal unavailable`,
		session.memoryOperator.forgetHistorySession(sessionId),
	);
	expect(answer).toEqual({
		ok: true,
		message: `Forgot the derived history summaries of session ${sessionId}; its transcript is untouched and it will not be summarized again.`,
	});
	expect(faultsSince()).toBe(1);
	const pending = hierarchyOf(session);
	expect(pending?.acceptedNodes, "the failed removal revoked nothing").toBe(1);
	expect(pending?.lastInternalError?.cause).toContain(
		`removing the derived summaries of ${sessionId} could not be written`,
	);
	const marker = await store.readForgottenSessions();
	expect(marker.status === "ok" && marker.sessions.has(sessionId), "the forget marker is durable").toBe(true);
	const delays = world.timers.armedDelays("history");
	expect(delays, "the deferred removal arms one store retry").toHaveLength(1);
	expect(delays[0]).toBeGreaterThanOrEqual(0);
	expect(delays[0], "the first store retry waits the base backoff").toBeLessThanOrEqual(1_000);

	// The first retry fails again: the round advances the backoff once, so the next wait doubles.
	const rearmed = world.timers.nextArmed("history");
	expect(world.timers.advance("history", 1_000)).toBe(1);
	const doubled = await withDeadline(trace, `${label}: the failed retry re-arms the store backoff`, rearmed);
	expect(faultsSince()).toBe(2);
	expect(doubled, "the second store retry waits twice the base backoff").toBeGreaterThan(1_000);
	expect(doubled).toBeLessThanOrEqual(2_000);
	expect(hierarchyOf(session)?.acceptedNodes, "the failed retry revoked nothing").toBe(1);

	expect(world.timers.advance("history", 2_000)).toBe(1);
	await withDeadline(
		trace,
		`${label}: the store retry removes the forgotten session`,
		world.io.waitForMutation(() => {
			const hierarchy = hierarchyOf(session);
			return hierarchy?.lastRevocation?.reason === "forgotten" && hierarchy.acceptedNodes === 0;
		}),
	);
	expect(hierarchyOf(session)?.lastRevocation).toMatchObject({ reason: "forgotten", revokedNodes: 1 });
	const removed = await loadSummaries(store, `${label}: after the forget retry`);
	expect(removed.models).toEqual([]);
	expect(removed.manifest.acceptedNodes[node.id]).toBeUndefined();
	expect(removed.manifest.tombstones[node.id]?.reason).toBe("retention");
	// Revocation rewinds the session's cursor to the earliest revoked leaf; it never deletes the cursor.
	expect(removed.manifest.sessions[sessionId]).toMatchObject({ coveredSpanCount: 0, nextOrdinal: 0 });
	expect(world.timers.armedDelays("history"), "a retry that defers nothing arms no further wake").toEqual([]);
	expect(context.summaryCalls()).toBe(1);
	expect(summaryJudgeRequests(world)).toBe(judgeRequests);
}

/**
 * applyRetention on the lifecycle timer: a one-day window arms the wake one millisecond past the accepted node's
 * oldest dependency plus the window (nextRetentionAt), and advancing the history clock past it revokes the node
 * with a retention tombstone, never re-derived.
 */
export async function runJourney3SummaryRetentionLeg(
	world: HarnessWorld,
	intakeJudgments: Readonly<Record<string, ScriptedJudgment>>,
): Promise<void> {
	const label = "h5-summary-retention";
	const trace = world.trace;
	const agentDir = `${world.agentDir}-${label}`;
	const manager = world.createSessionManager(agentDir);
	const seed = await world.createRootSession("root", {
		agentDir,
		sessionManager: manager,
		settings: { memorySystem: "okf", autoLearn: { enabled: false } },
	});
	world.systemOne.enterPhase(`${label}-seed`, intakeJudgments);
	// The same eight canonical captures as h5: the ninth capture seals them into one leaf.
	for (let index = 1; index <= 4; index++) {
		world.provider.enqueue("root", text(`${label}-seed-${index}`, "Alpha remains unchanged."));
		await withDeadline(
			trace,
			`${label}: canonical seed turn ${index}`,
			seed.session.prompt("Keep alpha unchanged. ".repeat(6).trim()),
		);
	}
	expect(await world.disposeSessionInBody(seed.session)).toBeUndefined();

	const summaryText = "The owner asked to keep alpha unchanged. Pi acknowledged it each time.";
	const created = await world.createRootSession("root", {
		agentDir,
		sessionManager: manager,
		settings: {
			memorySystem: "okf",
			autoLearn: { enabled: false },
			contextPolicy: {
				memory: {
					enabled: true,
					includeInPrompt: false,
					history: {
						hierarchy: true,
						summaryModel: `${HARNESS_PROVIDER}/worker-c`,
						allowExternalSummaryEgress: true,
						allowExternalAdmissionEgress: true,
						maxConcurrentSummaries: 1,
						retentionDays: 1,
					},
				},
			},
		},
	});
	const session = created.session;
	const projectId = getDirectoryResourceProfileInfo(HARNESS_PROJECT_CWD, agentDir).hash.toLowerCase();
	const store = new TranscriptSummaryStore({ agentDir, projectId });
	let summaryCalls = 0;
	await withDeadline(
		trace,
		`${label}: history hierarchy with a retention window starts`,
		world.io.waitForMutation(() => hierarchyOf(session)?.state === "running"),
	);
	world.provider.enqueueTrack(
		`${label}-history-hierarchy`,
		"worker-c",
		(request) => request.context.systemPrompt?.includes("You write compact factual summaries") === true,
		{
			...text(`${label}-history-hierarchy`, summaryText),
			check: () => {
				summaryCalls++;
			},
		},
	);
	world.provider.enqueue("root", {
		...text(`${label}-seal-history`, "Ready to continue."),
		// The owner's intake settles before this request; only the background admission answers from here on.
		check: () =>
			world.systemOne.enterPhase(`${label}-history-judge`, {
				summary_supported: { kind: "noul", probability: 0.97 },
				owner_constraints_preserved: { kind: "noul", probability: 0.97 },
			}),
	});
	await withDeadline(trace, `${label}: seal history through owner turn`, session.prompt("Continue."));
	await withDeadline(trace, `${label}: sealing turn idle`, session.waitForForegroundIdle());
	await withDeadline(
		trace,
		`${label}: the summary is admitted inside the window`,
		world.io.waitForMutation(() => {
			const hierarchy = hierarchyOf(session);
			return hierarchy?.admission?.judgments.accepted === 1 && hierarchy.acceptedNodes === 1;
		}),
	);
	const admitted = await loadSummaries(store, `${label}: admitted`);
	expect(admitted.models.map((model) => ({ text: model.text, admission: model.admission?.disposition }))).toEqual([
		{ text: summaryText, admission: "accepted" },
	]);
	const node = admitted.models[0]!;
	if (node.oldestDependencyAt === undefined) throw new Error(`${label}: the admitted leaf carries no source age`);
	const window = hierarchyOf(session)?.retention;
	expect(window?.days).toBe(1);
	expect(window?.nextDeadlineAt, "the deadline is one window past the oldest dependency").toBe(
		Date.parse(node.oldestDependencyAt) + DAY_MS + 1,
	);
	const judgeRequests = summaryJudgeRequests(world);
	await withDeadline(trace, `${label}: the retention wake is armed`, world.timers.whenArmed("history"));
	expect(world.timers.armedDelays("history"), "the retention deadline is the only lifecycle wake").toHaveLength(1);

	expect(world.timers.advance("history", DAY_MS + 60_000)).toBe(1);
	await withDeadline(
		trace,
		`${label}: the expired summary is revoked`,
		world.io.waitForMutation(() => {
			const hierarchy = hierarchyOf(session);
			return hierarchy?.lastRevocation?.reason === "retention" && hierarchy.acceptedNodes === 0;
		}),
	);
	const revoked = hierarchyOf(session);
	expect(revoked?.lastRevocation).toMatchObject({ reason: "retention", revokedNodes: 1, readmittedParents: 0 });
	expect(revoked?.retention?.nextDeadlineAt, "nothing accepted is left to expire").toBeUndefined();
	expect(revoked?.admission?.judgments.accepted).toBe(1);
	const expired = await loadSummaries(store, `${label}: expired`);
	expect(expired.models).toEqual([]);
	expect(expired.manifest.acceptedNodes[node.id]).toBeUndefined();
	expect(expired.manifest.tombstones[node.id]?.reason).toBe("retention");
	// An expired leaf is never derived again: no summarizer request and no admission judgment after the deadline.
	expect(summaryCalls).toBe(1);
	expect(summaryJudgeRequests(world)).toBe(judgeRequests);
	expect(await world.disposeSessionInBody(session)).toBeUndefined();
	trace.mark("root", label);
}
