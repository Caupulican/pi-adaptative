import "../builtin-install.ts";
import { expect, vi } from "vitest";
import { stateFile } from "../../../../src/core/agent-paths.ts";
import type { AgentSession } from "../../../../src/core/agent-session.ts";
import { decodeOwnerDecisionSeen } from "../../../../src/core/owner-decisions/owner-decision-queue.ts";
import {
	OWNER_RETURN_BRIEF_CUSTOM_TYPE,
	RETURN_BRIEF_CLEARED_TEXT,
} from "../../../../src/core/owner-decisions/return-brief.ts";
import { RETURN_BRIEF_IDLE_GAP_MS } from "../../../../src/core/owner-decisions/return-brief-controller.ts";
import { buildChangeQuiz, scoreChangeQuiz } from "../../../../src/core/proof/change-quiz.ts";
import { latestProofSheet, proofSheetsAwaitingReview } from "../../../../src/core/proof/review-gauge.ts";
import { appendOwnerFollowUp, ownerFollowUpPath } from "../../../../src/core/system-one/owner-question-routing.ts";
import { routeShellContract } from "../../../../src/core/tools/shell-contract-router.ts";
import { TRANSIENT_RECORD_SUPERSEDING_NOTE } from "../../../../src/kernel/index.ts";
import { handleQuizCommand } from "../../../../src/modes/interactive/quiz-commands.ts";
import { calls, createBarrier, text } from "../scripted-provider.ts";
import { HARNESS_PROJECT_CWD, type HarnessWorld, projectPath, withDeadline } from "../session-fixture.ts";
import { ICM_INTAKE_JUDGMENTS, latestBatchResults, NO_DELIVERY_CLAIMS, requestTexts } from "./shared.ts";

const OPERATION_PROCEED_JUDGMENTS = {
	leaves_machine: { kind: "noul", probability: 0.02 },
	cannot_be_undone: { kind: "noul", probability: 0.02 },
	touches_outside_task: { kind: "noul", probability: 0.02 },
	acquires_external_code: { kind: "noul", probability: 0.02 },
	request_authorizes: { kind: "noul", probability: 0.02 },
} as const;

const TOKEN_VERIFY_REL = "src/auth/token-verify.ts";
const TOKEN_AUDIT_REL = "src/auth/token-audit.ts";
const CHECK_PASS_CMD = "npx biome check src/auth/token-verify.ts";
const CHECK_FAIL_CMD = "npx vitest run src/auth/token-audit.test.ts";
const CHECK_SKIPPED_CMD = "npx tsc --noEmit";
const ASSUMPTION_CLAIM = "Clock skew between token issuer and verifier stays within 30 seconds.";

function buildTokenVerifySource(): string {
	const lines = [
		"export interface VerifiedTokenClaims {",
		"\treadonly sub: string;",
		"\treadonly aud: string;",
		"\treadonly exp: number;",
		"\treadonly iat: number;",
		"\treadonly jti: string;",
		"}",
		"",
		"export const MAX_CLOCK_SKEW_SECONDS = 30;",
		"",
	];
	for (let index = 1; index <= 26; index++) {
		lines.push(`export const AUTH_CLAIM_GUARD_${index} = "guard-${index}";`);
	}
	return `${lines.join("\n")}\n`;
}

function latestCustomMessageText(messages: AgentSession["messages"], customType: string): string | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message?.role !== "custom" || message.customType !== customType) continue;
		return typeof message.content === "string"
			? message.content
			: message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
	}
	return undefined;
}

