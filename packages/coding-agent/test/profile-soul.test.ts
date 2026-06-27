import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getProfilesDir } from "../src/config.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

/**
 * R6 unified situations: a resource profile may carry a `soul` (situational identity). It is surfaced
 * only while the profile is active (switched atomically with the profile's model/capabilities).
 */
describe("profile soul (R6 situational identity)", () => {
	let tempDir: string;
	let agentDir: string;
	let projectDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-soul-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		projectDir = join(tempDir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(projectDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
	});

	it("parses a profile soul and surfaces it only while the profile is active", () => {
		const profilesDir = getProfilesDir(agentDir);
		mkdirSync(profilesDir, { recursive: true });
		writeFileSync(
			join(profilesDir, "researcher.json"),
			JSON.stringify({
				soul: "You are in RESEARCH mode. Prioritize reading and citing sources over editing.",
				resources: {},
			}),
		);

		const settingsManager = SettingsManager.create(projectDir, agentDir);
		const registry = settingsManager.getProfileRegistry();
		expect(registry.getProfile("researcher")?.soul).toContain("RESEARCH mode");

		// Not active → no soul surfaced.
		expect(settingsManager.getActiveProfileSoul()).toBeUndefined();

		// Activate the profile at runtime → its soul is now the active situational identity.
		settingsManager.setRuntimeResourceProfiles(["researcher"]);
		expect(settingsManager.getActiveProfileSoul()).toContain("RESEARCH mode");

		// Switch away → soul gone (switched atomically with the situation).
		settingsManager.setRuntimeResourceProfiles([]);
		expect(settingsManager.getActiveProfileSoul()).toBeUndefined();
	});

	it("returns undefined when the active profile has no soul", () => {
		const profilesDir = getProfilesDir(agentDir);
		mkdirSync(profilesDir, { recursive: true });
		writeFileSync(join(profilesDir, "plain.json"), JSON.stringify({ resources: {} }));

		const settingsManager = SettingsManager.create(projectDir, agentDir);
		settingsManager.setRuntimeResourceProfiles(["plain"]);
		expect(settingsManager.getActiveProfileSoul()).toBeUndefined();
	});
});
