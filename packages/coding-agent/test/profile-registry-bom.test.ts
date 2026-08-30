import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProfileRegistry } from "../src/core/profile-registry.ts";

describe("ProfileRegistry BOM handling (F15)", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-profile-registry-bom-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("loads a UTF-8 BOM'd standalone profile file from profilesDir", () => {
		const profilesDir = join(tempDir, "profiles");
		mkdirSync(profilesDir, { recursive: true });
		writeFileSync(
			join(profilesDir, "bom-profile.json"),
			"﻿" +
				JSON.stringify({
					name: "bom-profile",
					description: "Loaded from a BOM'd file",
					resources: { tools: { allow: ["read"] } },
				}),
			"utf-8",
		);

		const registry = new ProfileRegistry({
			globalSettings: {},
			projectSettings: {},
			directoryProfileSettings: {},
			inlineResourceProfileDefinitions: {},
			discoveredResourceProfileDefinitions: {},
			profilesDir,
		});

		expect(registry.listDiagnostics()).toEqual([]);
		const profile = registry.getProfile("bom-profile");
		expect(profile?.description).toBe("Loaded from a BOM'd file");
		expect(profile?.resources.tools).toEqual({ allow: ["read"], block: undefined });
	});

	it("loads BOM'd profiles from an external settings.json root", () => {
		const externalRoot = join(tempDir, "external");
		mkdirSync(externalRoot, { recursive: true });
		writeFileSync(
			join(externalRoot, "settings.json"),
			"﻿" +
				JSON.stringify({
					resourceProfiles: {
						"external-bom-profile": {
							description: "External BOM profile",
							resources: { tools: { allow: ["*"] } },
						},
					},
				}),
			"utf-8",
		);

		const registry = new ProfileRegistry({
			globalSettings: {},
			projectSettings: {},
			directoryProfileSettings: {},
			inlineResourceProfileDefinitions: {},
			discoveredResourceProfileDefinitions: {},
			externalResourceRoots: [externalRoot],
		});

		expect(registry.listDiagnostics()).toEqual([]);
		expect(registry.getProfile("external-bom-profile")).toBeDefined();
	});
});
