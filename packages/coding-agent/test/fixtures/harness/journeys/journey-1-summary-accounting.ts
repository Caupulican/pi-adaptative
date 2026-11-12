import { sep } from "node:path";
import { createEmptyUsage } from "@caupulican/pi-ai";
import { expect } from "vitest";
import { continuousChatSpendFile } from "../../../../src/core/agent-paths.ts";
import { journalSlotOf } from "../../../../src/core/cost/semantic-usage-journal.ts";
import { createSessionManagerLedgerPort } from "../../../../src/core/cost/session-ledger-port.ts";
import { SEMANTIC_USAGE_CUSTOM_TYPE } from "../../../../src/core/cost/usage-records.ts";
import { CONTINUOUS_CHAT_FOREGROUND_QUIET_MS } from "../../../../src/core/memory/continuous-chat-runtime.ts";
import { createBarrier, text } from "../scripted-provider.ts";
import { type HarnessWorld, projectPath, withDeadline } from "../session-fixture.ts";
import { runSummaryPricingJourney } from "./journey-1-summary-pricing.ts";
import {
	crashCutChecks,
	expectOwnerWords,
	ICM_INTAKE_JUDGMENTS,
	icmContinuousSettings,
	icmContinuousStore,
	icmReadContinuousNodes,
	icmReadContinuousRecords,
	icmReadScheduler,
} from "./shared.ts";

const ACCOUNTING_HOLD = "Memory summaries wait for response usage accounting to recover.";
const ACCOUNTING_STORAGE = "Memory summaries wait for accounting storage.";
const UNKNOWN_HANDOFF =
	"Usage handoff: 0 usage report(s) pending in the session journal, 0 not retained, 0 confirmed row(s) with a journal copy left, 0 unmatched journal(s), 1 request(s) with unknown usage; none is charged to another session.";
const MISSING_USAGE = "Continuous-chat compaction 0+1 failed: The provider ended without reporting measured usage.";
const CAP_HOLD =
	"Memory summaries are paused for today: they have used $0.25 of the $0.10 daily limit. They resume tomorrow or as soon as the limit is raised, and the full history stays readable.";

/** Consume only a diagnostic the witness asserts, including its occurrence count. */
function consumeWarning(world: HarnessWorld, mark: number, message: string, count: number): void {
	const matches = world.warnings.slice(mark).filter((line) => line === message);
	expect(matches, `expected diagnostic: ${message}`).toHaveLength(count);
	for (let i = 0; i < count; i++) world.warnings.splice(world.warnings.indexOf(message, mark), 1);
}

type AccountingTimerSnapshot = ReturnType<HarnessWorld["timers"]["armedSnapshot"]>;
/** Each case proves the resulting dispatch, receipt, or scheduler boundary. Timer allocation is shared by all owners. */
function enterAccountingPhase(world: HarnessWorld, name: string): void {
	world.systemOne.enterPhase(name, {});
}

/** Let the quiet window elapse; concurrent owners may have their own alarms on the same clock. */
function endAccountingQuiet(world: HarnessWorld, _label: string): void {
	world.timers.advance("continuous-chat", CONTINUOUS_CHAT_FOREGROUND_QUIET_MS);
}

/** A durable unknown is an account-wide fence, not an outstanding local settlement retry. */
function assertUnknownDisposalTimers(
	before: AccountingTimerSnapshot,
	after: AccountingTimerSnapshot,
	label: string,
): void {
	expect(
		after,
		`${label}: no retry survives disposal; before=${JSON.stringify(before)} after=${JSON.stringify(after)}`,
	).toEqual([]);
}

/** Wait for committed chat and scheduler state without driving any timer or silently consuming a retry. */
async function waitAccountingIdle(world: HarnessWorld, agentDir: string, expectedMessages: number): Promise<void> {
	const store = icmContinuousStore(agentDir);
	await withDeadline(
		world.trace,
		`accounting chat idle (${expectedMessages})`,
		world.io.waitForMutation(() => {
			const raw = world.io.peekFile(store.rootFile);
			if (!raw) return false;
			const root = JSON.parse(raw) as { nextId: number };
			const queue = icmReadScheduler(world, store);
			return (
				root.nextId >= expectedMessages &&
				queue !== undefined &&
				queue.totalMessages === root.nextId &&
				queue.running === 0 &&
				queue.readyLeaves === 0 &&
				queue.readyParents === 0 &&
				queue.blocked === 0
			);
		}),
		60_000,
	);
}

/** A tool-free seed turn's words are classified when this same session receives its next owner input. */
function enterFollowup(
	world: HarnessWorld,
	phase: string,
	manager: Parameters<typeof createSessionManagerLedgerPort>[0],
	previous: string,
): void {
	world.systemOne.enterPhase(
		phase,
		{ ...ICM_INTAKE_JUDGMENTS, carries_0: { kind: "noul", probability: 0.02 } },
		{
			expect: expectOwnerWords({
				sessionManager: () => manager,
				userRequests: [previous],
				ownerMessages: [previous],
				optionalToolNames: ["secret_store"],
			}),
		},
	);
}

