import { type Context, fauxAssistantMessage } from "@caupulican/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { DurableLearningState } from "../src/core/learning/durable-learning-state.ts";
import {
	CURRENT_TURN_REFLECTION_CUSTOM_TYPE,
	CURRENT_TURN_REFLECTION_STATE_CUSTOM_TYPE,
} from "../src/core/reflection-controller.ts";
import { createHarness, getMessageText, type Harness } from "./suite/harness.ts";

describe("current-session reflection", () => {
	const harnesses: Harness[] = [];
	const originalNativeReflection = process.env.PI_NATIVE_REFLECTION;
	const originalAutoLearnChild = process.env.PI_AUTO_LEARN_CHILD;
	const originalSessionRole = process.env.PI_SESSION_ROLE;

	afterEach(async () => {
		if (originalNativeReflection === undefined) delete process.env.PI_NATIVE_REFLECTION;
		else process.env.PI_NATIVE_REFLECTION = originalNativeReflection;
		if (originalAutoLearnChild === undefined) delete process.env.PI_AUTO_LEARN_CHILD;
		else process.env.PI_AUTO_LEARN_CHILD = originalAutoLearnChild;
		if (originalSessionRole === undefined) delete process.env.PI_SESSION_ROLE;
		else process.env.PI_SESSION_ROLE = originalSessionRole;
		while (harnesses.length > 0) {
			const harness = harnesses.pop();
			if (!harness) continue;
			await harness.session.disposeAndWait();
			await harness.cleanup();
		}
	});

	it("places a durable hidden reflection cue in the root's current provider turn without another request", async () => {
		delete process.env.PI_NATIVE_REFLECTION;
		delete process.env.PI_AUTO_LEARN_CHILD;
		delete process.env.PI_SESSION_ROLE;
		const harness = await createHarness({
			settings: { autoLearn: { enabled: true, reflectionReview: true } },
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		const contexts: Context[] = [];
		harness.setResponses([
			(context) => {
				contexts.push(context);
				return fauxAssistantMessage("Handled in the current root turn.");
			},
			fauxAssistantMessage("This background reflection response must remain unused."),
		]);

		await harness.session.prompt("Summarize this ordinary request.");
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(contexts).toHaveLength(1);
		expect(
			contexts[0]?.messages.some((message) => getMessageText(message).includes("Root reflection contract")),
		).toBe(true);
		expect(
			contexts[0]?.messages.some((message) => getMessageText(message).includes("Installed-state transition")),
		).toBe(true);
		expect(
			harness.sessionManager
				.getEntries()
				.filter(
					(entry) => entry.type === "custom" && entry.customType === CURRENT_TURN_REFLECTION_STATE_CUSTOM_TYPE,
				),
		).toHaveLength(3);
		expect(
			harness.sessionManager
				.getEntries()
				.filter(
					(entry) => entry.type === "custom" && entry.customType === CURRENT_TURN_REFLECTION_STATE_CUSTOM_TYPE,
				)
				.at(-1),
		).toMatchObject({
			data: {
				status: "consumed",
				revision: 3,
				triggers: ["root-turn", "version-change"],
				versionChange: { metadata: { reason: "first-observation" } },
			},
		});
		expect(DurableLearningState.forAgentDir(harness.tempDir).readSnapshot()).toMatchObject({
			currentTransitionId: null,
			currentClaimOwnerId: null,
			resolvedTransitions: 1,
		});
		expect(
			harness.sessionManager
				.getEntries()
				.some(
					(entry) => entry.type === "custom_message" && entry.customType === CURRENT_TURN_REFLECTION_CUSTOM_TYPE,
				),
		).toBe(false);
		expect(
			harness.session.messages.some(
				(message) => message.role === "custom" && message.customType === CURRENT_TURN_REFLECTION_CUSTOM_TYPE,
			),
		).toBe(false);
		expect(harness.session.getSpawnedUsage().reports).toBe(0);
	});

	it.each([
		["the native-reflection kill switch", { PI_NATIVE_REFLECTION: "0" }],
		["an Auto Learn child", { PI_AUTO_LEARN_CHILD: "1" }],
		["a worker session", { PI_SESSION_ROLE: "worker" }],
	] as const)("does not inject reflection into %s", async (_label, environment) => {
		delete process.env.PI_NATIVE_REFLECTION;
		delete process.env.PI_AUTO_LEARN_CHILD;
		delete process.env.PI_SESSION_ROLE;
		Object.assign(process.env, environment);
		const harness = await createHarness({
			settings: { autoLearn: { enabled: true, reflectionReview: true } },
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		let context: Context | undefined;
		harness.setResponses([
			(current) => {
				context = current;
				return fauxAssistantMessage("No reflection privilege.");
			},
		]);

		await harness.session.prompt("Ordinary request.");

		expect(harness.faux.state.callCount).toBe(1);
		expect(context?.messages.some((message) => getMessageText(message).includes("Root reflection contract"))).toBe(
			false,
		);
		expect(
			harness.sessionManager
				.getEntries()
				.some(
					(entry) => entry.type === "custom_message" && entry.customType === CURRENT_TURN_REFLECTION_CUSTOM_TYPE,
				),
		).toBe(false);
	});
});
