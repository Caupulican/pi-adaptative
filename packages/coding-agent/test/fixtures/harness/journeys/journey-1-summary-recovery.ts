import { createEmptyUsage } from "@caupulican/pi-ai";
import { expect } from "vitest";
import {
	CONTINUOUS_CHAT_FOREGROUND_QUIET_MS,
	ContinuousChatRuntime,
} from "../../../../src/core/memory/continuous-chat-runtime.ts";
import { ContinuousChatStore } from "../../../../src/core/memory/continuous-chat-store.ts";
import { createBarrier, HARNESS_PROVIDER, text } from "../scripted-provider.ts";
import { type HarnessWorld, withDeadline } from "../session-fixture.ts";
import {
	expectOwnerWords,
	ICM_INTAKE_JUDGMENTS,
	icmContinuousSettings,
	icmContinuousStore,
	icmReadContinuousNodes,
} from "./shared.ts";

const measured = { ...createEmptyUsage(), input: 1, output: 1, totalTokens: 2 };
const emptyWarning = "Continuous-chat compaction 0+1 failed: Compaction reply was empty.";

/** Observe a real claimed leaf after its recovery key was sampled, before its message read completes. */
function holdClaimRead(world: HarnessWorld, agentDir: string) {
	const store = icmContinuousStore(agentDir);
	const entered = createBarrier();
	const release = createBarrier();
	const original = ContinuousChatStore.prototype.readMessageById;
	let held = false;
	ContinuousChatStore.prototype.readMessageById = async function (id, context) {
		const row = world.guard.peekSqlite(
			store.queueDatabase,
			"SELECT status, attempts FROM work WHERE level=0 AND ordinal=0",
		)?.[0];
		if (this.rootDir === store.root && id === 0 && !held && row?.status === "running") {
			held = true;
			entered.release();
			await release.promise;
		}
		return original.call(this, id, context);
	};
	return {
		entered: entered.promise,
		release: release.release,
		restore: () => {
			release.release();
			ContinuousChatStore.prototype.readMessageById = original;
		},
	};
}

