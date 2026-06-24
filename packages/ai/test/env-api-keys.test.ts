import { afterEach, describe, expect, it } from "vitest";
import { findEnvKeys, getEnvApiKey } from "../src/env-api-keys.ts";

const originalCopilotGitHubToken = process.env.COPILOT_GITHUB_TOKEN;
const originalGhToken = process.env.GH_TOKEN;
const originalGitHubToken = process.env.GITHUB_TOKEN;
const originalSakanaApiKey = process.env.SAKANA_API_KEY;
const originalFuguApiKey = process.env.FUGU_API_KEY;

afterEach(() => {
	if (originalCopilotGitHubToken === undefined) {
		delete process.env.COPILOT_GITHUB_TOKEN;
	} else {
		process.env.COPILOT_GITHUB_TOKEN = originalCopilotGitHubToken;
	}

	if (originalGhToken === undefined) {
		delete process.env.GH_TOKEN;
	} else {
		process.env.GH_TOKEN = originalGhToken;
	}

	if (originalGitHubToken === undefined) {
		delete process.env.GITHUB_TOKEN;
	} else {
		process.env.GITHUB_TOKEN = originalGitHubToken;
	}

	if (originalSakanaApiKey === undefined) {
		delete process.env.SAKANA_API_KEY;
	} else {
		process.env.SAKANA_API_KEY = originalSakanaApiKey;
	}

	if (originalFuguApiKey === undefined) {
		delete process.env.FUGU_API_KEY;
	} else {
		process.env.FUGU_API_KEY = originalFuguApiKey;
	}
});

describe("environment API keys", () => {
	it("does not treat generic GitHub tokens as GitHub Copilot credentials", () => {
		delete process.env.COPILOT_GITHUB_TOKEN;
		process.env.GH_TOKEN = "gh-token";
		process.env.GITHUB_TOKEN = "github-token";

		expect(findEnvKeys("github-copilot")).toBeUndefined();
		expect(getEnvApiKey("github-copilot")).toBeUndefined();
	});

	it("resolves GitHub Copilot credentials from COPILOT_GITHUB_TOKEN", () => {
		process.env.COPILOT_GITHUB_TOKEN = "copilot-token";
		process.env.GH_TOKEN = "gh-token";
		process.env.GITHUB_TOKEN = "github-token";

		expect(findEnvKeys("github-copilot")).toEqual(["COPILOT_GITHUB_TOKEN"]);
		expect(getEnvApiKey("github-copilot")).toBe("copilot-token");
	});

	it("prefers SAKANA_API_KEY over FUGU_API_KEY for Fugu", () => {
		process.env.SAKANA_API_KEY = "sakana-token";
		process.env.FUGU_API_KEY = "fugu-token";

		expect(findEnvKeys("fugu")).toEqual(["SAKANA_API_KEY", "FUGU_API_KEY"]);
		expect(getEnvApiKey("fugu")).toBe("sakana-token");
	});

	it("falls back to FUGU_API_KEY for Fugu", () => {
		delete process.env.SAKANA_API_KEY;
		process.env.FUGU_API_KEY = "fugu-token";

		expect(findEnvKeys("fugu")).toEqual(["FUGU_API_KEY"]);
		expect(getEnvApiKey("fugu")).toBe("fugu-token");
	});
});
