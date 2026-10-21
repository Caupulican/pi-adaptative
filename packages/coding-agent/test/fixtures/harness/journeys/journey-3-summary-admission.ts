import "../builtin-install.ts";
import { expect } from "vitest";
import { TranscriptSummaryStore } from "../../../../src/core/memory/transcript-summary-store.ts";
import { getDirectoryResourceProfileInfo } from "../../../../src/core/settings/settings-rules.ts";
import { isRecordObject } from "../../../../src/core/util/value-guards.ts";
import { createBarrier, HARNESS_PROVIDER, text } from "../scripted-provider.ts";
import { HARNESS_PROJECT_CWD, type HarnessWorld, withDeadline } from "../session-fixture.ts";
import { requestTexts } from "./shared.ts";

/** Journey 3's opt-in OKF history hierarchy, background admission, and foreground input overlap. */
export async function runJourney3SummaryAdmissionPhase(world: HarnessWorld): Promise<void> {
	const label = "h5-summary-admission";
	const requestsBefore = world.provider.requests.length;
	const agentDir = `${world.agentDir}-${label}`;
	const manager = world.createSessionManager(agentDir);
	const seed = await world.createRootSession("root", {
		agentDir,
		sessionManager: manager,
		settings: { memorySystem: "okf", autoLearn: { enabled: false } },
	});
	// These are the backlog questions reached by the real tool-free seed turns. No capability
	// authorization is pending, so that separate question must remain undeclared.
	const intakeJudgments = {
		carries_0: { kind: "noul", probability: 0.02 },
		changes_model_pools: { kind: "noul", probability: 0.02 },
		local_commits_only: { kind: "noul", probability: 0.02 },
		lifts_delivery_block: { kind: "noul", probability: 0.02 },
		full_handoff: { kind: "noul", probability: 0.02 },
		optional_tool_0: { kind: "choice", choice: "unchanged", confidence: 0.97 },
	} as const;
	world.systemOne.enterPhase(`${label}-seed`, intakeJudgments);
	// Eight real conversation captures exceed the exact-copy ceiling. A ninth capture seals the
	// first eight at the production leaf limit; no coordinator state or admission owner is mocked.
	for (let index = 1; index <= 4; index++) {
		world.provider.enqueue("root", text(`${label}-seed-${index}`, "Alpha remains unchanged."));
		await withDeadline(
			world.trace,
			`${label}: canonical seed turn ${index}`,
			seed.session.prompt("Keep alpha unchanged. ".repeat(6).trim()),
		);
	}
	expect(await world.disposeSessionInBody(seed.session)).toBeUndefined();

	const summaryText = "The owner repeatedly asked to keep alpha unchanged. Pi acknowledged each request.";
	const created = await world.createRootSession("root", {
		agentDir,
		sessionManager: manager,
		// ICM intentionally owns only its ContinuousChat tree. This separate history hierarchy
		// belongs to OKF; the existing enclosing journey keeps its independent ICM coverage.
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
					},
				},
			},
		},
	});
	const session = created.session;
	const projectId = getDirectoryResourceProfileInfo(HARNESS_PROJECT_CWD, agentDir).hash.toLowerCase();
	const store = new TranscriptSummaryStore({ agentDir, projectId });
	const judgeReached = createBarrier();
	const judgeMayAnswer = createBarrier();
	const judgeSettled = createBarrier();
	const summaryReached = createBarrier();
	let hierarchyCalls = 0;
	try {
		await withDeadline(
			world.trace,
			`${label}: opt-in history hierarchy starts`,
			world.io.waitForMutation(() => session.getTranscriptHistoryStatus().hierarchy?.state === "running"),
		);
		expect(session.getMemorySystem()).toBe("okf");
		expect(session.getTranscriptHistoryStatus().hierarchy?.state).toBe("running");
		if (world.systemOne.enabled) {
			world.provider.enqueueTrack(
				`${label}-history-hierarchy`,
				"worker-c",
				(request) => request.context.systemPrompt?.includes("You write compact factual summaries") === true,
				{
					...text(`${label}-history-hierarchy`, summaryText),
					check: (request) => {
						hierarchyCalls++;
						expect(requestTexts(request).join("\n")).toContain("SOURCE:");
						expect(requestTexts(request).join("\n")).toContain("Keep alpha unchanged.");
						summaryReached.release();
					},
				},
			);
		}
		world.provider.enqueue("root", {
			...text(`${label}-seal-history`, "Ready to continue."),
			check: () => {
				// Prior owner words settle before this real provider request; hold only the subsequent
				// background summary judgment, never a foreground intake classification.
				if (world.systemOne.enabled) {
					world.systemOne.enterPhase(
						`${label}-history-judge`,
						{
							summary_supported: { kind: "noul", probability: 0.97 },
							owner_constraints_preserved: { kind: "noul", probability: 0.97 },
						},
						{
							gate: judgeMayAnswer.promise,
							onAdmit: () => judgeReached.release(),
							expect: (request) => {
								expect(request.state).toMatchObject({ level: 0, candidate_summary: summaryText });
								if (!isRecordObject(request.state) || !Array.isArray(request.state.target)) {
									throw new Error(`${label}: admission omitted actual captured source`);
								}
								expect(request.state.target).toHaveLength(8);
							},
						},
					);
				} else {
					world.systemOne.enterPhase(`${label}-history-unbound`, {});
				}
			},
		});
		await withDeadline(world.trace, `${label}: seal history through owner turn`, session.prompt("Continue."));
		await withDeadline(world.trace, `${label}: sealing turn idle`, session.waitForForegroundIdle());
		if (world.systemOne.enabled) {
			await withDeadline(world.trace, `${label}: real history summary provider`, summaryReached.promise);
			await withDeadline(world.trace, `${label}: real history admission transport`, judgeReached.promise);
			const health = session.getSemanticPlaneHealth();
			expect(health.state).toBe("evaluating");
			expect(health.inFlightEvaluations).toHaveLength(1);
			expect(health.inFlightEvaluations?.[0]).toMatchObject({
				programId: "memory-summary-admission",
				occupancy: "background",
			});
		} else {
			await withDeadline(
				world.trace,
				`${label}: unbound judge holds model work`,
				world.io.waitForMutation(
					() => (session.getTranscriptHistoryStatus().hierarchy?.admission?.heldJobs ?? 0) > 0,
				),
			);
			expect(session.getTranscriptHistoryStatus().hierarchy?.admission?.blocked?.kind).toBe("admission_not_bound");
			expect(session.getSemanticPlaneHealth().state).toBe("unbound");
		}
		expect(session.isStreaming).toBe(false);
		expect(session.getForegroundActivity().epoch).toBeUndefined();
		expect(session.getTranscriptHistoryStatus().hierarchy?.admission?.judgments.accepted).toBe(0);
		const before = await store.load();
		if (!("nodes" in before)) throw new Error(`${label}: summary store unavailable before judgment`);
		expect([...before.nodes.values()].filter((node) => node.quality === "model_summary")).toEqual([]);

		const ownerInput = "Acknowledge this input while history summary admission is pending.";
		const ownerReply = "Your input is acknowledged while history admission remains pending.";
		world.systemOne.enterPhase(`${label}-owner-response`, intakeJudgments);
		world.provider.enqueue("root", {
			...text(`${label}-owner-response`, ownerReply),
			check: (request) => expect(requestTexts(request).some((value) => value.includes(ownerInput))).toBe(true),
		});
		await withDeadline(world.trace, `${label}: owner response before judge release`, session.prompt(ownerInput));
		await withDeadline(world.trace, `${label}: owner response complete`, session.waitForForegroundIdle());
		const persisted = manager.getBranch().flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
		expect(
			persisted.some((message) => message.role === "user" && JSON.stringify(message.content).includes(ownerInput)),
		).toBe(true);
		expect(
			persisted.some(
				(message) =>
					message.role === "assistant" &&
					message.content.some((block) => block.type === "text" && block.text === ownerReply),
			),
		).toBe(true);
		expect(session.getTranscriptHistoryStatus().hierarchy?.admission?.judgments.accepted).toBe(0);
		if (world.systemOne.enabled) {
			expect(session.getSemanticPlaneHealth().state, "owner response precedes actual judge release").toBe(
				"evaluating",
			);
			const unsubscribe = session.onSemanticEvaluation((record) => {
				if (record.programId === "memory-summary-admission") judgeSettled.release();
			});
			try {
				judgeMayAnswer.release();
				await withDeadline(world.trace, `${label}: background judgment settles`, judgeSettled.promise);
			} finally {
				unsubscribe();
			}
			await withDeadline(
				world.trace,
				`${label}: good judgment admits durable summary`,
				world.io.waitForMutation(() => {
					const hierarchy = session.getTranscriptHistoryStatus().hierarchy;
					return hierarchy?.admission?.judgments.accepted === 1 && hierarchy.acceptedNodes === 1;
				}),
			);
			const after = await store.load();
			if (!("nodes" in after)) throw new Error(`${label}: admitted summary store unavailable`);
			expect(
				[...after.nodes.values()]
					.filter((node) => node.quality === "model_summary")
					.map((node) => ({
						text: node.text,
						admission: node.admission?.disposition,
						judged: node.admission?.judged,
					})),
			).toEqual([{ text: summaryText, admission: "accepted", judged: ["support", "constraints"] }]);
			expect(hierarchyCalls).toBe(1);
		} else {
			expect(hierarchyCalls).toBe(0);
			expect(
				world.provider.requests
					.slice(requestsBefore)
					.filter(
						(request) => request.context.systemPrompt?.includes("You write compact factual summaries") === true,
					),
				"an unbound admission engine holds hierarchy model work before provider execution",
			).toEqual([]);
			expect(world.systemOne.requests).toEqual([]);
			expect(session.getTranscriptHistoryStatus().hierarchy?.admission?.judgments.accepted).toBe(0);
		}
	} finally {
		judgeMayAnswer.release();
	}
	expect(await world.disposeSessionInBody(session)).toBeUndefined();
	world.trace.mark("root", label);
}