/** A physical unmeasured summary must fence later scheduled work, even after the session is reopened. */
export async function runSummaryAccountingJourney(world: HarnessWorld): Promise<void> {
	const entryClock = world.timers.port("continuous-chat").now();
	const originalModel = world.provider.model("worker-c");
	world.setModelReasoning("worker-c", true, { xhigh: "xhigh" });
	const agentDir = `${world.agentDir}-icm-accounting-unknown`;
	const settings = icmContinuousSettings();
	const manager = world.createSessionManager(agentDir);
	const first = await world.createRootSession("root", { agentDir, sessionManager: manager, settings });
	const spendFile = continuousChatSpendFile(agentDir);
	const state = () => {
		const raw = world.io.peekFile(spendFile);
		return raw === undefined
			? undefined
			: (JSON.parse(raw) as {
					circuits: Record<string, { status: string; token: string }>;
				});
	};
	const warningMark = world.warnings.length;
	const requestMark = world.provider.reached.length;
	world.provider.enqueue("root", text("accounting-unknown-owner", "Recorded."));
	world.provider.enqueue("worker-c", {
		name: "accounting-unknown-physical-response",
		reply: { content: [{ type: "text", text: "owner: accounting witness." }], usage: createEmptyUsage() },
	});
	enterAccountingPhase(world, "icm-accounting-unknown");
	await withDeadline(
		world.trace,
		"accounting unknown owner turn",
		first.session.prompt(`Remember ${"u".repeat(600)}`),
	);
	endAccountingQuiet(world, "accounting foreground");
	await withDeadline(
		world.trace,
		"unknown physical response fenced",
		world.io.waitForMutation(() =>
			Object.values(state()?.circuits ?? {}).some((circuit) => circuit.status === "unknown"),
		),
		60_000,
	);
	await withDeadline(
		world.trace,
		"unknown summary leaves its scheduler claim",
		world.io.waitForMutation(() => {
			const queue = icmReadScheduler(world, icmContinuousStore(agentDir));
			return queue !== undefined && queue.running === 0 && queue.blocked > 0;
		}),
		60_000,
	);
	const unknown = Object.values(state()!.circuits).find((circuit) => circuit.status === "unknown")!;
	const sessionFile = manager.getSessionFile();
	if (!sessionFile) throw new Error("Accounting journey requires a persisted session file.");
	const slot = journalSlotOf(createSessionManagerLedgerPort(manager).identity());
	if (!slot) throw new Error("Unknown usage requires its persisted journal slot.");
	const journal = JSON.parse(world.io.peekFile(slot.path)!) as {
		sessionId: string;
		unresolved: Array<{ requestId: string; summarySpendPending: boolean }>;
	};
	expect(journal.sessionId).toBe(manager.getSessionId());
	expect(journal.unresolved).toContainEqual(
		expect.objectContaining({ requestId: unknown.token, summarySpendPending: true }),
	);
	const beforeFirstDisposal = world.timers.armedSnapshot("continuous-chat");
	expect(await world.disposeSessionInBody(first.session)).toBeUndefined();
	const afterFirstDisposal = world.timers.armedSnapshot("continuous-chat");
	assertUnknownDisposalTimers(beforeFirstDisposal, afterFirstDisposal, "unknown first owner");

	const holdMark = world.warnings.length;
	const resumed = await world.createRootSession("root", {
		agentDir,
		sessionManager: world.openSessionManager(sessionFile, agentDir),
		settings,
	});
	world.provider.enqueue("root", text("accounting-after-restart-owner", "Still recorded."));
	// A fresh session controller does not restore the previous controller's in-memory ownerWords backlog.
	enterAccountingPhase(world, "icm-accounting-after-restart");
	await withDeadline(
		world.trace,
		"accounting owner after restart",
		resumed.session.prompt(`Also remember ${"v".repeat(600)}`),
	);
	endAccountingQuiet(world, "unknown reopened foreground");
	await withDeadline(
		world.trace,
		"reopened chat reports unresolved accounting hold",
		world.whenWarnings(holdMark, (seen) => seen.includes(ACCOUNTING_STORAGE)),
		60_000,
	);
	const store = icmContinuousStore(agentDir);
	const nextWords = `Also remember ${"v".repeat(600)}`;
	await withDeadline(
		world.trace,
		"reopened owner turn is published to the continuous chat",
		world.io.waitForMutation(() => {
			const records = icmReadContinuousRecords(world, store);
			return (
				records.some((record) => record.id === 2 && record.kind === "user" && record.text.includes(nextWords)) &&
				records.some((record) => record.id === 3 && record.kind === "pi" && record.text.includes("Still recorded."))
			);
		}),
		60_000,
	);
	const newRecords = icmReadContinuousRecords(world, store).filter((record) => record.id === 2 || record.id === 3);
	expect(
		newRecords.map((record) => [record.id, record.kind]),
		"the durable chat holds the next turn exactly once",
	).toEqual([
		[2, "user"],
		[3, "pi"],
	]);
	expect(
		Buffer.byteLength(newRecords[0]!.text, "utf8"),
		"the new user record requires model compaction",
	).toBeGreaterThan(512);
	expect(
		icmReadContinuousNodes(world, store).some((node) => node.level === 0 && node.ordinal === 2),
		"the hold leaves the new long record without a published summary leaf",
	).toBe(false);
	expect(
		world.provider.reached.slice(requestMark).filter((step) => step.startsWith("worker-c:")),
		"reopening and scheduling more work never sends a second physical summary",
	).toEqual(["worker-c:accounting-unknown-physical-response"]);
	expect(Object.values(state()!.circuits)).toContainEqual(
		expect.objectContaining({ status: "unknown", token: unknown.token }),
	);
	const beforeResumedDisposal = world.timers.armedSnapshot("continuous-chat");
	expect(await world.disposeSessionInBody(resumed.session)).toBeUndefined();
	const afterResumedDisposal = world.timers.armedSnapshot("continuous-chat");
	assertUnknownDisposalTimers(beforeResumedDisposal, afterResumedDisposal, "unknown reopened owner");
	consumeWarning(world, warningMark, MISSING_USAGE, 1);
	consumeWarning(world, warningMark, ACCOUNTING_STORAGE, 2);
	consumeWarning(world, warningMark, UNKNOWN_HANDOFF, 2);

	// Negative control: a measured physical reply with explicit zero prices does not fence the following summary.
	const controlDir = `${world.agentDir}-icm-accounting-measured`;
	const control = await world.createRootSession("root", {
		agentDir: controlDir,
		sessionManager: world.createSessionManager(controlDir),
		settings,
	});
	const usage = { ...createEmptyUsage(), input: 1, output: 1, totalTokens: 2 };
	world.provider.enqueue("worker-c", {
		name: "accounting-measured-control-a",
		reply: { content: [{ type: "text", text: "owner: first." }], usage },
	});
	world.provider.enqueue("root", text("accounting-measured-owner-a", "Recorded."));
	enterAccountingPhase(world, "icm-accounting-measured-a");
	await withDeadline(
		world.trace,
		"measured accounting owner turn",
		control.session.prompt(`Remember ${"a".repeat(600)}`),
	);
	endAccountingQuiet(world, "measured first foreground");
	await waitAccountingIdle(world, controlDir, 2);
	world.provider.enqueue("worker-c", {
		name: "accounting-measured-control-b",
		reply: { content: [{ type: "text", text: "owner: second." }], usage },
	});
	world.provider.enqueue("root", text("accounting-measured-owner-b", "Recorded again."));
	enterFollowup(world, "icm-accounting-measured-b", control.sessionManager, `Remember ${"a".repeat(600)}`);
	await withDeadline(
		world.trace,
		"measured accounting next turn",
		control.session.prompt(`Remember ${"b".repeat(600)}`),
	);
	endAccountingQuiet(world, "measured next foreground");
	await waitAccountingIdle(world, controlDir, 4);
	expect(world.provider.reached).toContain("worker-c:accounting-measured-control-b");
	expect(await world.disposeSessionInBody(control.session)).toBeUndefined();
	await runPaidCapRollover(world);
	await runRetainedSettlement(world);
	await runFlightCrashCut(world);
	await runRetainedReceiptCrash(world);
	await runAcknowledgementGap(world);
	await runReservedInterveningHold(world);
	await runUnrelatedUnknownSettlement(world);
	await runSummaryPricingJourney(world, () => endAccountingQuiet(world, "unpriced summary foreground"));
	expect(
		world.timers.armedDelays("continuous-chat"),
		"all accounting owners retire their alarms before restoring the clock",
	).toEqual([]);
	world.timers.advance("continuous-chat", entryClock - world.timers.port("continuous-chat").now());
	expect(world.timers.port("continuous-chat").now()).toBe(entryClock);
	world.setModelReasoning("worker-c", originalModel.reasoning, originalModel.thinkingLevelMap);
}

