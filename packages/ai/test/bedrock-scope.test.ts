import { describe, expect, it, vi } from "vitest";
import {
	type BedrockScopeOperations,
	discoverBedrockInferenceProfiles,
	probeBedrockModelAccess,
} from "../src/bedrock-scope.ts";

function createOperations(overrides: Partial<BedrockScopeOperations> = {}): BedrockScopeOperations {
	return {
		getCallerIdentity: vi.fn(async () => {}),
		listInferenceProfiles: vi.fn(async () => ({ inferenceProfileIds: [] })),
		probeModel: vi.fn(async () => {}),
		...overrides,
	};
}

describe("Bedrock scope verification", () => {
	it("verifies the exact profile and region before paginating Anthropic system profiles", async () => {
		const getCallerIdentity = vi.fn(async () => {});
		const listInferenceProfiles = vi
			.fn<BedrockScopeOperations["listInferenceProfiles"]>()
			.mockResolvedValueOnce({
				inferenceProfileIds: ["us.anthropic.claude-sonnet-5", "us.amazon.nova-pro-v1:0"],
				nextToken: "page-2",
			})
			.mockResolvedValueOnce({
				inferenceProfileIds: ["us.anthropic.claude-opus-5", "us.anthropic.claude-sonnet-5"],
			});
		const operations = createOperations({ getCallerIdentity, listInferenceProfiles });

		await expect(
			discoverBedrockInferenceProfiles({ region: "us-east-2", profile: "work-sso" }, operations),
		).resolves.toEqual({
			inferenceProfileIds: ["us.anthropic.claude-sonnet-5", "us.anthropic.claude-opus-5"],
		});
		expect(getCallerIdentity).toHaveBeenCalledWith({ region: "us-east-2", profile: "work-sso" });
		expect(listInferenceProfiles).toHaveBeenNthCalledWith(1, {
			region: "us-east-2",
			profile: "work-sso",
			nextToken: undefined,
		});
		expect(listInferenceProfiles).toHaveBeenNthCalledWith(2, {
			region: "us-east-2",
			profile: "work-sso",
			nextToken: "page-2",
		});
	});

	it("rejects a repeated pagination token instead of looping", async () => {
		const operations = createOperations({
			listInferenceProfiles: vi.fn(async () => ({
				inferenceProfileIds: ["us.anthropic.claude-sonnet-5"],
				nextToken: "same-token",
			})),
		});

		await expect(
			discoverBedrockInferenceProfiles({ region: "us-east-2", profile: "work-sso" }, operations),
		).rejects.toThrow("repeated pagination token");
	});

	it("keeps only models whose one-token runtime probe succeeds", async () => {
		const probeModel = vi.fn<BedrockScopeOperations["probeModel"]>(async ({ modelId }) => {
			if (modelId.includes("opus")) throw new Error("AccessDeniedException: model access disabled");
		});
		const operations = createOperations({ probeModel });

		await expect(
			probeBedrockModelAccess(
				{
					region: "eu-west-1",
					profile: "work-sso",
					modelIds: ["eu.anthropic.claude-sonnet-5", "eu.anthropic.claude-opus-5"],
				},
				operations,
			),
		).resolves.toEqual({
			verifiedModelIds: ["eu.anthropic.claude-sonnet-5"],
			failures: [
				{
					modelId: "eu.anthropic.claude-opus-5",
					reason: "AccessDeniedException: model access disabled",
				},
			],
		});
		expect(probeModel).toHaveBeenCalledTimes(2);
	});
});