function row(world: HarnessWorld, agentDir: string) {
	return world.guard.peekSqlite(
		icmContinuousStore(agentDir).queueDatabase,
		"SELECT status, attempts, retry_after FROM work WHERE level=0 AND ordinal=0",
	)?.[0];
}
function held(world: HarnessWorld, agentDir: string) {
	return (
		world.guard.peekSqlite(
			icmContinuousStore(agentDir).queueDatabase,
			"SELECT level, ordinal FROM recovery_only WHERE level=0 AND ordinal=0",
		) ?? []
	);
}
async function until(world: HarnessWorld, label: string, predicate: () => boolean) {
	await withDeadline(world.trace, label, world.io.waitForMutation(predicate), 60_000);
}
function quiet(world: HarnessWorld) {
	world.timers.advance("continuous-chat", CONTINUOUS_CHAT_FOREGROUND_QUIET_MS);
}
function ownerPhase(
	world: HarnessWorld,
	manager: ReturnType<HarnessWorld["createSessionManager"]>,
	previous: string,
	name: string,
) {
	world.systemOne.enterPhase(
		name,
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
async function published(world: HarnessWorld, agentDir: string, label: string) {
	await until(world, label, () =>
		icmReadContinuousNodes(world, icmContinuousStore(agentDir)).some(
			(node) => node.level === 0 && node.ordinal === 0,
		),
	);
}

/** H1/H2: actual owner disposal and settings changes act on the durable summary scheduler. */
export async function runSummaryRecoveryJourney(world: HarnessWorld): Promise<void> {
	world.setModelReasoning("worker-c", true, { xhigh: "xhigh" });
	world.setModelReasoning("worker-b", true, { xhigh: "xhigh" });
	try {
		await cancelledClaim(world);
		await emptyReply(world, false);
		await emptyReply(world, true);
	} finally {
		world.setModelReasoning("worker-c", false);
		world.setModelReasoning("worker-b", false);
	}
}

async function cancelledClaim(world: HarnessWorld): Promise<void> {
	const agentDir = `${world.agentDir}-h1-release`;
	const manager = world.createSessionManager(agentDir);
	const settings = icmContinuousSettings();
	const owner = await world.createRootSession("root", { agentDir, sessionManager: manager, settings });
	const gate = holdClaimRead(world, agentDir);
	const stopEntered = createBarrier();
	const originalStop = ContinuousChatRuntime.prototype.stop;
	ContinuousChatRuntime.prototype.stop = function () {
		const completion = originalStop.call(this);
		if (this.store.rootDir === icmContinuousStore(agentDir).root) stopEntered.release();
		return completion;
	};
	const requestMark = world.provider.requests.length;
	try {
		world.provider.enqueue("root", text("h1-release-root", "Recorded."));
		world.systemOne.enterPhase("h1-release", {});
		await withDeadline(world.trace, "H1 owner", owner.session.prompt(`Remember ${"h".repeat(600)}`));
		quiet(world);
		await withDeadline(world.trace, "H1 claim read", gate.entered);
		expect(row(world, agentDir)).toMatchObject({ status: "running", attempts: 1 });
		const disposing = world.disposeSessionInBody(owner.session);
		await withDeadline(world.trace, "H1 owner stops summary runtime", stopEntered.promise);
		gate.release();
		expect(await withDeadline(world.trace, "H1 dispose", disposing)).toBeUndefined();
		expect(row(world, agentDir)).toMatchObject({ status: "ready", attempts: 0 });
		expect(world.provider.requests.slice(requestMark).filter((request) => request.model.id === "worker-c")).toEqual(
			[],
		);
		gate.restore();
		const path = manager.getSessionFile();
		if (!path) throw new Error("H1 requires a persisted session");
		world.provider.enqueue("worker-c", {
			name: "h1-released-physical",
			reply: { content: [{ type: "text", text: "owner: released claim summarized." }], usage: measured },
		});
		const reopened = await world.createRootSession("root", {
			agentDir,
			settings,
			sessionManager: world.openSessionManager(path, agentDir),
		});
		try {
			quiet(world);
			await published(world, agentDir, "H1 released claim publishes");
			expect(world.provider.reached).toContain("worker-c:h1-released-physical");
		} finally {
			expect(await world.disposeSessionInBody(reopened.session)).toBeUndefined();
		}
	} finally {
		gate.restore();
		ContinuousChatRuntime.prototype.stop = originalStop;
	}
}

async function emptyReply(world: HarnessWorld, matching: boolean): Promise<void> {
	const name = matching ? "h2-matching" : "h2-missing";
	const agentDir = `${world.agentDir}-${name}`;
	const manager = world.createSessionManager(agentDir);
	const settings = icmContinuousSettings(matching ? "worker-c" : "h2-unsupported", {
		contextPolicy: {
			memory: {
				history: {
					summaryModel: `${HARNESS_PROVIDER}/${matching ? "worker-c" : "h2-unsupported"}`,
					allowExternalSummaryEgress: true,
					maxConcurrentSummaries: 1,
				},
			},
		},
	});
	const warningMark = world.warnings.length;
	const owner = await world.createRootSession("root", { agentDir, sessionManager: manager, settings });
	const gate = matching ? undefined : holdClaimRead(world, agentDir);
	let previous = `Remember ${"r".repeat(600)}`;
	try {
		world.provider.enqueue("root", text(`${name}-root`, "Recorded."));
		world.provider.enqueue("worker-c", {
			name: `${name}-empty`,
			reply: { content: [{ type: "text", text: "" }], usage: measured },
		});
		world.systemOne.enterPhase(name, {});
		await withDeadline(world.trace, `${name} seed`, owner.session.prompt(previous));
		quiet(world);
		if (gate) {
			await withDeadline(world.trace, "H2 missing key sampled", gate.entered);
			expect(row(world, agentDir)).toMatchObject({ status: "running", attempts: 1 });
			owner.settingsManager.setMemoryHistorySettings({
				...owner.settingsManager.getMemoryHistorySettings(),
				summaryModel: `${HARNESS_PROVIDER}/worker-c`,
			});
			gate.release();
		}
		await until(world, `${name} empty blocked`, () => row(world, agentDir)?.status === "blocked");
		expect(row(world, agentDir)).toMatchObject({ status: "blocked", attempts: 1 });
		expect(Number(row(world, agentDir)?.retry_after))[matching ? "toBe" : "toBeLessThan"](Number.MAX_SAFE_INTEGER);
		expect(held(world, agentDir)).toHaveLength(matching ? 1 : 0);
		await withDeadline(
			world.trace,
			`${name} warning`,
			world.whenWarnings(warningMark, (seen) => seen.includes(emptyWarning)),
		);
		expect(world.warnings.slice(warningMark).filter((entry) => entry === emptyWarning)).toHaveLength(1);
		world.warnings.splice(world.warnings.indexOf(emptyWarning, warningMark), 1);
		if (!matching) {
			const unavailable = `The ICM chat's summary model ${HARNESS_PROVIDER}/h2-unsupported does not support medium thinking, which its compactions request: set contextPolicy.memory.history.compactionThinkingLevel to a level it supports, or contextPolicy.memory.history.summaryModel to another model, for example "<provider>/<model>".`;
			const messages = world.warnings.slice(warningMark).filter((entry) => entry === unavailable);
			expect(messages).toHaveLength(1);
			world.warnings.splice(world.warnings.indexOf(unavailable, warningMark), 1);
		}
		gate?.restore();
		if (matching) {
			const requestMark = world.provider.requests.length;
			const prompt = "Continue with the same summary settings.";
			world.provider.enqueue("root", text(`${name}-same-root`, "Continuing."));
			ownerPhase(world, manager, previous, `${name}-same`);
			await withDeadline(world.trace, `${name} unchanged arrival`, owner.session.prompt(prompt));
			previous = prompt;
			quiet(world);
			expect(row(world, agentDir)).toMatchObject({ status: "blocked", attempts: 1 });
			expect(held(world, agentDir)).toHaveLength(1);
			expect(
				world.provider.requests.slice(requestMark).filter((request) => request.model.id === "worker-c"),
			).toEqual([]);
			owner.settingsManager.setMemoryHistorySettings({
				...owner.settingsManager.getMemoryHistorySettings(),
				summaryModel: `${HARNESS_PROVIDER}/worker-b`,
			});
		}
		const track = matching ? "worker-b" : "worker-c";
		world.provider.enqueue(track, {
			name: `${name}-healthy`,
			reply: { content: [{ type: "text", text: "owner: recovery resumed." }], usage: measured },
		});
		for (let i = 0; i < (matching ? 1 : 4); i++) {
			const prompt = `Continue recovery ${i}.`;
			world.provider.enqueue("root", text(`${name}-follow-${i}`, "Continuing."));
			ownerPhase(world, manager, previous, `${name}-follow-${i}`);
			await withDeadline(world.trace, `${name} arrival ${i}`, owner.session.prompt(prompt));
			previous = prompt;
			quiet(world);
		}
		await published(world, agentDir, `${name} recovered physical summary`);
		expect(world.provider.reached).toContain(`${track}:${name}-healthy`);
		expect(held(world, agentDir)).toEqual([]);
	} finally {
		gate?.restore();
		expect(await world.disposeSessionInBody(owner.session)).toBeUndefined();
	}
}