/** A provider-reported cost reaches the account-wide cap, survives reopening, and rolls at UTC midnight. */
async function runPaidCapRollover(world: HarnessWorld): Promise<void> {
	const agentDir = `${world.agentDir}-icm-accounting-cap`;
	const settings = icmContinuousSettings("worker-c", {
		memorySystem: "icm",
		contextPolicy: {
			memory: {
				history: {
					summaryModel: "harness-script/worker-c",
					allowExternalSummaryEgress: true,
					compactionMaxUsdPerDay: 0.1,
				},
			},
		},
	});
	const manager = world.createSessionManager(agentDir);
	const owner = await world.createRootSession("root", { agentDir, sessionManager: manager, settings });
	const spendFile = continuousChatSpendFile(agentDir);
	const readSpend = () =>
		JSON.parse(world.io.peekFile(spendFile) ?? "null") as {
			day: string;
			usd: number;
			archivedMeasuredUsd: number;
			circuits: Record<string, { status: string; token: string; pendingAck?: unknown }>;
		} | null;
	const empty = createEmptyUsage();
	// The scripted model declares zero rates; this is a physical provider-reported charge, which the
	// response accounting owner passes to the spend meter directly, not an estimated model price.
	const paid = { ...empty, input: 1, output: 1, totalTokens: 2, cost: { ...empty.cost, input: 0.25, total: 0.25 } };
	const warningMark = world.warnings.length;
	const paidRequestMark = world.provider.reached.length;
	world.provider.enqueue("worker-c", {
		name: "accounting-cap-paid",
		reply: {
			content: [{ type: "text", text: "owner: paid." }],
			usage: paid,
		},
	});
	world.provider.enqueue("root", text("accounting-cap-owner-a", "Recorded."));
	enterAccountingPhase(world, "icm-accounting-cap-a");
	await withDeadline(world.trace, "paid accounting turn", owner.session.prompt(`Remember ${"c".repeat(600)}`));
	endAccountingQuiet(world, "accounting foreground");
	const store = icmContinuousStore(agentDir);
	const canonicalPaid = () =>
		manager
			.getEntries()
			.filter(
				(entry) =>
					entry.type === "custom" &&
					entry.customType === SEMANTIC_USAGE_CUSTOM_TYPE &&
					typeof entry.data === "object" &&
					entry.data !== null &&
					"route" in entry.data &&
					entry.data.route === "history_summary" &&
					manager.isEntryPersisted(entry.id),
			);
	await withDeadline(
		world.trace,
		"paid leaf is published and remaining work is capped",
		world.io.waitForMutation(() => {
			const state = readSpend();
			const queue = icmReadScheduler(world, store);
			return (
				state?.usd === 0.25 &&
				Object.values(state.circuits).some(
					(circuit) => circuit.status === "settled" && circuit.pendingAck === undefined,
				) &&
				canonicalPaid().length === 1 &&
				icmReadContinuousNodes(world, store).some((node) => node.level === 0 && node.ordinal === 0) &&
				queue !== undefined &&
				queue.totalMessages === 2 &&
				queue.running === 0 &&
				queue.readyLeaves + queue.readyParents > 0
			);
		}),
		60_000,
	);
	await withDeadline(
		world.trace,
		"paid cap warning",
		world.whenWarnings(warningMark, (seen) => seen.includes(CAP_HOLD)),
		60_000,
	);
	const paidEntry = canonicalPaid()[0];
	expect(
		paidEntry?.type === "custom" ? paidEntry.data : undefined,
		"the paid receipt is persisted in the originating session",
	).toMatchObject({
		route: "history_summary",
		reportId: Object.values(readSpend()!.circuits)[0]!.token,
		usage: { cost: { total: 0.25 } },
	});
	expect(world.provider.reached.slice(paidRequestMark).filter((step) => step.startsWith("worker-c:"))).toEqual([
		"worker-c:accounting-cap-paid",
	]);
	expect(readSpend()?.usd, "the actual physical response reaches the shared spend file").toBe(0.25);
	expect(Object.values(readSpend()!.circuits), "the clock witness starts with one fully acknowledged charge").toEqual([
		expect.objectContaining({ status: "settled" }),
	]);
	expect(Object.values(readSpend()!.circuits).every((circuit) => circuit.pendingAck === undefined)).toBe(true);
	const oldDay = readSpend()!.day;
	const sessionFile = manager.getSessionFile();
	if (!sessionFile) throw new Error("Paid accounting journey requires a persisted session.");
	expect(await world.disposeSessionInBody(owner.session)).toBeUndefined();
	const reopenWarningMark = world.warnings.length;
	// Reconciliation reads the settled, non-pending state four times under the spend lock;
	// the fifth locked read is hold()'s cap decision. Shift immediately after that read's
	// validated-day clock sample, so any second sample inside the decision sees yesterday.
	let operationCursor = world.io.operations.length;
	const lockPath = `${spendFile}.lock.lock`;
	const clockCut = world.timers.scriptClockShift(
		"continuous-chat",
		() => {
			const operations = world.io.operations.slice(operationCursor);
			const read = operations.some((operation) => operation.kind === "read" && operation.path === spendFile);
			if (!read || !world.io.captureTree(lockPath).directories.includes(lockPath)) return false;
			operationCursor = world.io.operations.length;
			return true;
		},
		5,
		-86_400_000,
	);
	const reopened = await world.createRootSession("root", {
		agentDir,
		sessionManager: world.openSessionManager(sessionFile, agentDir),
		settings,
	});
	const requestMark = world.provider.reached.length;
	world.provider.enqueue("root", text("accounting-cap-owner-b", "Recorded again."));
	enterAccountingPhase(world, "icm-accounting-cap-b");
	await withDeadline(world.trace, "paid accounting next turn", reopened.session.prompt(`Remember ${"d".repeat(600)}`));
	endAccountingQuiet(world, "accounting foreground");
	await withDeadline(
		world.trace,
		"reopened cap holds queued work",
		world.whenWarnings(reopenWarningMark, (seen) => seen.includes(CAP_HOLD)),
		60_000,
	);
	expect(clockCut.samples, "the fifth sample follows the four reconciliation reads").toBe(5);
	expect(clockCut.before).toBeDefined();
	expect(clockCut.after).toBe(clockCut.before! - 86_400_000);
	expect(new Date(clockCut.before!).toISOString().slice(0, 10)).toBe(oldDay);
	expect(readSpend()?.usd, "a backward clock does not erase the paid cap").toBe(0.25);
	expect(world.provider.reached.slice(requestMark).filter((step) => step.startsWith("worker-c:"))).toEqual([]);
	// Restore the original day before checking the normal forward rollover control.
	world.timers.advance("continuous-chat", 86_400_000);
	world.provider.enqueue("worker-c", {
		name: "accounting-after-utc-midnight",
		reply: {
			content: [{ type: "text", text: "owner: next day." }],
			usage: { ...empty, input: 1, output: 1, totalTokens: 2 },
		},
	});
	const now = world.timers.port("continuous-chat").now();
	const date = new Date(now);
	const midnight = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1);
	world.timers.advance("continuous-chat", midnight - now + 1);
	await waitAccountingIdle(world, agentDir, 4);
	expect(world.provider.reached.slice(requestMark)).toContain("worker-c:accounting-after-utc-midnight");
	expect(readSpend(), "the old UTC day's charge is archived and does not consume the new day's cap").toMatchObject({
		day: new Date(midnight).toISOString().slice(0, 10),
		usd: 0,
		archivedMeasuredUsd: 0.25,
	});
	expect(readSpend()!.day).not.toBe(oldDay);
	expect(await world.disposeSessionInBody(reopened.session)).toBeUndefined();
	consumeWarning(world, warningMark, CAP_HOLD, 2);
}

