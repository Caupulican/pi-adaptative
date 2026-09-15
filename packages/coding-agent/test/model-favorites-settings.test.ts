import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDirectoryResourceProfileInfo, SettingsManager } from "../src/core/settings-manager.ts";

let root: string;
let agentDir: string;
let projectDir: string;

describe("model favorites persistence", () => {
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "pi-model-favorites-"));
		agentDir = join(root, "agent");
		projectDir = join(root, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(join(projectDir, ".pi"), { recursive: true });
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("persists toggles through disk and reopens with the same identity", async () => {
		const manager = SettingsManager.create(projectDir, agentDir);
		manager.toggleModelFavorite("openai", "gpt-4o");
		manager.toggleModelFavorite("openai/v1", "gpt-4o");
		await manager.flush();

		const reopened = SettingsManager.create(projectDir, agentDir);
		expect(reopened.getModelFavorites()).toEqual([
			{ provider: "openai", modelId: "gpt-4o" },
			{ provider: "openai/v1", modelId: "gpt-4o" },
		]);
		expect(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")).modelFavorites).toHaveLength(2);
	});

	it("uses global favorites even when project and directory overlays provide different values", () => {
		mkdirSync(join(projectDir, ".git"));
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ modelFavorites: [{ provider: "global", modelId: "one" }] }),
		);
		writeFileSync(
			join(projectDir, ".pi", "settings.json"),
			JSON.stringify({ modelFavorites: [{ provider: "project", modelId: "two" }] }),
		);
		const profile = getDirectoryResourceProfileInfo(projectDir, agentDir);
		mkdirSync(join(profile.path, ".."), { recursive: true });
		writeFileSync(profile.path, JSON.stringify({ modelFavorites: [{ provider: "directory", modelId: "three" }] }));

		const manager = SettingsManager.create(projectDir, agentDir);
		expect(manager.getModelFavorites()).toEqual([{ provider: "global", modelId: "one" }]);
	});

	it("does not accept project-only favorites and ignores malformed or duplicate entries", () => {
		writeFileSync(
			join(projectDir, ".pi", "settings.json"),
			JSON.stringify({
				modelFavorites: [
					{ provider: "project", modelId: "two" },
					{ provider: "project", modelId: "two" },
					null,
					{ provider: 42, modelId: "bad" },
				],
			}),
		);
		expect(SettingsManager.create(projectDir, agentDir).getModelFavorites()).toEqual([]);
	});

	it("filters malformed and duplicate global entries while preserving delimiter-collision identities", async () => {
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({
				modelFavorites: [
					{ provider: "a/b", modelId: "c" },
					{ provider: "a", modelId: "b/c" },
					{ provider: "a/b", modelId: "c" },
					null,
					{ provider: "a", modelId: 7 },
				],
			}),
		);
		const manager = SettingsManager.create(projectDir, agentDir);
		expect(manager.getModelFavorites()).toEqual([
			{ provider: "a/b", modelId: "c" },
			{ provider: "a", modelId: "b/c" },
		]);
		manager.toggleModelFavorite("a/b", "c");
		await manager.flush();
		expect(manager.getModelFavorites()).toEqual([{ provider: "a", modelId: "b/c" }]);
	});

	it("toggle is an involutive add/remove roundtrip", async () => {
		const manager = SettingsManager.create(projectDir, agentDir);
		manager.toggleModelFavorite("provider", "model");
		manager.toggleModelFavorite("provider", "model");
		await manager.flush();
		expect(manager.getModelFavorites()).toEqual([]);
	});
});
