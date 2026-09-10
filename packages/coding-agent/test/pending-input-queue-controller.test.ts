import type { Agent } from "@caupulican/pi-agent-core";
import type { ImageContent } from "@caupulican/pi-ai";
import { describe, expect, it, vi } from "vitest";
import type { ExtensionRunner } from "../src/core/extensions/index.ts";
import type { GoalSessionController } from "../src/core/goals/goal-session-controller.ts";
import { PendingInputQueueController } from "../src/core/pending-input-queue-controller.ts";
import type { SkillVaultController } from "../src/core/skill-vault.ts";

function createController() {
	const agent = { steer: vi.fn(), followUp: vi.fn(), clearAllQueues: vi.fn() };
	const controller = new PendingInputQueueController({
		agent: agent as unknown as Agent,
		skillVault: {} as SkillVaultController,
		goals: {} as GoalSessionController,
		getExtensionRunner: () => ({ getCommand: () => undefined }) as unknown as ExtensionRunner,
		getPromptTemplates: () => [],
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
});