/** A receipt survives a refused spend replacement and fences the queued sibling until its retained retry settles. */
async function runRetainedSettlement(world: HarnessWorld): Promise<void> {
	const agentDir = `${world.agentDir}-icm-accounting-retained`;
	const manager = world.createSessionManager(agentDir);
	const owner = await world.createRootSession("root", {
		agentDir,
		sessionManager: manager,
		settings: icmContinuousSettings(),
	});
	const spendFile = continuousChatSpendFile(agentDir);
	let denial: ReturnType<typeof world.io.denyUntilCleared> | undefined;
	const denied = world.io.waitForOperation(
		(operation) => operation.kind === "rename" && operation.destination === spendFile && operation.code === "EIO",
	);
	const empty = createEmptyUsage();
	const paid = { ...empty, input: 1, output: 1, totalTokens: 2, cost: { ...empty.cost, input: 0.25, total: 0.25 } };
	const requestMark = world.provider.reached.length;
	const warningMark = world.warnings.length;
	world.provider.enqueue(
		"worker-c",
		{
			name: "accounting-retained-paid",
			check: () => {
				denial = world.io.denyUntilCleared({
					name: "icm-accounting-spend-replacement",
					kind: "rename",
					matches: (operation) => operation.destination === spendFile,
					code: "EIO",
				});
			},
			reply: { content: [{ type: "text", text: "owner: retained." }], usage: paid },
		},
		{
			name: "accounting-retained-next",
			reply: {
				content: [{ type: "text", text: "pi: next." }],
				usage: { ...empty, input: 1, output: 1, totalTokens: 2 },
			},
		},
	);
	world.provider.enqueue("root", text("accounting-retained-owner", `Reply ${"r".repeat(600)}`));
	enterAccountingPhase(world, "icm-accounting-retained");
	await withDeadline(world.trace, "retained accounting owner", owner.session.prompt(`Remember ${"s".repeat(600)}`));
	endAccountingQuiet(world, "accounting foreground");
	await withDeadline(world.trace, "paid receipt's spend replacement refused", denied, 60_000);
	const state = JSON.parse(world.io.peekFile(spendFile)!) as {
		usd: number;
		circuits: Record<string, { status: string; token: string }>;
	};
	const flight = Object.values(state.circuits).find((circuit) => circuit.status === "flight");
	expect(flight, "the refused spend replacement retains the physical flight fence").toBeDefined();
	expect(state.usd).toBe(0);
	const slot = journalSlotOf(createSessionManagerLedgerPort(manager).identity());
	if (!slot) throw new Error("Retained settlement requires the owning session's sidecar.");
	const receiptJournal = JSON.parse(world.io.peekFile(slot.path)!) as {
		sessionId: string;
		records: Array<{
			reportId: string;
			summarySpendPending: boolean;
			payload: { usage: { cost: { total: number } } };
		}>;
	};
	expect(receiptJournal.sessionId).toBe(manager.getSessionId());
	expect(receiptJournal.records).toContainEqual(
		expect.objectContaining({
			reportId: flight!.token,
			summarySpendPending: true,
			payload: expect.objectContaining({
				usage: expect.objectContaining({ cost: expect.objectContaining({ total: 0.25 }) }),
			}),
		}),
	);
	expect(world.provider.reached.slice(requestMark).filter((step) => step.startsWith("worker-c:"))).toEqual([
		"worker-c:accounting-retained-paid",
	]);
	await withDeadline(
		world.trace,
		"retained receipt's already completed leaf publishes",
		world.io.waitForMutation(() =>
			icmReadContinuousNodes(world, icmContinuousStore(agentDir)).some(
				(node) => node.level === 0 && node.ordinal === 0,
			),
		),
		60_000,
	);
	await withDeadline(
		world.trace,
		"retained storage failure holds further work",
		world.whenWarnings(warningMark, (seen) => seen.includes(ACCOUNTING_STORAGE)),
		60_000,
	);
	const sessionFile = manager.getSessionFile();
	if (!sessionFile || !denial) throw new Error("Retained settlement needs its session and storage denial.");
	expect(await world.disposeSessionInBody(owner.session)).toBeUndefined();
	expect(
		world.timers.armedSnapshot("continuous-chat").map((timer) => timer.delayMs),
		"the real failed spend write keeps its 2s settlement retry after session disposal",
	).toEqual([2_000]);
	// The physical observation is in the sidecar. Keep storage refused into the next UTC day.
	const observedAt = world.timers.port("continuous-chat").now();
	const observedDate = new Date(observedAt);
	const midnight = Date.UTC(observedDate.getUTCFullYear(), observedDate.getUTCMonth(), observedDate.getUTCDate() + 1);
	world.timers.advance("continuous-chat", midnight - observedAt + 1);
	expect(denial.hits).toBeGreaterThan(1);
	expect(world.timers.armedSnapshot("continuous-chat").map((timer) => timer.delayMs)).toEqual([2_000]);
	expect(denial.clear()).toBeGreaterThan(0);
	world.timers.advance("continuous-chat", 2_000);
	await withDeadline(
		world.trace,
		"retired owner's retained charge settles",
		world.io.waitForMutation(() => {
			const raw = world.io.peekFile(spendFile);
			if (!raw) return false;
			const value = JSON.parse(raw) as {
				archivedMeasuredUsd: number;
				circuits: Record<string, { token: string; status: string; pendingAck?: unknown }>;
			};
			return (
				value.archivedMeasuredUsd === 0.25 &&
				Object.values(value.circuits).some(
					(item) => item.token === flight!.token && item.status === "settled" && item.pendingAck === undefined,
				)
			);
		}),
		60_000,
	);
	expect(world.timers.armedSnapshot("continuous-chat"), "retry retires only after storage recovers").toEqual([]);
	const settled = JSON.parse(world.io.peekFile(spendFile)!) as {
		day: string;
		usd: number;
		archivedMeasuredUsd: number;
	};
	expect(settled, "the delayed receipt is charged once to its observed UTC day").toMatchObject({
		day: new Date(midnight).toISOString().slice(0, 10),
		usd: 0,
		archivedMeasuredUsd: 0.25,
	});
	const reopened = await world.createRootSession("root", {
		agentDir,
		sessionManager: world.openSessionManager(sessionFile, agentDir),
		settings: icmContinuousSettings(),
	});
	world.provider.enqueue("root", text("accounting-retained-reopened-owner", "Recorded again."));
	enterAccountingPhase(world, "icm-accounting-retained-reopened");
	await withDeadline(
		world.trace,
		"retained accounting reopened turn",
		reopened.session.prompt("Continue after accounting recovery."),
	);
	endAccountingQuiet(world, "retained reopened foreground");
	await waitAccountingIdle(world, agentDir, 4);
	expect(world.provider.reached.slice(requestMark)).toContain("worker-c:accounting-retained-next");
	expect(await world.disposeSessionInBody(reopened.session)).toBeUndefined();
	consumeWarning(world, warningMark, ACCOUNTING_STORAGE, 1);
}

