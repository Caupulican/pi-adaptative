import { describe, expect, it } from "vitest";
import {
	capabilitySurvivesReadOnly,
	partitionToolsForReadOnly,
	toolSurvivesReadOnly,
} from "../src/core/tool-capability-policy.ts";

describe("readOnly tool partition", () => {
	it("keeps local read and read-broker capabilities and drops everything else", () => {
		expect(capabilitySurvivesReadOnly("filesystem.read")).toBe(true);
		expect(capabilitySurvivesReadOnly("repo.read")).toBe(true);
		expect(capabilitySurvivesReadOnly("skill.read")).toBe(true);
		expect(capabilitySurvivesReadOnly("memory.query")).toBe(true);
		expect(capabilitySurvivesReadOnly("settings.read")).toBe(true);
		expect(capabilitySurvivesReadOnly("process.exec")).toBe(false);
		expect(capabilitySurvivesReadOnly("filesystem.write")).toBe(false);
		expect(capabilitySurvivesReadOnly("network.http")).toBe(false);
	});

	it("evaluates every conjunctive clause of a tool policy", () => {
		expect(toolSurvivesReadOnly("read")).toBe(true);
		expect(toolSurvivesReadOnly("skill")).toBe(true);
		expect(toolSurvivesReadOnly("bash")).toBe(false);
		expect(toolSurvivesReadOnly("python")).toBe(false);
		expect(toolSurvivesReadOnly("edit")).toBe(false);
		// image_generate needs network AND credentials AND filesystem.read: one dropped clause excludes it.
		expect(toolSurvivesReadOnly("image_generate")).toBe(false);
		expect(toolSurvivesReadOnly("not-a-tool")).toBe(false);
	});

	it("partitions a tool list in the caller's order", () => {
		expect(partitionToolsForReadOnly(["read", "bash", "skill", "python", "artifact_retrieve"])).toEqual({
			kept: ["read", "skill", "artifact_retrieve"],
			excluded: ["bash", "python"],
		});
	});
});
