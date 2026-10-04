import type { Agent } from "@caupulican/pi-agent-core";
import type { ImageContent } from "@caupulican/pi-ai";
import { describe, expect, it, vi } from "vitest";
import type { ExtensionRunner } from "../src/core/extensions/index.ts";
import type { GoalSessionController } from "../src/core/goals/goal-session-controller.ts";
import { PendingInputQueueController } from "../src/core/pending-input-queue-controller.ts";
import type { SkillVaultController } from "../src/core/skill-vault.ts";

function createController(context?: { current: boolean; held: string[] }) {
	const agent = {
		steer: vi.fn(),
		followUp: vi.fn(),
		clearAllQueues: vi.fn(),
		withdrawQueuedMessage: vi.fn(() => true),
	};
	const controller = new PendingInputQueueController({
		agent: agent as unknown as Agent,
		skillVault: {} as SkillVaultController,
		goals: {} as GoalSessionController,
		getExtensionRunner: () => ({ getCommand: () => undefined }) as unknown as ExtensionRunner,
		getPromptTemplates: () => [],
		...(context
			? {
					getInputContext: () => ({ sessionId: "session", branchGeneration: 0 }),
					isInputContextCurrent: () => context.current,
					onInputHeld: (input: { text: string }) => context.held.push(input.text),
				}
			: {}),
	});
	return { agent, controller };
}