/** Cut durable bytes while a physical summary is in flight; the replacement process must not resend it. */
async function runFlightCrashCut(world: HarnessWorld): Promise<void> {
	const agentDir = `${world.agentDir}-icm-accounting-crash`;
	const settings = icmContinuousSettings();
	const manager = world.createSessionManager(agentDir);
	const owner = await world.createRootSession("root", { agentDir, sessionManager: manager, settings });
	const gate = createBarrier();
	const reachedMark = world.provider.reached.length;
	let cancelledTerminal: { stopReason: string; totalTokens: number } | undefined;
	world.provider.enqueue("worker-c", {
		name: "accounting-crash-flight",
		gate: gate.promise,
		onTerminal: (_request, message) => {
			cancelledTerminal = { stopReason: message.stopReason, totalTokens: message.usage.totalTokens };
		},
		reply: { content: [{ type: "text", text: "owner: never received." }] },
	});
	world.provider.enqueue("root", text("accounting-crash-owner", "Recorded."));
	enterAccountingPhase(world, "icm-accounting-crash");
	await withDeadline(world.trace, "crash owner turn", owner.session.prompt(`Remember ${"x".repeat(600)}`));
	endAccountingQuiet(world, "accounting foreground");
	await withDeadline(
		world.trace,
		"physical summary reaches crash cut",
		world.provider.whenReached("worker-c:accounting-crash-flight", reachedMark),
		60_000,
	);
	const spendFile = continuousChatSpendFile(agentDir);
	const before = JSON.parse(world.io.peekFile(spendFile)!) as {
		circuits: Record<string, { status: string; token: string; owner: { pid: number } }>;
	};
	const flight = Object.values(before.circuits).find((circuit) => circuit.status === "flight");
	expect(flight?.owner.pid, "the in-flight request belongs to the process being cut").toBe(world.processTable.self);
	const sessionFile = manager.getSessionFile();
	if (!sessionFile || !flight) throw new Error("The crash cut requires a persisted physical flight.");
	const manifest = () =>
		new Map(
			[...world.io.fileEntries()].filter(
				([path]) =>
					(path === agentDir || path.startsWith(`${agentDir}${sep}`)) &&
					(path.endsWith(".json") || path.endsWith(".jsonl")),
			),
		);
	const capture = manifest();
	const slot = journalSlotOf(createSessionManagerLedgerPort(manager).identity());
	if (!slot || !capture.has(slot.path)) throw new Error("Crash capture lacks the owning session sidecar.");
	const capturedJournal = JSON.parse(capture.get(slot.path)!) as {
		sessionId: string;
		unresolved: Array<{ requestId: string; route: string; summarySpendPending: boolean }>;
	};
	expect(capturedJournal.sessionId).toBe(manager.getSessionId());
	expect(capturedJournal.unresolved).toContainEqual(
		expect.objectContaining({ requestId: flight.token, route: "history_summary", summarySpendPending: true }),
	);
	const queueFile = icmContinuousStore(agentDir).queueDatabase;
	const crashRow = () =>
		world.guard.peekSqlite(queueFile, "SELECT status, attempts FROM work WHERE level=0 AND ordinal=0")?.[0];
	expect(crashRow(), "the cut captures a claimed first attempt").toMatchObject({ status: "running", attempts: 1 });
	const sqlite = world.guard.snapshotSqlite();
	const warnings = world.warnings.length;
	const checks = crashCutChecks("the cut owner disposes cleanly");
	const fresh = await world.restart({
		owner: owner.session,
		sessionFile,
		cut: { manifest, capture },
		rewindSqlite: sqlite,
		retainedClaims: [],
		check: {
			...checks,
			transport: (failures) => {
				checks.transport(failures);
				expect(cancelledTerminal, "the old provider reports its measured abort before the cut is restored").toEqual(
					{ stopReason: "aborted", totalTokens: 24 },
				);
				const oldRaw = world.io.peekFile(slot.path);
				const oldJournal =
					oldRaw === undefined ? undefined : (JSON.parse(oldRaw) as { unresolved?: Array<{ requestId: string }> });
				expect(
					oldJournal?.unresolved?.some((request) => request.requestId === flight.token) ?? false,
					"the old terminal resolves its request before captured bytes are restored",
				).toBe(false);
				expect(
					world.warnings.slice(warnings).filter((message) => message === UNKNOWN_HANDOFF),
					"the old owner emits no unknown handoff for the measured abort",
				).toEqual([]);
			},
		},
		reopen: { agentDir, settings },
	});
	expect(world.processTable.self).not.toBe(flight.owner.pid);
	expect(
		crashRow(),
		"startup recovery refunds the interrupted attempt while the unresolved physical flight fences re-admission",
	).toMatchObject({ status: "ready", attempts: 0 });
	world.provider.enqueue("root", text("accounting-crash-reopened-owner", "Still recorded."));
	enterAccountingPhase(world, "icm-accounting-crash-reopened");
	await withDeadline(
		world.trace,
		"crash reopened owner turn",
		fresh.session.prompt(`Also remember ${"y".repeat(600)}`),
	);
	endAccountingQuiet(world, "accounting foreground");
	await withDeadline(
		world.trace,
		"dead flight holds the next queued summary",
		world.whenWarnings(warnings, (seen) => seen.includes(ACCOUNTING_STORAGE)),
		60_000,
	);
	expect(world.provider.reached.slice(reachedMark).filter((step) => step.startsWith("worker-c:"))).toEqual([
		"worker-c:accounting-crash-flight",
	]);
	const restoredRaw = world.io.peekFile(slot.path);
	if (!restoredRaw) throw new Error("The restored flight's unresolved sidecar disappeared.");
	const restored = JSON.parse(restoredRaw) as { unresolved?: Array<{ requestId: string }> };
	expect(restored.unresolved).toContainEqual(expect.objectContaining({ requestId: flight.token }));
	const freshWarnings = world.warnings.length;
	expect(await world.disposeSessionInBody(fresh.session)).toBeUndefined();
	consumeWarning(world, freshWarnings, UNKNOWN_HANDOFF, 1);
	consumeWarning(world, warnings, ACCOUNTING_STORAGE, 1);
}

