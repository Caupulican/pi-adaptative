import { describe, expect, it } from "vitest";
import {
	DEFAULT_LEARNING_POLICY_AUTO_APPLY_SUPERSESSIONS,
	DEFAULT_LEARNING_POLICY_CONFIDENCE_THRESHOLD,
	DEFAULT_LEARNING_POLICY_MIN_OBSERVATIONS,
	DEFAULT_LEARNING_POLICY_REFLECTION_SOURCE_CONFIDENCE,
	SettingsManager,
} from "../src/core/settings-manager.ts";

describe("learning policy settings", () => {
	it("returns proposal-first defaults when nothing is configured", () => {
		const resolved = SettingsManager.inMemory().getLearningPolicySettings();

		expect(resolved.enabled).toBe(false);
		expect(resolved.autoApplyEnabled).toBe(false);
		expect(resolved.confidenceThreshold).toBe(DEFAULT_LEARNING_POLICY_CONFIDENCE_THRESHOLD);
		expect(resolved.minObservations).toBe(DEFAULT_LEARNING_POLICY_MIN_OBSERVATIONS);
		expect(resolved.allowedAutoApplyLayers).toEqual(["memory"]);
		expect(resolved.requireRollbackPlan).toBe(true);
		expect(resolved.reflectionSourceConfidence).toBe(DEFAULT_LEARNING_POLICY_REFLECTION_SOURCE_CONFIDENCE);
		// Bug F: a supersession (memory_replace/memory_remove) must stay proposal-first by default too —
		// only an explicit opt-in lets it fall through to the standard auto-apply eligibility chain.
		expect(resolved.autoApplySupersessions).toBe(DEFAULT_LEARNING_POLICY_AUTO_APPLY_SUPERSESSIONS);
		expect(resolved.autoApplySupersessions).toBe(false);
	});

	it("filters unknown layers and clamps numeric fields to defaults", () => {
		const resolved = SettingsManager.inMemory({
			learningPolicy: {
				enabled: true,
				allowedAutoApplyLayers: ["memory", "firmware" as never, "skill"],
				confidenceThreshold: 500,
				minObservations: -1,
				reflectionSourceConfidence: 75,
			},
		}).getLearningPolicySettings();

		expect(resolved.enabled).toBe(true);
		expect(resolved.allowedAutoApplyLayers).toEqual(["memory", "skill"]);
		expect(resolved.confidenceThreshold).toBe(DEFAULT_LEARNING_POLICY_CONFIDENCE_THRESHOLD);
		expect(resolved.minObservations).toBe(DEFAULT_LEARNING_POLICY_MIN_OBSERVATIONS);
		expect(resolved.reflectionSourceConfidence).toBe(75);
	});

	it("round-trips through setLearningPolicySettings", () => {
		const settingsManager = SettingsManager.inMemory();

		settingsManager.setLearningPolicySettings({ enabled: true, autoApplyEnabled: true, confidenceThreshold: 40 });

		const resolved = settingsManager.getLearningPolicySettings();
		expect(resolved.enabled).toBe(true);
		expect(resolved.autoApplyEnabled).toBe(true);
		expect(resolved.confidenceThreshold).toBe(40);
	});

	it("round-trips autoApplySupersessions through setLearningPolicySettings", () => {
		const settingsManager = SettingsManager.inMemory();

		settingsManager.setLearningPolicySettings({
			enabled: true,
			autoApplyEnabled: true,
			autoApplySupersessions: true,
		});

		expect(settingsManager.getLearningPolicySettings().autoApplySupersessions).toBe(true);
	});
});