describe("PendingInputQueueController", () => {
	it("takes queued steering and follow-ups with their images and leaves extension commands queued", () => {
		const { agent, controller } = createController();
		const image: ImageContent = { type: "image", data: "aGk=", mimeType: "image/png" };
		controller.queueSteer("first", [image]);
		controller.queueSteer("second");
		controller.queueFollowUp("later");
		controller.queueExtensionCommand("/reload");
		expect(controller.getSteering()).toEqual(["first", "second"]);
		expect(controller.count).toBe(4);

		const taken = controller.takeMessages();

		expect(taken).toEqual({
			steering: [
				{ text: "first", images: [image] },
				{ text: "second", images: undefined },
			],
			followUp: [{ text: "later", images: undefined }],
		});
		expect(agent.clearAllQueues).toHaveBeenCalledTimes(1);
		expect(controller.snapshot()).toEqual({ steering: [], followUp: [], commands: ["/reload"] });
		expect(controller.count).toBe(1);
	});

	it("removes a delivered message by text from the queue that holds it", () => {
		const { controller } = createController();
		controller.queueSteer("same");
		controller.queueFollowUp("same");
		expect(controller.removeIfPending("same")).toBe("steering");
		expect(controller.removeIfPending("same")).toBe("followUp");
		expect(controller.removeIfPending("same")).toBeUndefined();
	});

	it("keeps registered inputs pending in submission order and admits each kind in that order", () => {
		const { agent, controller } = createController();
		const first = controller.register("steer", "first");
		const second = controller.register("steer", "second");
		const later = controller.register("followUp", "later");
		expect(controller.getSteering()).toEqual(["first", "second"]);
		expect(controller.count).toBe(3);

		expect(controller.admit(second, { text: "second" })).toBe(true);
		expect(controller.admit(later, { text: "later" })).toBe(true);
		// The second steer is decided but waits for the first; follow-ups have their own order.
		expect(agent.steer).not.toHaveBeenCalled();
		expect(agent.followUp).toHaveBeenCalledTimes(1);
		// A decided input is never withdrawn.
		expect(controller.withdraw(second)).toBe(false);

		expect(controller.admit(first, { text: "first expanded" })).toBe(true);
		expect(agent.steer.mock.calls.map(([message]) => message.content[0].text)).toEqual(["first expanded", "second"]);
		expect(controller.getSteering()).toEqual(["first expanded", "second"]);
	});

	it("withdrawing an undecided input releases the inputs behind it", () => {
		const { agent, controller } = createController();
		const first = controller.register("steer", "first");
		const second = controller.register("steer", "second");
		controller.admit(second, { text: "second" });
		expect(controller.withdraw(first)).toBe(true);
		expect(first.signal.aborted).toBe(true);
		expect(agent.steer.mock.calls.map(([message]) => message.content[0].text)).toEqual(["second"]);
		expect(controller.getSteering()).toEqual(["second"]);
	});

	it("taking pending input cancels undecided admissions so a late decision cannot enqueue them", () => {
		const { agent, controller } = createController();
		const image: ImageContent = { type: "image", data: "aGk=", mimeType: "image/png" };
		controller.queueSteer("queued");
		const awaiting = controller.register("steer", "awaiting", [image]);
		expect(controller.takeMessages().steering).toEqual([
			{ text: "queued", images: undefined },
			{ text: "awaiting", images: [image] },
		]);
		expect(awaiting.signal.aborted).toBe(true);
		expect(controller.admit(awaiting, { text: "awaiting" })).toBe(false);
		expect(agent.steer).toHaveBeenCalledTimes(1);
		expect(controller.count).toBe(0);
	});

	it("cancelling undecided input keeps decided input queued", () => {
		const { controller } = createController();
		controller.queueSteer("decided");
		const awaiting = controller.register("steer", "undecided");
		controller.cancelAwaiting();
		expect(awaiting.signal.aborted).toBe(true);
		expect(controller.getSteering()).toEqual(["decided"]);
	});

	it("removes the exact delivered message among identical texts", () => {
		const { agent, controller } = createController();
		const image: ImageContent = { type: "image", data: "aGk=", mimeType: "image/png" };
		controller.queueSteer("same", [image]);
		controller.queueSteer("same");
		const [, second] = agent.steer.mock.calls.map(([message]) => message);
		expect(controller.removeIfPending("same", second)).toBe("steering");
		expect(controller.takeMessages().steering).toEqual([{ text: "same", images: [image] }]);
	});

	it("disposal publishes nothing: a decided input behind an undecided one is never handed on", () => {
		const { agent, controller } = createController();
		const undecided = controller.register("steer", "undecided");
		const decided = controller.register("steer", "decided");
		controller.admit(decided, { text: "decided" });
		controller.close();
		expect(agent.steer).not.toHaveBeenCalled();
		expect(undecided.signal.aborted).toBe(true);
		expect(controller.admit(controller.register("steer", "late"), { text: "late" })).toBe(false);
		expect(agent.steer).not.toHaveBeenCalled();
	});

	it("control: an interrupt cancels only undecided input; a decided follower is still handed on", () => {
		const { agent, controller } = createController();
		controller.register("steer", "undecided");
		const decided = controller.register("steer", "decided");
		controller.admit(decided, { text: "decided" });
		controller.cancelAwaiting();
		expect(agent.steer.mock.calls.map(([message]) => message.content[0].text)).toEqual(["decided"]);
	});

	it("promotion hands an input to its own turn without cancelling it, and refuses a taken input", () => {
		const { agent, controller } = createController();
		const promoted = controller.register("steer", "own turn");
		const follower = controller.register("steer", "follower");
		controller.admit(follower, { text: "follower" });
		expect(controller.promote(promoted)).toBe(true);
		expect(promoted.signal.aborted).toBe(false);
		expect(agent.steer.mock.calls.map(([message]) => message.content[0].text)).toEqual(["follower"]);

		const taken = controller.register("steer", "taken");
		controller.takeMessages();
		expect(controller.promote(taken)).toBe(false);
	});

	it("an input whose context changed is held in full at handoff or promotion, never handed on", () => {
		const context = { current: true, held: [] as string[] };
		const { agent, controller } = createController(context);
		const image: ImageContent = { type: "image", data: "aGk=", mimeType: "image/png" };
		const first = controller.register("steer", "first", [image]);
		const second = controller.register("followUp", "second");
		context.current = false;
		controller.admit(first, { text: "first expanded", images: [image] });
		expect(controller.promote(second)).toBe(false);
		expect(agent.steer).not.toHaveBeenCalled();
		expect(agent.followUp).not.toHaveBeenCalled();
		expect(context.held).toEqual(["first", "second"]);
		// Held input stays pending and recoverable as submitted, and an interrupt keeps it.
		controller.cancelAwaiting();
		expect(controller.takeMessages()).toEqual({
			steering: [{ text: "first", images: [image] }],
			followUp: [{ text: "second", images: undefined }],
		});
	});
});