/** An acknowledged spend with a refused sidecar ACK stays fenced until that same receipt is retired. */
async function runAcknowledgementGap(world: HarnessWorld): Promise<void> {
	const agentDir = `${world.agentDir}-icm-accounting-ack`;
	const manager = world.createSessionManager(agentDir);
	const owner = await world.createRootSession("root", {
		agentDir,
		sessionManager: manager,
		settings: icmContinuousSettings(),
	});
	const spendFile = continuousChatSpendFile(agentDir);
	const slot = journalSlotOf(createSessionManagerLedgerPort(manager).identity());
	if (!slot) throw new Error("ACK witness requires a persisted session sidecar.");
	const hasAckStarted = () => {
		const raw = world.io.peekFile(spendFile);
		if (!raw) return false;
		const state = JSON.parse(raw) as { circuits: Record<string, { pendingAck?: { ackStarted: boolean } }> };
		return Object.values(state.circuits).some((circuit) => circuit.pendingAck?.ackStarted === true);
	};
	let denial: ReturnType<typeof world.io.denyUntilCleared> | undefined;
	const denied = world.io.waitForOperation(
		(operation) => operation.kind === "unlink" && operation.path === slot.path && operation.code === "EIO",
	);
	const empty = createEmptyUsage();
	const paid = { ...empty, input: 1, output: 1, totalTokens: 2, cost: { ...empty.cost, input: 0.25, total: 0.25 } };
	const mark = world.provider.reached.length;
	const warningMark = world.warnings.length;
	world.provider.enqueue(
		"worker-c",
		{
			name: "accounting-ack-paid",
			check: () => {
				denial = world.io.denyUntilCleared({
					name: "icm-accounting-ack-unlink",
					kind: "unlink",
					code: "EIO",
					matches: (operation) => operation.path === slot.path && hasAckStarted(),
				});
			},
			reply: { content: [{ type: "text", text: "owner: paid." }], usage: paid },
		},
		{
			name: "accounting-ack-next",
			reply: {
				content: [{ type: "text", text: "pi: next." }],
				usage: { ...empty, input: 1, output: 1, totalTokens: 2 },
			},
		},
	);
	world.provider.enqueue("root", text("accounting-ack-owner", `Reply ${"r".repeat(600)}`));
	enterAccountingPhase(world, "icm-accounting-ack");
	await withDeadline(world.trace, "ack gap owner turn", owner.session.prompt(`Remember ${"t".repeat(600)}`));
	endAccountingQuiet(world, "accounting foreground");
	await withDeadline(world.trace, "sidecar acknowledgement refused", denied, 60_000);
	const during = JSON.parse(world.io.peekFile(spendFile)!) as {
		usd: number;
		circuits: Record<string, { token: string; pendingAck?: { ackStarted: boolean } }>;
	};
	expect(during.usd, "the spend was committed before acknowledgement failed").toBe(0.25);
	const pending = Object.values(during.circuits).find((circuit) => circuit.pendingAck?.ackStarted);
	expect(pending).toBeDefined();
	const ackJournal = JSON.parse(world.io.peekFile(slot.path)!) as {
		sessionId: string;
		records: Array<{ reportId: string; summarySpendPending: boolean; canonicalConfirmed: boolean }>;
	};
	expect(ackJournal.sessionId).toBe(manager.getSessionId());
	expect(ackJournal.records).toHaveLength(1);
	expect(ackJournal.records[0]).toMatchObject({
		reportId: pending!.token,
		summarySpendPending: true,
		canonicalConfirmed: true,
	});
	expect(world.provider.reached.slice(mark).filter((step) => step.startsWith("worker-c:"))).toEqual([
		"worker-c:accounting-ack-paid",
	]);
	await withDeadline(
		world.trace,
		"ack-gap completed leaf publishes",
		world.io.waitForMutation(() =>
			icmReadContinuousNodes(world, icmContinuousStore(agentDir)).some(
				(node) => node.level === 0 && node.ordinal === 0,
			),
		),
		60_000,
	);
	await withDeadline(
		world.trace,
		"ack gap holds subsequent work",
		world.whenWarnings(warningMark, (seen) => seen.includes(ACCOUNTING_STORAGE)),
		60_000,
	);
	const sessionFile = manager.getSessionFile();
	if (!sessionFile || !denial) throw new Error("The acknowledgement gap requires its session and denial.");
	expect(await world.disposeSessionInBody(owner.session)).toBeUndefined();
	expect(
		world.timers.armedSnapshot("continuous-chat").map((timer) => timer.delayMs),
		"an unacknowledged exact receipt keeps its retry after session disposal",
	).toEqual([2_000]);
	expect(denial.clear()).toBeGreaterThan(0);
	world.timers.advance("continuous-chat", 2_000);
	await withDeadline(
		world.trace,
		"retired owner's exact acknowledgement recovers",
		world.io.waitForMutation(() => {
			const raw = world.io.peekFile(spendFile);
			if (!raw) return false;
			const value = JSON.parse(raw) as {
				usd: number;
				circuits: Record<string, { token: string; pendingAck?: unknown }>;
			};
			return (
				value.usd === 0.25 &&
				Object.values(value.circuits).some((item) => item.token === pending!.token && item.pendingAck === undefined)
			);
		}),
		60_000,
	);
	expect(
		world.timers.armedSnapshot("continuous-chat"),
		"the acknowledgement retry retires after successful storage",
	).toEqual([]);
	const after = JSON.parse(world.io.peekFile(spendFile)!) as {
		usd: number;
		circuits: Record<string, { pendingAck?: unknown }>;
	};
	expect(after.usd, "ack retry does not charge the same receipt twice").toBe(0.25);
	expect(Object.values(after.circuits).every((circuit) => circuit.pendingAck === undefined)).toBe(true);
	const reopened = await world.createRootSession("root", {
		agentDir,
		sessionManager: world.openSessionManager(sessionFile, agentDir),
		settings: icmContinuousSettings(),
	});
	world.provider.enqueue("root", text("accounting-ack-reopened-owner", "Recorded again."));
	enterAccountingPhase(world, "icm-accounting-ack-reopened");
	await withDeadline(
		world.trace,
		"ack reopened turn",
		reopened.session.prompt("Continue after acknowledgement recovery."),
	);
	endAccountingQuiet(world, "ack reopened foreground");
	await waitAccountingIdle(world, agentDir, 4);
	expect(world.provider.reached.slice(mark)).toContain("worker-c:accounting-ack-next");
	expect(await world.disposeSessionInBody(reopened.session)).toBeUndefined();
	consumeWarning(world, warningMark, ACCOUNTING_STORAGE, 1);
}

