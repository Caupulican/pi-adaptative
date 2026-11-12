import "../builtin-install.ts";
import { getEventListeners } from "node:events";
import { expect } from "vitest";
import { createBarrier, type ScriptStep, text } from "../scripted-provider.ts";
import { type HarnessWorld, projectPath, withDeadline } from "../session-fixture.ts";
import { CHANGED_FILE_ANSWER_CLAIMS } from "./journey-5-shared.ts";
import { ICM_INTAKE_JUDGMENTS } from "./shared.ts";

/** Actual text transport, file mutation admission, replay memory and next-provider receipt in one owner turn. */
export async function runJourney1ToolLifecyclePhase(world: HarnessWorld): Promise<void> {
	const agentDir = `${world.agentDir}-tool-lifecycle`;
	const owner = await world.createRootSession("root", {
		agentDir,
		sessionManager: world.createSessionManager(agentDir),
		settings: {
			memorySystem: "okf",
			autoLearn: { enabled: false },
			proactivity: { enabled: false },
			toolRepair: { textProtocol: true },
		},
	});
	const resultText = () => {
		const result = owner.session.messages.findLast((message) => message.role === "toolResult");
		if (result?.role !== "toolResult") throw new Error("The owner must persist its canonical tool receipt.");
		return result.content
			.filter((block) => block.type === "text")
			.map((block) => block.text)
			.join("\n");
	};
	const file = projectPath("replay-owner.txt");
	const created = projectPath("replay-created.txt");
	world.io.writeFileSync(file, "alpha\n");
	const edit = (oldText: string, newText: string) => ({ path: file, edits: [{ oldText, newText }] });
	const envelope = (name: string, args: Record<string, unknown>) =>
		`<tool_call>${JSON.stringify({ name, arguments: args })}</tool_call>`;
	const step = (name: string, body: string, check?: ScriptStep["check"]): ScriptStep => ({
		...text(name, body),
		...(check ? { check } : {}),
	});
	world.provider.enqueue(
		"root",
		step("replay-first-edit", envelope("edit", edit("alpha", "beta"))),
		step("replay-changed-edit", envelope("edit", edit("beta", "gamma")), () => {
			expect(resultText()).not.toContain("already succeeded");
			expect(world.io.readFileSync(file, "utf8")).toBe("beta\n");
		}),
		step("replay-exact-edit", envelope("edit", edit("beta", "gamma")), () => {
			expect(resultText()).not.toContain("already succeeded");
			expect(world.io.readFileSync(file, "utf8")).toBe("gamma\n");
		}),
		step("replay-create", envelope("write", { path: created, content: "first\n" }), (request) => {
			const refused = owner.session.messages.findLast((message) => message.role === "toolResult");
			expect(refused?.role === "toolResult" && refused.isError, "the canonical receipt is a refused replay").toBe(
				true,
			);
			expect(JSON.stringify(refused)).toContain("already succeeded and was not executed again");
			expect(
				JSON.stringify(request.context.messages),
				"the next physical request must carry the exact replay refusal",
			).toContain("already succeeded and was not executed again");
			expect(world.io.readFileSync(file, "utf8")).toBe("gamma\n");
		}),
		step("replay-changed-create", envelope("write", { path: created, content: "second\n" }), () => {
			expect(resultText()).not.toContain("already succeeded");
			expect(world.io.readFileSync(created, "utf8")).toBe("first\n");
		}),
		step("replay-read-result", envelope("read", { path: file }), (request) => {
			expect(resultText()).toContain("write_collision");
			expect(
				JSON.stringify(request.context.messages),
				"the next physical request carries the changed-write collision",
			).toContain("write_collision");
			expect(resultText()).not.toContain("already succeeded");
			expect(world.io.readFileSync(created, "utf8")).toBe("first\n");
		}),
		step("replay-owner-answer", "The file contains gamma; the created file keeps first.", (request) => {
			expect(resultText()).toContain("gamma");
			expect(JSON.stringify(request.context.messages)).toContain("gamma");
		}),
	);
	world.systemOne.enterPhase("text-mutation-replay", { ...ICM_INTAKE_JUDGMENTS, ...CHANGED_FILE_ANSWER_CLAIMS });
	await withDeadline(
		world.trace,
		"text mutation replay owner turn",
		owner.session.prompt(
			"Edit replay-owner.txt twice, preserve exact replay and create-collision safeguards, and read back the result.",
		),
	);
	const terminal = owner.session.messages.findLast((message) => message.role === "assistant");
	expect(terminal?.role === "assistant" ? terminal.stopReason : undefined, JSON.stringify(terminal)).toBe("stop");
	expect(world.provider.reached).toContain("root:replay-owner-answer");
	expect(world.io.readFileSync(file, "utf8")).toBe("gamma\n");
	expect(world.io.readFileSync(created, "utf8")).toBe("first\n");
	expect(owner.session.getSessionWorkState().busy).toBe(false);
	world.trace.mark("root", "tool-replay.changed-payload-and-exact-replay");

	// The outer run signal belongs to the actual Agent caller. Attach before streamAssistantResponse
	// installs its forwarding listener; every failed run must return to this exact baseline.
	const signals: Array<{ signal: AbortSignal; baseline: ReturnType<typeof getEventListeners> }> = [];
	let aborts = 0;
	const stop = owner.session.agent.subscribe((event, signal) => {
		if (event.type !== "agent_start") return;
		signal.addEventListener("abort", () => {
			aborts++;
		});
		signals.push({ signal, baseline: getEventListeners(signal, "abort") });
	});
	const assertReleased = () => {
		const observed = signals.at(-1);
		if (!observed) throw new Error("The actual owner run did not expose its signal.");
		expect(
			getEventListeners(observed.signal, "abort"),
			"only the owner's listeners remain after a failed run",
		).toEqual(observed.baseline);
	};
	const originalPlan = owner.session.agent.planContext;
	if (!originalPlan) throw new Error("The session must use its real request planner.");
	const enterFailurePhase = (name: string, previous?: string) =>
		world.systemOne.enterPhase(
			name,
			previous === undefined ? {} : { ...ICM_INTAKE_JUDGMENTS, carries_0: { kind: "noul", probability: 0.02 } },
			{
				expect: (request) => {
					const state = request.state as Record<string, unknown>;
					if ("owner_messages" in state)
						expect(state.owner_messages).toEqual(previous === undefined ? [] : [previous]);
					if ("user_request" in state) expect(state.user_request).toBe(previous);
				},
			},
		);
	let failStream: (() => void) | undefined;
	try {
		for (let attempt = 0; attempt < 2; attempt++) {
			const requests = world.provider.requests.length;
			owner.session.agent.planContext = async (...args) => {
				const plan = await originalPlan(...args);
				await plan.discard?.();
				throw new Error("Invalid request: journey context planning sentinel");
			};
			enterFailurePhase(
				`failed-request-planning-${attempt}`,
				attempt === 0 ? undefined : "Inspect the file, planning failure 0.",
			);
			await withDeadline(
				world.trace,
				"failed owner request planning",
				owner.session.prompt(`Inspect the file, planning failure ${attempt}.`),
			);
			assertReleased();
			expect(world.provider.requests.length, "a failed plan reaches no physical provider").toBe(requests);
		}
		owner.session.agent.planContext = originalPlan;
		let rejectStream = true;
		failStream = owner.session.agent.subscribe((event) => {
			if (rejectStream && event.type === "message_start" && event.message.role === "assistant") {
				rejectStream = false;
				throw new Error("Invalid request: journey stream delivery sentinel");
			}
		});
		world.provider.enqueue("root", text("stream-delivery-failure", "This response meets the delivery fault."));
		enterFailurePhase("failed-stream-delivery", "Inspect the file, planning failure 1.");
		await withDeadline(
			world.trace,
			"failed owner stream delivery",
			owner.session.prompt("Read the stream through the delivery boundary."),
		);
		failStream();
		expect(rejectStream).toBe(false);
		assertReleased();
		const held = createBarrier();
		world.provider.enqueue("root", {
			...text("healthy-after-failures", "A healthy reply after failed planning and delivery."),
			gate: held.promise,
		});
		enterFailurePhase("healthy-request-after-failures", "Read the stream through the delivery boundary.");
		const healthy = world.trace.track(
			owner.session.prompt("Continue with a healthy request and respect cancellation."),
		);
		await withDeadline(
			world.trace,
			"healthy physical request reached",
			world.provider.whenReached("root:healthy-after-failures"),
		);
		await owner.session.abort("owner cancels the healthy continuation");
		held.release();
		await withDeadline(world.trace, "healthy cancellation settled", healthy);
		expect(aborts, "the caller's listener survives and receives cancellation").toBe(1);
		assertReleased();
		expect(owner.session.getSessionWorkState().busy).toBe(false);
		expect(await world.disposeSessionInBody(owner.session)).toBeUndefined();
		world.trace.mark("root", "tool-lifecycle.failure-cleanup-and-healthy-cancel");
	} finally {
		owner.session.agent.planContext = originalPlan;
		failStream?.();
		stop();
	}
}
