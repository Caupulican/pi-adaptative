import { calculateCost, createEmptyUsage } from "@caupulican/pi-ai";
import { expect } from "vitest";
import { replaceGoal } from "../../../../src/core/goals/goal-lifecycle.ts";
import { createGoalState } from "../../../../src/core/goals/goal-state.ts";
import { GATHERED_EVIDENCE_CUSTOM_TYPE } from "../../../../src/core/minion-gathering.ts";
import { ModelRegistry } from "../../../../src/core/model-registry.ts";
import { goalObjectiveId } from "../../../../src/core/orchestration/work-state-projection.ts";
import { estimateProviderRequestTokens } from "../../../../src/kernel/provider-request-estimator.ts";
import { calls, createBarrier, HARNESS_API, HARNESS_PROVIDER, type ScriptStep } from "../scripted-provider.ts";
import { type HarnessWorld, SCRIPTED_TRACKS, type ScriptedJudgment, withDeadline } from "../session-fixture.ts";
import { LIMITS_PATH, latestBatchResults } from "./shared.ts";

interface RetrievalJudgments {
	bootstrap: Readonly<Record<string, ScriptedJudgment>>;
	first: Readonly<Record<string, ScriptedJudgment>>;
	later: Readonly<Record<string, ScriptedJudgment>>;
	route: Readonly<Record<string, ScriptedJudgment>>;
}