/** A reservation waiting in auth must recheck a peer project's new account-wide hold at physical admission. */
async function runReservedInterveningHold(world: HarnessWorld): Promise<void> {
	const agentDir = `${world.agentDir}-icm-accounting-race`;
	const peerCwd = projectPath("accounting-peer-project");
	world.io.mkdirSync(peerCwd, { recursive: true });
	const settings = icmContinuousSettings();
	const first = await world.createRootSession("root", {
		agentDir,
		sessionManager: world.createSessionManager(agentDir),
		settings,
	});
	const peer = await world.createRootSession("root", {
		agentDir,
		cwd: peerCwd,
		sessionManager: world.createSessionManager(agentDir, peerCwd),
		settings,
	});
	const originalAuth = world.modelRegistry.getApiKeyAndHeaders;
	const authGate = createBarrier();
	const authReached = createBarrier();
	let held = false;
	world.modelRegistry.getApiKeyAndHeaders = async (model) => {
		if (model.id === "worker-c" && !held) {
			held = true;
			authReached.release();
			await authGate.promise;
		}
		return originalAuth.call(world.modelRegistry, model);
	};
	const spendFile = continuousChatSpendFile(agentDir);
	const read = () =>
		JSON.parse(world.io.peekFile(spendFile) ?? "null") as {
			circuits: Record<string, { status: string; token: string }>;
		} | null;
	const requestMark = world.provider.reached.length;
	const warningMark = world.warnings.length;
	try {
		world.provider.enqueue("root", text("accounting-reservation-owner", "Recorded."));
		enterAccountingPhase(world, "icm-accounting-reservation");
		await withDeadline(world.trace, "reservation owner turn", first.session.prompt(`Remember ${"q".repeat(600)}`));
		endAccountingQuiet(world, "accounting foreground");
		await withDeadline(world.trace, "reserved summary waits in auth", authReached.promise, 60_000);
		const reservation = Object.values(read()?.circuits ?? {}).find((circuit) => circuit.status === "reserved");
		expect(reservation, "the first project has reserved before its physical provider call").toBeDefined();
		world.provider.enqueue("root", text("accounting-reservation-peer-owner", "Recorded."));
		world.provider.enqueue("worker-c", {
			name: "accounting-peer-unknown",
			reply: {
				content: [{ type: "text", text: "owner: unknown." }],
				usage: createEmptyUsage(),
			},
		});
		enterAccountingPhase(world, "icm-accounting-reservation-peer");
		await withDeadline(world.trace, "peer owner turn", peer.session.prompt(`Remember ${"p".repeat(600)}`));
		endAccountingQuiet(world, "accounting foreground");
		await withDeadline(
			world.trace,
			"peer physical response creates shared unknown hold",
			world.io.waitForMutation(() =>
				Object.values(read()?.circuits ?? {}).some((circuit) => circuit.status === "unknown"),
			),
			60_000,
		);
		authGate.release();
		await withDeadline(
			world.trace,
			"reserved claim retires after intervening hold",
			world.io.waitForMutation(() =>
				Object.values(read()?.circuits ?? {}).some(
					(circuit) => circuit.token === reservation!.token && circuit.status === "held",
				),
			),
			60_000,
		);
		expect(
			world.provider.reached.slice(requestMark).filter((step) => step.startsWith("worker-c:")),
			"only the peer crosses the physical provider boundary",
		).toEqual(["worker-c:accounting-peer-unknown"]);
	} finally {
		authGate.release();
		world.modelRegistry.getApiKeyAndHeaders = originalAuth;
	}
	expect(await world.disposeSessionInBody(first.session)).toBeUndefined();
	expect(await world.disposeSessionInBody(peer.session)).toBeUndefined();
	consumeWarning(world, warningMark, MISSING_USAGE, 1);
	consumeWarning(world, warningMark, ACCOUNTING_HOLD, 1);
	consumeWarning(world, warningMark, ACCOUNTING_STORAGE, 1);
	consumeWarning(world, warningMark, UNKNOWN_HANDOFF, 1);
}

/** Recover a measured sidecar receipt captured before the original meter replacement could commit. */
async function runRetainedReceiptCrash(world: HarnessWorld): Promise<void> {
	const agentDir = `${world.agentDir}-icm-accounting-receipt-crash`;
	const settings = icmContinuousSettings();
	const manager = world.createSessionManager(agentDir);
	const owner = await world.createRootSession("root", { agentDir, sessionManager: manager, settings });
	const spendFile = continuousChatSpendFile(agentDir);
	let denial: ReturnType<typeof world.io.denyUntilCleared> | undefined;
	const denied = world.io.waitForOperation(
		(op) => op.kind === "rename" && op.destination === spendFile && op.code === "EIO",
	);
	const empty = createEmptyUsage();
	const paid = { ...empty, input: 1, output: 1, totalTokens: 2, cost: { ...empty.cost, input: 0.25, total: 0.25 } };
	world.provider.enqueue("worker-c", {
		name: "accounting-crash-receipt",
		check: () => {
			denial = world.io.denyUntilCleared({
				name: "icm-receipt-crash-spend-denial",
				kind: "rename",
				code: "EIO",
				matches: (op) => op.destination === spendFile,
			});
		},
		reply: { content: [{ type: "text", text: "owner: paid." }], usage: paid },
	});
	world.provider.enqueue("root", text("accounting-crash-receipt-owner", "Recorded."));
	enterAccountingPhase(world, "icm-accounting-receipt-crash");
	await withDeadline(world.trace, "receipt crash owner turn", owner.session.prompt(`Remember ${"k".repeat(600)}`));
	endAccountingQuiet(world, "accounting foreground");
	await withDeadline(world.trace, "receipt retained before refused spend commit", denied, 60_000);
	const before = JSON.parse(world.io.peekFile(spendFile)!) as {
		usd: number;
		circuits: Record<string, { status: string; token: string; owner: { pid: number } }>;
	};
	const flight = Object.values(before.circuits).find((item) => item.status === "flight");
	const sessionFile = manager.getSessionFile();
	const slot = journalSlotOf(createSessionManagerLedgerPort(manager).identity());
	if (!flight || !sessionFile || !slot) throw new Error("The retained receipt crash requires a persisted flight.");
	expect(before.usd).toBe(0);
	expect(flight.owner.pid).toBe(world.processTable.self);
	const manifest = () =>
		new Map(
			[...world.io.fileEntries()].filter(
				([path]) =>
					(path === agentDir || path.startsWith(`${agentDir}${sep}`)) &&
					(path.endsWith(".json") || path.endsWith(".jsonl")),
			),
		);
	const capture = manifest();
	const journal = JSON.parse(capture.get(slot.path)!) as {
		sessionId: string;
		records: Array<{
			reportId: string;
			summarySpendPending: boolean;
			payload: { usage: { cost: { total: number } } };
		}>;
	};
	expect(journal.sessionId).toBe(manager.getSessionId());
	expect(journal.records).toContainEqual(
		expect.objectContaining({
			reportId: flight.token,
			summarySpendPending: true,
			payload: expect.objectContaining({
				usage: expect.objectContaining({ cost: expect.objectContaining({ total: 0.25 }) }),
			}),
		}),
	);
	const sqlite = world.guard.snapshotSqlite();
	if (!denial) throw new Error("The retained receipt denial was never armed.");
	expect(denial.clear()).toBeGreaterThan(0);
	const warningMark = world.warnings.length;
	const fresh = await world.restart({
		owner: owner.session,
		sessionFile,
		cut: { manifest, capture },
		rewindSqlite: sqlite,
		retainedClaims: [],
		check: crashCutChecks("the receipt-cut owner disposes cleanly"),
		reopen: { agentDir, settings },
	});
	expect(world.processTable.self).not.toBe(flight.owner.pid);
	world.provider.enqueue(
		"worker-c",
		{
			name: "accounting-crash-receipt-rebuild",
			check: (request) => expect(JSON.stringify(request.context.messages)).toContain("k".repeat(600)),
			reply: {
				content: [{ type: "text", text: "owner: recovered original." }],
				usage: { ...empty, input: 1, output: 1, totalTokens: 2 },
			},
		},
		{
			name: "accounting-crash-receipt-next",
			check: (request) => expect(JSON.stringify(request.context.messages)).toContain("l".repeat(600)),
			reply: {
				content: [{ type: "text", text: "owner: next." }],
				usage: { ...empty, input: 1, output: 1, totalTokens: 2 },
			},
		},
	);
	world.provider.enqueue("root", text("accounting-crash-receipt-next-owner", "Recorded again."));
	enterAccountingPhase(world, "icm-accounting-receipt-reopened");
	await withDeadline(world.trace, "receipt crash reopened turn", fresh.session.prompt(`Remember ${"l".repeat(600)}`));
	// A recovered flight is conservatively held for its cooldown before new work can dispatch.
	endAccountingQuiet(world, "accounting foreground");
	world.timers.advance("continuous-chat", 120_000);
	await waitAccountingIdle(world, agentDir, 4);
	const after = JSON.parse(world.io.peekFile(spendFile)!) as { usd: number };
	expect(after.usd, "restart charges the retained receipt once").toBe(0.25);
	expect(world.provider.reached).toContain("worker-c:accounting-crash-receipt-rebuild");
	expect(world.provider.reached).toContain("worker-c:accounting-crash-receipt-next");
	expect(await world.disposeSessionInBody(fresh.session)).toBeUndefined();
	consumeWarning(world, warningMark, ACCOUNTING_HOLD, 1);
}