async function runProofSheetAndQuizSubleg(world: HarnessWorld): Promise<void> {
	const { trace } = world;
	const agentDir = `${world.agentDir}-proof-quiz`;
	const authScopeDir = projectPath("src", "auth");
	const verifyPath = projectPath("src", "auth", "token-verify.ts");
	const auditPath = projectPath("src", "auth", "token-audit.ts");
	const warningMark = world.warnings.length;
	const wakeBarrier = createBarrier();

	const created = await world.createRootSession("root", {
		agentDir,
		sessionManager: world.createSessionManager(agentDir),
		omitShellOperations: false,
		settings: {
			memorySystem: "okf",
			autoLearn: { enabled: false },
			proactivity: { enabled: false },
			workerDelegation: { outcomes: { escalation: { maxRungs: 0 } } },
		},
	});
	const session = created.session;

	try {
		const passRoute = routeShellContract(CHECK_PASS_CMD, process.platform, { pythonEngine: false });
		const failRoute = routeShellContract(CHECK_FAIL_CMD, process.platform, { pythonEngine: false });
		if (passRoute.kind === "unsupported") throw new Error(passRoute.error);
		if (failRoute.kind === "unsupported") throw new Error(failRoute.error);
		world.shell.enqueue(
			{
				name: "proof-quiz-biome-pass",
				command: passRoute.command,
				cwd: HARNESS_PROJECT_CWD,
				output: "Checked 1 file in 8ms. No fixes applied.\n",
				exitCode: 0,
			},
			{
				name: "proof-quiz-vitest-fail",
				command: failRoute.command,
				cwd: HARNESS_PROJECT_CWD,
				output: "FAIL src/auth/token-audit.test.ts > retention policy missing\n",
				exitCode: 1,
			},
		);

		world.provider.enqueue(
			"root",
			calls("proof-quiz-start", [
				{
					id: "proof-quiz-delegate-1",
					name: "delegate",
					arguments: {
						action: "start",
						model: { provider: "harness-script", modelId: "worker-a" },
						writePaths: [authScopeDir],
						requirementIds: ["req-token-verify", "req-token-audit"],
						instructions: "PROOF-QUIZ-TASK: implement token verification and audit helpers under src/auth.",
					},
				},
			]),
			{
				name: "proof-quiz-started-reply",
				check: (request) => {
					const started = latestBatchResults(request).find((result) => result.toolName === "delegate");
					if (started?.isError || !started?.text.includes("delegate started (running)")) {
						throw new Error(`proof-quiz worker failed to start: ${started?.text ?? "missing"}`);
					}
				},
				reply: { content: [{ type: "text", text: "Dispatched auth verification worker." }] },
			},
			{
				name: "proof-quiz-handoff",
				maxRequests: 6,
				until: (request) => {
					const arrived = JSON.stringify(request.context.messages).includes("Background worker terminal handoff");
					if (arrived) wakeBarrier.release();
					return arrived;
				},
				reply: { content: [{ type: "text", text: "Reviewed worker handoff." }] },
			},
		);

		world.provider.enqueueTrack(
			"proof-quiz-worker",
			"worker-a",
			(request) => JSON.stringify(request.context.messages).includes("PROOF-QUIZ-TASK"),
			calls("proof-quiz-write-and-pass-check", [
				{
					id: "pq-write-verify",
					name: "write",
					arguments: { path: verifyPath, content: buildTokenVerifySource() },
				},
				{
					id: "pq-write-audit",
					name: "write",
					arguments: {
						path: auditPath,
						content:
							'export interface TokenAuditRecord {\n\treadonly jti: string;\n}\nexport const TOKEN_AUDIT_PREFIX = "audit:";\n',
					},
				},
				{
					id: "pq-check-pass",
					name: "bash",
					arguments: { command: CHECK_PASS_CMD },
				},
			]),
			calls("proof-quiz-fail-check", [
				{
					id: "pq-check-fail",
					name: "bash",
					arguments: { command: CHECK_FAIL_CMD },
				},
			]),
			calls("proof-quiz-submit-report", [
				{
					id: "pq-submit",
					name: "submit_report",
					arguments: {
						status: "completed",
						summary:
							"Implemented token claim guards (36 lines) and audit record prefix; retention window needs owner policy.",
						requirements: [
							{
								id: "req-token-verify",
								status: "met",
								evidence: [TOKEN_VERIFY_REL],
							},
							{
								id: "req-token-audit",
								status: "partial",
								note: "Audit test fails until owner chooses retention window.",
							},
						],
						checks: [
							{ command: CHECK_PASS_CMD, result: "passed" },
							{ command: CHECK_FAIL_CMD, result: "failed" },
							{ command: CHECK_SKIPPED_CMD, result: "not_run" },
						],
						changes: [
							{
								file: TOKEN_VERIFY_REL,
								what: "Adds claim verification guards and 30s clock-skew bound.",
								serves: ["req-token-verify"],
							},
							{
								file: TOKEN_AUDIT_REL,
								what: "Adds audit event formatter pending retention policy.",
								serves: ["req-token-audit"],
							},
						],
						assumptions: [ASSUMPTION_CLAIM],
					},
				},
			]),
		);

		world.systemOne.enterPhase("proof-quiz-worker-run", {
			...ICM_INTAKE_JUDGMENTS,
			...OPERATION_PROCEED_JUDGMENTS,
			...NO_DELIVERY_CLAIMS,
		});
		await withDeadline(
			trace,
			"proof-quiz root start turn",
			session.prompt("Implement token verification and audit helpers under src/auth."),
		);
		await withDeadline(trace, "proof-quiz worker handoff delivered", wakeBarrier.promise, 90_000);
		await withDeadline(trace, "proof-quiz root idle", session.waitForForegroundIdle());

		const branch = created.sessionManager.getBranch();
		const waitingSheets = proofSheetsAwaitingReview(branch);
		expect(waitingSheets, "completed worker delivery attaches one proof sheet awaiting review").toHaveLength(1);

		const sheet = latestProofSheet(branch);
		expect(sheet).toBeDefined();
		expect(sheet?.level, "failed check + unrun check elevate proof stakes to high").toBe("high");
		expect(sheet?.changedFiles).toEqual([TOKEN_VERIFY_REL, TOKEN_AUDIT_REL]);
		expect(sheet?.uncheckedFiles, "token-audit.ts was not named by a passing check").toEqual([TOKEN_AUDIT_REL]);
		expect(sheet?.coveredRequirementIds).toEqual(["req-token-verify"]);
		expect(sheet?.uncoveredRequirementIds).toEqual(["req-token-audit"]);
		expect(sheet?.assumptions).toEqual([ASSUMPTION_CLAIM]);
		expect(sheet?.commandCount).toBe(2);
		expect(sheet?.failedCommands).toBe(1);
		expect(sheet?.text).toContain("/quiz");

		const builtQuiz = buildChangeQuiz(sheet);
		expect(builtQuiz.ok).toBe(true);
		if (!builtQuiz.ok) throw new Error(builtQuiz.reason);
		expect(builtQuiz.questions.length).toBeGreaterThanOrEqual(4);

		// Answer every question right except the last one so `/quiz` exercises both right and wrong scoring explanations.
		const pickedLabels = builtQuiz.questions.map((question, index) => {
			if (index < builtQuiz.questions.length - 1) return question.answer;
			const wrongOption = question.options.find((option) => option.label !== question.answer);
			return wrongOption?.label ?? question.answer;
		});

		world.humanInput.enqueue({
			name: "proof-quiz-panel-answers",
			reply: {
				answers: builtQuiz.questions.map((question, index) => ({
					id: question.id,
					header: question.header,
					question: question.question,
					selected: [pickedLabels[index]!],
					skipped: false,
				})),
				cancelled: false,
				imageContents: [],
			},
		});

		const shownTexts: string[] = [];
		const shownErrors: string[] = [];
		await handleQuizCommand(
			{
				latestProofSheet: () => latestProofSheet(created.sessionManager.getBranch()),
				askQuestions: world.humanInput.ui.askQuestions,
				showText: (rendered) => shownTexts.push(rendered),
				showError: (err) => shownErrors.push(err),
			},
			"/quiz",
		);
		await withDeadline(trace, "proof-quiz human input settled", world.humanInput.join());

		expect(shownErrors).toEqual([]);
		expect(shownTexts).toHaveLength(1);
		const expectedScore = scoreChangeQuiz(builtQuiz.questions, pickedLabels);
		expect(shownTexts[0]).toContain(expectedScore);
		expect(shownTexts[0]).toContain(`${builtQuiz.questions.length - 1} of ${builtQuiz.questions.length}`);
	} finally {
		expect(await world.disposeSessionInBody(session), "proof-quiz session disposes cleanly").toBeUndefined();
		world.io.rmSync(authScopeDir, { recursive: true, force: true });
	}

	expect(world.warnings.slice(warningMark), "proof-quiz subleg emits no unexpected warnings").toEqual([]);
	trace.mark("root", "proof.quiz.done");
}