/** Real minions retain their accepted A terminal while replacement refuses new A publication. */
export async function verifyGoalRetrievalReplacement(
	world: HarnessWorld,
	judgments: RetrievalJudgments,
): Promise<void> {
	// Legacy mode has no semantic retrieve route or price-selected gathering executor.
	if (!world.systemOne.enabled) return;
	const label = "goal-replacement-with-priced-minion";
	const aWords = "Inspect the first source boundary with read-only evidence.";
	const bWords = "Inspect the second source boundary with read-only evidence.";
	const aReport = "The A boundary line contains MAX_RETRIES = 5.";
	const bReport = "The B boundary line contains MAX_RETRIES = 5.";
	const agentDir = `${world.agentDir}-${label}`;
	const manager = world.createSessionManager(agentDir);
	const registry = ModelRegistry.inMemory(world.authStorage);
	const credential = world.authStorage.get(HARNESS_PROVIDER);
	if (credential?.type !== "api_key") throw new Error(`${label}: scripted provider API credential missing`);
	const models = SCRIPTED_TRACKS.map((id) => ({
		...world.provider.model(id),
		...(id === "root" ? { cost: { input: 1, output: 0, cacheRead: 1, cacheWrite: 1 } } : {}),
	}));
	registry.registerProvider(HARNESS_PROVIDER, {
		api: HARNESS_API,
		apiKey: credential.key,
		baseUrl: world.provider.model("root").baseUrl,
		models: models.map(({ id, name, reasoning, input, cost, contextWindow, maxTokens }) => ({
			id,
			name,
			reasoning,
			input,
			cost,
			contextWindow,
			maxTokens,
		})),
	});
	const model = registry.find(HARNESS_PROVIDER, "root");
	if (!model) throw new Error(`${label}: priced root missing`);
	const errors: string[] = [];
	let reloads = 0;
	const { session } = await world.createRootSession("root", {
		agentDir,
		sessionManager: manager,
		model,
		modelRegistry: registry,
		settings: {
			memorySystem: "okf",
			autoLearn: { enabled: false },
			workerDelegation: {
				modelPins: { default: { provider: HARNESS_PROVIDER, modelId: "worker-a", thinkingLevel: "off" } },
			},
		},
		extensionFactories: [
			(pi) => {
				pi.on("session_start", (event) => {
					if (event.reason === "reload") reloads++;
				});
			},
		],
	});
	const held = createBarrier();
	const release = createBarrier();
	const parentReached = createBarrier();
	const bParentReached = createBarrier();
	let pass: ReturnType<typeof session.continueGoalOnce> | undefined;
	const failures: unknown[] = [];
	try {
		expect(
			world.io.readFileSync(LIMITS_PATH, "utf8"),
			`${label}: earlier orchestration left its verified source`,
		).toContain("MAX_RETRIES = 5");
		await session.bindExtensions({ uiContext: world.humanInput.ui, onError: (error) => errors.push(error.error) });
		const a = createGoalState({
			goalId: `${label}-a`,
			userGoal: aWords,
			tokenBudget: 1_000_000,
			now: new Date().toISOString(),
		});
		session.saveGoalStateSnapshot(a);
		expect(
			session.getDecisionLedger()?.medianWorkerPrefixTokens(0),
			`${label}: new ledger has no manufactured worker observations`,
		).toBeUndefined();
		await session.sendCustomMessage({
			customType: "priced-root-source-context",
			content: "source-boundary-context ".repeat(4000),
			display: false,
		});
		// An actual root preflight creates the retrieve directive; the route checkpoint's
		// missing_work_class catalog does not offer retrieve as a semantic choice.
		world.systemOne.enterPhase(`${label}-root-bootstrap`, judgments.bootstrap);
		const bootstrapRequests = world.provider.requests.length;
		world.provider.enqueue(
			"root",
			accountedText(`${label}-root-bootstrap`, "The source boundary remains under inspection."),
		);
		const bootstrap = await withDeadline(
			world.trace,
			`${label}: real root preflight seeds retrieval`,
			session.continueGoalOnce({ maxStallTurns: 20 }),
		);
		expect(bootstrap.submitted, `${label}: bootstrap reaches the real root`).toBe(true);
		await withDeadline(world.trace, `${label}: bootstrap root released`, session.waitForForegroundIdle());
		expect(session.objectiveExecutionController?.getLastRoute()?.route).toBe("implement");
		expect(world.provider.requests.slice(bootstrapRequests).map((request) => request.model.id)).toEqual(["root"]);
		for (let index = 0; index < 2; index++) {
			world.systemOne.enterPhase(`${label}-root-learning-${index}`, judgments.later);
			world.provider.enqueue(
				"root",
				accountedText(`${label}-root-learning-${index}`, "The source boundary remains under inspection."),
			);
			const result = await withDeadline(
				world.trace,
				`${label}: real root retrieval ${index}`,
				session.continueGoalOnce({ maxStallTurns: 20 }),
			);
			expect(result.submitted, `${label}: unknown worker prefix keeps retrieval on root`).toBe(true);
			await withDeadline(world.trace, `${label}: learning root released`, session.waitForForegroundIdle());
			expect(session.objectiveExecutionController?.getLastRoute()).toMatchObject({
				route: "retrieve",
				reason_codes: expect.arrayContaining(["system_one_preflight_retrieve"]),
			});
		}
		const ledger = session.getDecisionLedger();
		expect(
			ledger?.learnedRootRouteRequests("retrieve"),
			`${label}: actual successive route decisions learn root requests`,
		).toBeGreaterThan(0);
		world.systemOne.enterPhase(`${label}-worker-prefix-control`, {});
		world.provider.enqueue(
			"worker-a",
			calls(`${label}-prefix-read`, [
				{ id: `${label}-prefix-read`, name: "read", arguments: { path: LIMITS_PATH } },
			]),
			readReportStep(`${label}-prefix-report`, "The source line contains MAX_RETRIES = 5."),
		);
		world.provider.enqueue("root", {
			...accountedText(`${label}-prefix-parent`, "The worker note is available."),
			check: () => parentReached.release(),
		});
		const prefix = await withDeadline(
			world.trace,
			`${label}: real prefix worker`,
			session.runWorkerDelegationOnce({
				instructions: `Read ${LIMITS_PATH} and report its retry value.`,
				authority: { readOnly: true },
				forkTurns: "none",
			}),
		);
		expect(prefix.outcome?.accepted, `${label}: normal worker report is accepted`).toBe(true);
		await withDeadline(world.trace, `${label}: ordinary parent notification`, parentReached.promise);
		await withDeadline(world.trace, `${label}: prefix parent idle`, session.waitForForegroundIdle());
		expect(
			ledger?.medianWorkerPrefixTokens(0),
			`${label}: actual worker request records its fixed prefix`,
		).toBeGreaterThan(0);
		const beforeRequests = world.provider.requests.length;
		world.systemOne.enterPhase(`${label}-held-minion`, judgments.route);
		world.provider.enqueue(
			"worker-a",
			{
				...calls(`${label}-held-read`, [{ id: `${label}-a-read`, name: "read", arguments: { path: LIMITS_PATH } }]),
				gate: release.promise,
				check: () => held.release(),
			},
			readReportStep(`${label}-a-report`, aReport),
		);
		pass = session.continueGoalOnce({ maxStallTurns: 20 });
		await withDeadline(world.trace, `${label}: actual priced minion provider request`, held.promise);
		const controller = session.objectiveExecutionController;
		expect(controller?.getLastRoute()).toMatchObject({
			route: "retrieve",
			reason_codes: expect.arrayContaining(["system_one_preflight_retrieve"]),
		});
		const lastDecision = ledger?.recentRoutes(manager.getSessionId(), goalObjectiveId(a.goalId), 1).at(-1);
		expect(lastDecision?.executor, `${label}: production price owner selects worker`).toBe("worker");
		expect(world.provider.requests.slice(beforeRequests).map((request) => request.model.id)).toEqual(["worker-a"]);
		const running = session
			.getLaneRecords()
			.find((record) => record.status === "running" && record.goalId === a.goalId);
		expect(running, `${label}: original A minion has a real running lane`).toBeDefined();
		await expect(session.reload(), `${label}: writer truthfully refuses retained worker readers`).rejects.toThrow(
			`Cannot reload while background work is in flight: lane:worker:${running?.laneId}`,
		);
		expect(reloads, `${label}: refused writer never enters replacement lifecycle`).toBe(0);
		const replacement = replaceGoal(
			{ goalId: `${label}-b`, userGoal: bWords, tokenBudget: 1_000_000 },
			new Date().toISOString(),
		);
		if (!replacement.ok) throw new Error(replacement.error);
		session.saveGoalStateSnapshot(replacement.state);
		const bBefore = session.getGoalStateSnapshot();
		const beforeEntries = manager.getBranch().length;
		release.release();
		const stale = await withDeadline(world.trace, `${label}: old minion and route settle`, pass);
		expect(stale.submitted, `${label}: old retrieval submits no root work`).toBe(false);
		await withDeadline(world.trace, `${label}: stale handoff persistence settles`, session.waitForForegroundIdle());
		expect(session.getGoalStateSnapshot(), `${label}: accepted A terminal cannot charge or change B`).toEqual(
			bBefore,
		);
		expect(
			world.provider.requests.slice(beforeRequests).map((request) => request.model.id),
			`${label}: accepted A report starts no B provider turn`,
		).toEqual(["worker-a", "worker-a"]);
		expect(session.getLaneRecords().find((record) => record.laneId === running?.laneId)).toMatchObject({
			status: "succeeded",
			goalId: a.goalId,
		});
		expect(
			session.getWorkerClaimSnapshots().some((claim) => claim.summary === aReport),
			`${label}: accepted A terminal claim is retained`,
		).toBe(true);
		expect(
			manager
				.getBranch()
				.slice(beforeEntries)
				.filter((entry) => entry.type === "custom_message" && entry.customType === GATHERED_EVIDENCE_CUSTOM_TYPE),
			`${label}: stale gathered context has no durable publication`,
		).toEqual([]);

		const {
			step_relevant: _stepRelevant,
			evidence_sufficient_to_act: _evidenceSufficientToAct,
			unsupported_assumption_present: _unsupportedAssumptionPresent,
			route: _preflightRoute,
			...workerRetrievalJudgments
		} = judgments.first;
		world.systemOne.enterPhase(`${label}-b-retrieval`, workerRetrievalJudgments);
		world.provider.enqueue(
			"worker-a",
			calls(`${label}-b-read`, [{ id: `${label}-b-read`, name: "read", arguments: { path: LIMITS_PATH } }]),
			readReportStep(`${label}-b-report`, bReport),
		);
		world.provider.enqueue("root", {
			...accountedText(`${label}-b-parent`, "The current worker note is available."),
			check: () => bParentReached.release(),
		});
		const bControl = await withDeadline(
			world.trace,
			`${label}: current B retrieval`,
			session.continueGoalOnce({ maxStallTurns: 20 }),
		);
		expect(bControl.submitted, `${label}: normal retrieval gathers through a worker`).toBe(false);
		expect(controller?.getLastRoute()).toMatchObject({
			route: "retrieve",
			reason_codes: expect.arrayContaining(["system_one_preflight_retrieve"]),
		});
		expect(
			ledger?.recentRoutes(manager.getSessionId(), goalObjectiveId(replacement.state.goalId), 1).at(-1)?.executor,
			`${label}: current B uses the real worker executor`,
		).toBe("worker");
		await withDeadline(world.trace, `${label}: B parent notified`, bParentReached.promise);
		await withDeadline(world.trace, `${label}: B parent idle`, session.waitForForegroundIdle());
		world.systemOne.enterPhase(
			`${label}-consume-current-context`,
			Object.fromEntries(Object.entries(judgments.later).filter(([id]) => !(id in judgments.route))),
		);
		const final = "The current source boundary remains under inspection.";
		world.provider.enqueue("root", {
			...accountedText(`${label}-consume-current-context`, final),
			check: (request) => {
				const wire = JSON.stringify(request.context.messages);
				expect(
					wire.split("Gathered evidence:").length - 1,
					`${label}: exactly B gathered context reaches the real root request`,
				).toBe(1);
				expect(wire).toContain(bWords);
			},
		});
		await withDeadline(
			world.trace,
			`${label}: root consumes B gathered evidence`,
			session.prompt("Continue the current source inspection.", {
				internalContextType: "goal-retrieval-control",
				processSlashCommands: false,
				autoContinueGoal: false,
			}),
		);
		const gathered = manager
			.getBranch()
			.filter((entry) => entry.type === "custom_message" && entry.customType === GATHERED_EVIDENCE_CUSTOM_TYPE);
		expect(gathered, `${label}: exactly one gathered evidence message persists`).toHaveLength(1);
		expect(JSON.stringify(gathered)).toContain(bReport);
		expect(JSON.stringify(gathered)).not.toContain(aReport);
		expect(
			manager
				.getBranch()
				.filter(
					(entry) =>
						entry.type === "message" &&
						entry.message.role === "assistant" &&
						entry.message.content.some((part) => part.type === "text" && part.text === final),
				),
			`${label}: normal B consumption has one durable final response`,
		).toHaveLength(1);
		world.systemOne.enterPhase(`${label}-normal-reload`, {});
		await withDeadline(world.trace, `${label}: normal-order replacement`, session.reload());
		expect(reloads, `${label}: idle normal-order reload enters actual lifecycle once`).toBe(1);
		expect(errors, `${label}: no extension callback errors`).toEqual([]);
		expect(
			world.modelRegistry.find(HARNESS_PROVIDER, "root")?.cost.input,
			`${label}: global world pricing is unchanged`,
		).toBe(0);
	} catch (error) {
		failures.push(error);
	} finally {
		release.release();
		if (pass)
			try {
				await withDeadline(world.trace, `${label}: released minion physically settles`, pass);
			} catch (error) {
				if (!failures.includes(error)) failures.push(error);
			}
		try {
			expect(await world.disposeSessionInBody(session), `${label}: root disposes without held work`).toBeUndefined();
		} catch (error) {
			failures.push(error);
		}
	}
	if (failures.length === 1) throw failures[0];
	if (failures.length > 1) throw new AggregateError(failures, `${label}: invariant and cleanup failures`);
	world.trace.mark("root", label);
}

/** A report is scripted only after the actual worker request carries its successful source read. */
function readReportStep(name: string, summary: string): ScriptStep {
	return {
		...calls(name, [{ id: name, name: "submit_report", arguments: { status: "completed", summary } }]),
		check: (request) => {
			const read = latestBatchResults(request).find((result) => result.toolName === "read");
			expect(read?.isError, `${name}: actual worker read succeeded`).toBe(false);
			expect(read?.text, `${name}: report cites the current source receipt`).toContain("MAX_RETRIES = 5");
		},
	};
}

/** The scripted external provider accounts its actual request shape using the production estimator. */
function accountedText(name: string, answer: string): ScriptStep {
	return {
		name,
		reply: (request) => {
			const usage = createEmptyUsage();
			usage.input = estimateProviderRequestTokens(request.context, request.model);
			usage.output = 16;
			usage.totalTokens = usage.input + usage.output;
			calculateCost(request.model, usage);
			return { content: [{ type: "text", text: answer }], usage };
		},
	};
}