/** A paid physical response settles and acknowledges its own token while a peer's unknown bill still fences admission. */
async function runUnrelatedUnknownSettlement(world: HarnessWorld): Promise<void> {
	const agentDir = `${world.agentDir}-icm-accounting-cross-settlement`;
	const peerCwd = projectPath("accounting-cross-settlement-peer");
	world.io.mkdirSync(peerCwd, { recursive: true });
	const settings = icmContinuousSettings();
	const firstManager = world.createSessionManager(agentDir);
	const first = await world.createRootSession("root", { agentDir, sessionManager: firstManager, settings });
	const peer = await world.createRootSession("root", {
		agentDir,
		cwd: peerCwd,
		sessionManager: world.createSessionManager(agentDir, peerCwd),
		settings,
	});
	const spendFile = continuousChatSpendFile(agentDir);
	const state = () =>
		JSON.parse(world.io.peekFile(spendFile) ?? "null") as null | {
			usd: number;
			circuits: Record<string, { token: string; status: string; pendingAck?: unknown }>;
		};
	const gate = createBarrier();
	const empty = createEmptyUsage();
	const paid = { ...empty, input: 1, output: 1, totalTokens: 2, cost: { ...empty.cost, input: 0.25, total: 0.25 } };
	const warningMark = world.warnings.length;
	const requestMark = world.provider.reached.length;
	world.provider.enqueue(
		"worker-c",
		{
			name: "accounting-peer-known-flight",
			gate: gate.promise,
			reply: { content: [{ type: "text", text: "owner: paid." }], usage: paid },
		},
		{
			name: "accounting-peer-unknown-flight",
			reply: { content: [{ type: "text", text: "owner: unknown." }], usage: empty },
		},
	);
	world.provider.enqueue("root", text("accounting-peer-known-owner", "Recorded."));
	enterAccountingPhase(world, "icm-accounting-peer-known");
	try {
		await withDeadline(world.trace, "known peer owner turn", first.session.prompt(`Remember ${"n".repeat(600)}`));
		endAccountingQuiet(world, "known peer foreground");
		await withDeadline(
			world.trace,
			"known physical request held",
			world.provider.whenReached("worker-c:accounting-peer-known-flight", requestMark),
			60_000,
		);
		await withDeadline(
			world.trace,
			"known flight holds its own backlog",
			world.whenWarnings(warningMark, (seen) => seen.includes(ACCOUNTING_HOLD)),
			60_000,
		);
		const known = Object.values(state()?.circuits ?? {}).find((circuit) => circuit.status === "flight");
		if (!known) throw new Error("The known peer has no physical flight token.");
		world.provider.enqueue("root", text("accounting-peer-unknown-owner", "Recorded."));
		enterAccountingPhase(world, "icm-accounting-peer-unknown");
		await withDeadline(world.trace, "unknown peer owner turn", peer.session.prompt(`Remember ${"o".repeat(600)}`));
		endAccountingQuiet(world, "unknown peer foreground");
		await withDeadline(
			world.trace,
			"peer unknown bill is durable",
			world.io.waitForMutation(() =>
				Object.values(state()?.circuits ?? {}).some(
					(circuit) => circuit.status === "unknown" && circuit.token !== known.token,
				),
			),
			60_000,
		);
		gate.release();
		await withDeadline(
			world.trace,
			"known peer settles despite unrelated unknown",
			world.io.waitForMutation(() => {
				const current = state();
				const knownNow = Object.values(current?.circuits ?? {}).find((circuit) => circuit.token === known.token);
				return (
					current?.usd === 0.25 &&
					knownNow?.status === "settled" &&
					knownNow.pendingAck === undefined &&
					Object.values(current.circuits).some(
						(circuit) => circuit.status === "unknown" && circuit.token !== known.token,
					)
				);
			}),
			60_000,
		);
		const entries = firstManager
			.getEntries()
			.filter(
				(entry) =>
					entry.type === "custom" &&
					entry.customType === SEMANTIC_USAGE_CUSTOM_TYPE &&
					typeof entry.data === "object" &&
					entry.data !== null &&
					"reportId" in entry.data &&
					entry.data.reportId === known.token &&
					firstManager.isEntryPersisted(entry.id),
			);
		expect(entries).toHaveLength(1);
		const entry = entries[0];
		expect(entry?.type === "custom" ? entry.data : undefined).toMatchObject({
			route: "history_summary",
			usage: { cost: { total: 0.25 } },
		});
		world.provider.enqueue("root", text("accounting-peer-after-settlement-owner", "Recorded again."));
		enterFollowup(world, "icm-accounting-peer-after-settlement", firstManager, `Remember ${"n".repeat(600)}`);
		const nextWords = `Remember ${"z".repeat(600)}`;
		await withDeadline(
			world.trace,
			"owner continues while peer's unknown stays fenced",
			first.session.prompt(nextWords),
		);
		endAccountingQuiet(world, "post-settlement unknown hold foreground");
		const firstStore = icmContinuousStore(agentDir);
		await withDeadline(
			world.trace,
			"post-settlement long input is durably logged",
			world.io.waitForMutation(() =>
				icmReadContinuousRecords(world, firstStore).some(
					(record) => record.id === 2 && record.kind === "user" && record.text.includes(nextWords),
				),
			),
			60_000,
		);
		expect(icmReadContinuousNodes(world, firstStore).some((node) => node.level === 0 && node.ordinal === 2)).toBe(
			false,
		);
		expect(
			world.provider.reached.slice(requestMark).filter((step) => step.startsWith("worker-c:")),
			"the peer unknown still blocks a real subsequent summary after the known receipt is acknowledged",
		).toEqual(["worker-c:accounting-peer-known-flight", "worker-c:accounting-peer-unknown-flight"]);
	} finally {
		gate.release();
	}
	expect(await world.disposeSessionInBody(first.session)).toBeUndefined();
	expect(await world.disposeSessionInBody(peer.session)).toBeUndefined();
	expect(
		world.timers.armedSnapshot("continuous-chat"),
		"settled known token and unknown peer retain no local settlement alarms",
	).toEqual([]);
	consumeWarning(world, warningMark, ACCOUNTING_HOLD, 1);
	consumeWarning(world, warningMark, ACCOUNTING_STORAGE, 1);
	consumeWarning(world, warningMark, MISSING_USAGE, 1);
	consumeWarning(world, warningMark, UNKNOWN_HANDOFF, 1);
}