async function runReturnBriefSubleg(world: HarnessWorld): Promise<void> {
	const { trace } = world;
	const agentDir = `${world.agentDir}-return-brief`;
	const warningMark = world.warnings.length;
	const awayGapMs = RETURN_BRIEF_IDLE_GAP_MS + 5 * 60_000;
	const baseNow = Date.now();
	const turn1At = baseNow - awayGapMs;
	const awayCommitAtSec = Math.floor((turn1At + 10 * 60_000) / 1_000);
	const awayFollowUpAtIso = new Date(turn1At + 12 * 60_000).toISOString();

	let created: Awaited<ReturnType<HarnessWorld["createRootSession"]>> | undefined;
	vi.useFakeTimers({ toFake: ["Date"] });
	try {
		vi.setSystemTime(turn1At);
		const manager = world.createSessionManager(agentDir);
		created = await world.createRootSession("root", {
			agentDir,
			sessionManager: manager,
			settings: {
				memorySystem: "okf",
				autoLearn: { enabled: false },
				proactivity: { enabled: false },
			},
		});
		world.systemOne.enterPhase("return-brief-turn-1", {});
		world.provider.enqueue("root", text("return-brief-turn-1", "Standing by while you step away."));
		await withDeadline(
			trace,
			"return-brief initial owner turn",
			created.session.prompt("Check the workspace before I step away."),
		);
	} finally {
		vi.useRealTimers();
	}

	const session = created.session;
	const sessionId = created.sessionManager.getSessionId();
	try {
		// While the owner is away (> 30 minutes), record a stamped commit in HARNESS_PROJECT_CWD and an unsettled owner follow-up.
		const awayRelPath = "src/taste/history/return-brief-away.ts";
		world.io.seed(projectPath("src", "taste", "history", "return-brief-away.ts"), "export const AWAY_FIX = 1;\n");
		expect(world.git.run(["add", "--", awayRelPath], HARNESS_PROJECT_CWD).code).toBe(0);
		const commitSubject = "Tighten token leeway while owner away";
		expect(
			world.git.run(["commit", `--date=@${awayCommitAtSec}`, "-m", commitSubject], HARNESS_PROJECT_CWD).code,
		).toBe(0);
		const headSha = world.git.refSha("refs/heads/main");
		expect(headSha).toBeDefined();
		const shortSha = headSha!.slice(0, 7);

		const followUpQuestion = "Should expired refresh tokens revoke the entire token family?";
		appendOwnerFollowUp(ownerFollowUpPath(agentDir, sessionId), {
			question: followUpQuestion,
			reason: "Security policy trade-off reserved for the owner.",
			request: "Check the workspace before I step away.",
			at: awayFollowUpAtIso,
		});

		const statusBeforeReturn = await session.autonomyStatus();
		expect(statusBeforeReturn.ownerDecisions).toMatchObject({
			status: "available",
			value: {
				waiting: 1,
				items: {
					items: [expect.objectContaining({ source: "follow_up", what: followUpQuestion })],
				},
			},
		});

		let surfacedBrief: string | undefined;
		world.systemOne.enterPhase("return-brief-turn-2", {
			carries_0: { kind: "noul", probability: 0.97 },
		});
		world.provider.enqueue("root", {
			name: "return-brief-turn-2",
			check: (request) => {
				surfacedBrief = requestTexts(request).find((entry) => entry.includes("While you were away ("));
			},
			reply: { content: [{ type: "text", text: "Welcome back; noted the new revision and open question." }] },
		});
		await withDeadline(
			trace,
			"return-brief returning owner turn",
			session.prompt("I am back now, summarize what changed."),
		);

		expect(surfacedBrief, "ReturnBriefController injects owner_return_brief on the return turn").toBeDefined();
		expect(latestCustomMessageText(session.messages, OWNER_RETURN_BRIEF_CUSTOM_TYPE)).toBe(surfacedBrief);
		expect(surfacedBrief).toContain("While you were away (");
		expect(surfacedBrief).toContain("- Commits: 1");
		expect(surfacedBrief).toContain(shortSha);
		expect(surfacedBrief).toContain(commitSubject);
		expect(surfacedBrief).toContain("Waiting on you (1):");
		expect(surfacedBrief).toContain(`- [new] ${followUpQuestion}`);

		// Committing the return turn persists the seen-state file for the waiting owner decision.
		const seenPath = stateFile(agentDir, "owner-decisions", `${sessionId}.json`);
		const seenRaw = world.io.peekFile(seenPath);
		expect(seenRaw, "owner decision seen-state is persisted after return brief commit").toBeDefined();
		const seenDecoded = decodeOwnerDecisionSeen(JSON.parse(seenRaw!));
		expect(seenDecoded).toBeDefined();
		expect(Object.keys(seenDecoded!.seen)).toHaveLength(1);
		expect(Object.keys(seenDecoded!.seen)[0]).toMatch(/^follow_up:/u);

		// A subsequent immediate turn (no 30-min gap) clears the transient return brief instead of repeating it.
		const expectedClearedRecord = `${RETURN_BRIEF_CLEARED_TEXT}${TRANSIENT_RECORD_SUPERSEDING_NOTE}`;
		let clearedBrief: string | undefined;
		world.systemOne.enterPhase("return-brief-turn-3", {
			carries_0: { kind: "noul", probability: 0.97 },
		});
		world.provider.enqueue("root", {
			name: "return-brief-turn-3",
			check: (request) => {
				const texts = requestTexts(request);
				expect(texts.filter((entry) => entry.includes("While you were away ("))).toHaveLength(1);
				clearedBrief = texts.find((entry) => entry === expectedClearedRecord);
			},
			reply: { content: [{ type: "text", text: "Revoking the whole token family." }] },
		});
		await withDeadline(
			trace,
			"return-brief follow-on turn",
			session.prompt("Yes, revoke the whole token family on expiry."),
		);
		expect(clearedBrief, "follow-on turn replaces the past return brief with the cleared marker").toBe(
			expectedClearedRecord,
		);
		expect(latestCustomMessageText(session.messages, OWNER_RETURN_BRIEF_CUSTOM_TYPE)).toBe(expectedClearedRecord);
	} finally {
		expect(await world.disposeSessionInBody(session), "return-brief session disposes cleanly").toBeUndefined();
	}

	expect(world.warnings.slice(warningMark), "return-brief subleg announces the recorded follow-up once").toEqual([
		`Owner follow-ups are recorded in ${ownerFollowUpPath(agentDir, sessionId)}. Review them before relying on unresolved decisions.`,
	]);
	trace.mark("root", "return.brief.done");
}

/**
 * Proof Sheet + `/quiz` comprehension scoring and `ReturnBriefController` idle-gap brief + seen-state persistence.
 */
export async function runJourney1ProofAndReturnBriefPhase(world: HarnessWorld): Promise<void> {
	await runProofSheetAndQuizSubleg(world);
	await runReturnBriefSubleg(world);
}
