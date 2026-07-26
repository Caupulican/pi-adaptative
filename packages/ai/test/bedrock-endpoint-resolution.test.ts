import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const bedrockMock = vi.hoisted(() => ({
	constructorCalls: [] as Array<Record<string, unknown>>,
	send: vi.fn<() => Promise<unknown>>(),
}));

vi.mock("@aws-sdk/client-bedrock-runtime", () => {
	class BedrockRuntimeServiceException extends Error {}

	class BedrockRuntimeClient {
		constructor(config: Record<string, unknown>) {
			bedrockMock.constructorCalls.push(config);
		}

		send(): Promise<unknown> {
			return bedrockMock.send();
		}
	}

	class ConverseStreamCommand {
		readonly input: unknown;

		constructor(input: unknown) {
			this.input = input;
		}
	}

	return {
		BedrockRuntimeClient,
		BedrockRuntimeServiceException,
		ConverseStreamCommand,
		StopReason: {
			END_TURN: "end_turn",
			STOP_SEQUENCE: "stop_sequence",
			MAX_TOKENS: "max_tokens",
			MODEL_CONTEXT_WINDOW_EXCEEDED: "model_context_window_exceeded",
			TOOL_USE: "tool_use",
		},
		CachePointType: { DEFAULT: "default" },
		CacheTTL: { ONE_HOUR: "ONE_HOUR" },
		ConversationRole: { ASSISTANT: "assistant", USER: "user" },
		ImageFormat: { JPEG: "jpeg", PNG: "png", GIF: "gif", WEBP: "webp" },
		ToolResultStatus: { ERROR: "error", SUCCESS: "success" },
	};
});

import { getModel } from "../src/models.ts";
import { streamBedrock, streamSimpleBedrock } from "../src/providers/amazon-bedrock.ts";
import type { Context, Model } from "../src/types.ts";

const context: Context = {
	messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
};

const originalAwsRegion = process.env.AWS_REGION;
const originalAwsDefaultRegion = process.env.AWS_DEFAULT_REGION;
const originalAwsProfile = process.env.AWS_PROFILE;

beforeEach(() => {
	bedrockMock.constructorCalls.length = 0;
	bedrockMock.send.mockReset();
	bedrockMock.send.mockRejectedValue(new Error("mock send"));
	delete process.env.AWS_REGION;
	delete process.env.AWS_DEFAULT_REGION;
	delete process.env.AWS_PROFILE;
});

afterEach(() => {
	if (originalAwsRegion === undefined) {
		delete process.env.AWS_REGION;
	} else {
		process.env.AWS_REGION = originalAwsRegion;
	}

	if (originalAwsDefaultRegion === undefined) {
		delete process.env.AWS_DEFAULT_REGION;
	} else {
		process.env.AWS_DEFAULT_REGION = originalAwsDefaultRegion;
	}

	if (originalAwsProfile === undefined) {
		delete process.env.AWS_PROFILE;
	} else {
		process.env.AWS_PROFILE = originalAwsProfile;
	}
});

async function captureClientConfig(
	model: Model<"bedrock-converse-stream">,
	options: { profile?: string } = {},
): Promise<Record<string, unknown>> {
	await streamBedrock(model, context, { cacheRetention: "none", ...options }).result();
	expect(bedrockMock.constructorCalls).toHaveLength(1);
	return bedrockMock.constructorCalls[0];
}

describe("bedrock endpoint resolution", () => {
	it("assigns eu-central-1 runtime URLs to built-in EU inference profiles", () => {
		const model = getModel("amazon-bedrock", "eu.anthropic.claude-sonnet-4-5-20250929-v1:0");

		expect(model.baseUrl).toBe("https://bedrock-runtime.eu-central-1.amazonaws.com");
	});

	it("does not pin standard AWS endpoints when AWS_REGION is configured", async () => {
		process.env.AWS_REGION = "us-east-2";
		const model = getModel("amazon-bedrock", "us.anthropic.claude-opus-4-8");

		const config = await captureClientConfig(model);

		expect(config.region).toBe("us-east-2");
		expect(config.endpoint).toBeUndefined();
	});

	it("derives region from a built-in EU endpoint when no region or profile is configured", async () => {
		const model = getModel("amazon-bedrock", "eu.anthropic.claude-sonnet-4-5-20250929-v1:0");

		const config = await captureClientConfig(model);

		expect(config.endpoint).toBe("https://bedrock-runtime.eu-central-1.amazonaws.com");
		expect(config.region).toBe("eu-central-1");
	});

	it("still passes custom Bedrock endpoints through to the SDK client", async () => {
		process.env.AWS_REGION = "us-west-2";
		const baseModel = getModel("amazon-bedrock", "us.anthropic.claude-opus-4-8");
		const model: Model<"bedrock-converse-stream"> = {
			...baseModel,
			baseUrl: "https://bedrock-vpc.example.com",
		};

		const config = await captureClientConfig(model);

		expect(config.endpoint).toBe("https://bedrock-vpc.example.com");
		expect(config.region).toBe("us-west-2");
	});

	it("lets an explicit profile resolve its own region instead of pinning the catalog endpoint", async () => {
		const model = getModel("amazon-bedrock", "eu.anthropic.claude-sonnet-4-5-20250929-v1:0");

		const config = await captureClientConfig(model, { profile: "work-sso" });

		expect(config.profile).toBe("work-sso");
		expect(config.region).toBeUndefined();
		expect(config.endpoint).toBeUndefined();
	});
});

describe("bedrock SSO recovery", () => {
	function successfulResponse(): unknown {
		return {
			$metadata: {},
			stream: (async function* () {
				yield { messageStart: { role: "assistant" } };
				yield { messageStop: { stopReason: "end_turn" } };
			})(),
		};
	}

	it("uses the recovery callback owned by the request", async () => {
		process.env.AWS_PROFILE = "work-sso";
		const expired = Object.assign(new Error("The SSO session has expired; run aws sso login"), {
			name: "CredentialsProviderError",
		});
		bedrockMock.send.mockRejectedValueOnce(expired).mockResolvedValueOnce(successfulResponse());
		const recovery = vi.fn(async () => true);
		const model = getModel("amazon-bedrock", "us.anthropic.claude-opus-4-8");

		const result = await streamBedrock(model, context, {
			cacheRetention: "none",
			onInteractiveAuthRecovery: recovery,
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(recovery).toHaveBeenCalledOnce();
		expect(bedrockMock.send).toHaveBeenCalledTimes(2);
	});

	it("recovers the implicit default profile selected by the AWS SDK", async () => {
		const expired = Object.assign(new Error("The SSO session has expired; run aws sso login"), {
			name: "CredentialsProviderError",
		});
		bedrockMock.send.mockRejectedValueOnce(expired).mockResolvedValueOnce(successfulResponse());
		const recovery = vi.fn(async () => true);
		const model = getModel("amazon-bedrock", "us.anthropic.claude-opus-4-8");

		const result = await streamBedrock(model, context, {
			cacheRetention: "none",
			onInteractiveAuthRecovery: recovery,
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(recovery).toHaveBeenCalledWith(expect.objectContaining({ profile: "default" }));
		expect(bedrockMock.send).toHaveBeenCalledTimes(2);
	});

	it("bounds recovery handoff details and honors a declined recovery", async () => {
		process.env.AWS_PROFILE = "work-sso";
		const expired = Object.assign(new Error(`The SSO session has expired; run aws sso login. ${"x".repeat(2_000)}`), {
			name: "CredentialsProviderError",
		});
		bedrockMock.send.mockRejectedValue(expired);
		let handedOffMessage = "";
		const recovery = vi.fn(async (request: { errorMessage: string }) => {
			handedOffMessage = request.errorMessage;
			return false;
		});
		const model = getModel("amazon-bedrock", "us.anthropic.claude-opus-4-8");

		const result = await streamBedrock(model, context, {
			cacheRetention: "none",
			onInteractiveAuthRecovery: recovery,
		}).result();

		expect(result.stopReason).toBe("error");
		expect(recovery).toHaveBeenCalledOnce();
		expect(handedOffMessage.length).toBeLessThanOrEqual(512);
		expect(bedrockMock.send).toHaveBeenCalledOnce();
	});

	it("logs into the exact configured profile and retries once with a fresh client", async () => {
		process.env.AWS_PROFILE = "work-sso";
		const expired = Object.assign(
			new Error(
				"The SSO session associated with this profile has expired. To refresh this SSO session run aws sso login with the corresponding profile.",
			),
			{ name: "CredentialsProviderError" },
		);
		bedrockMock.send.mockRejectedValueOnce(expired).mockResolvedValueOnce(successfulResponse());
		const login = vi.fn(async () => true);
		const model = getModel("amazon-bedrock", "us.anthropic.claude-opus-4-8");

		const result = await streamBedrock(model, context, {
			cacheRetention: "none",
			onInteractiveAuthRecovery: login,
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(login).toHaveBeenCalledOnce();
		expect(login).toHaveBeenCalledWith(
			expect.objectContaining({ profile: "work-sso", errorName: "CredentialsProviderError" }),
		);
		expect(bedrockMock.constructorCalls).toHaveLength(2);
		expect(bedrockMock.send).toHaveBeenCalledTimes(2);
	});

	it("recovers when the SDK wraps the SSO credential failure as a cause", async () => {
		process.env.AWS_PROFILE = "work-sso";
		const expired = Object.assign(new Error("The SSO session is invalid; run aws sso login"), {
			name: "CredentialsProviderError",
		});
		bedrockMock.send
			.mockRejectedValueOnce(new Error("credential resolution failed", { cause: expired }))
			.mockResolvedValueOnce(successfulResponse());
		const login = vi.fn(async () => true);
		const model = getModel("amazon-bedrock", "us.anthropic.claude-opus-4-8");

		const result = await streamBedrock(model, context, {
			cacheRetention: "none",
			onInteractiveAuthRecovery: login,
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(login).toHaveBeenCalledWith(
			expect.objectContaining({ errorName: "CredentialsProviderError", profile: "work-sso" }),
		);
		expect(bedrockMock.send).toHaveBeenCalledTimes(2);
	});

	it("bounds repeated SSO expiry to one login and one request replay", async () => {
		process.env.AWS_PROFILE = "work-sso";
		const expired = Object.assign(new Error("The SSO session has expired; run aws sso login"), {
			name: "CredentialsProviderError",
		});
		bedrockMock.send.mockRejectedValue(expired);
		const login = vi.fn(async () => true);
		const model = getModel("amazon-bedrock", "us.anthropic.claude-opus-4-8");

		const result = await streamBedrock(model, context, {
			cacheRetention: "none",
			onInteractiveAuthRecovery: login,
		}).result();

		expect(result.stopReason).toBe("error");
		expect(login).toHaveBeenCalledOnce();
		expect(bedrockMock.send).toHaveBeenCalledTimes(2);
	});

	it("does not reinterpret an expired static session token as SSO", async () => {
		process.env.AWS_PROFILE = "static-profile";
		const expired = Object.assign(new Error("The security token included in the request is expired"), {
			name: "ExpiredTokenException",
		});
		bedrockMock.send.mockRejectedValue(expired);
		const login = vi.fn(async () => true);
		const model = getModel("amazon-bedrock", "us.anthropic.claude-opus-4-8");

		const result = await streamBedrock(model, context, {
			cacheRetention: "none",
			onInteractiveAuthRecovery: login,
		}).result();

		expect(result.stopReason).toBe("error");
		expect(login).not.toHaveBeenCalled();
		expect(bedrockMock.send).toHaveBeenCalledOnce();
	});

	it("does not start interactive recovery for a background request", async () => {
		process.env.AWS_PROFILE = "work-sso";
		const expired = Object.assign(new Error("The SSO session has expired; run aws sso login"), {
			name: "CredentialsProviderError",
		});
		bedrockMock.send.mockRejectedValue(expired);
		const login = vi.fn(async () => true);
		const model = getModel("amazon-bedrock", "us.anthropic.claude-opus-4-8");

		const result = await streamBedrock(model, context, {
			cacheRetention: "none",
			interactionMode: "background",
			onInteractiveAuthRecovery: login,
		}).result();

		expect(result.stopReason).toBe("error");
		expect(login).not.toHaveBeenCalled();
		expect(bedrockMock.send).toHaveBeenCalledOnce();
	});

	it("preserves background mode through the simple-stream adapter", async () => {
		process.env.AWS_PROFILE = "work-sso";
		const expired = Object.assign(new Error("The SSO session has expired; run aws sso login"), {
			name: "CredentialsProviderError",
		});
		bedrockMock.send.mockRejectedValue(expired);
		const login = vi.fn(async () => true);
		const model = getModel("amazon-bedrock", "us.anthropic.claude-opus-4-8");

		const result = await streamSimpleBedrock(model, context, {
			cacheRetention: "none",
			interactionMode: "background",
			onInteractiveAuthRecovery: login,
		}).result();

		expect(result.stopReason).toBe("error");
		expect(login).not.toHaveBeenCalled();
		expect(bedrockMock.send).toHaveBeenCalledOnce();
	});

	it("preserves request-owned recovery through the simple-stream adapter", async () => {
		process.env.AWS_PROFILE = "work-sso";
		const expired = Object.assign(new Error("The SSO session has expired; run aws sso login"), {
			name: "CredentialsProviderError",
		});
		bedrockMock.send.mockRejectedValueOnce(expired).mockResolvedValueOnce(successfulResponse());
		const login = vi.fn(async () => true);
		const model = getModel("amazon-bedrock", "us.anthropic.claude-opus-4-8");

		const result = await streamSimpleBedrock(model, context, {
			cacheRetention: "none",
			interactionMode: "user",
			onInteractiveAuthRecovery: login,
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(login).toHaveBeenCalledOnce();
		expect(bedrockMock.send).toHaveBeenCalledTimes(2);
	});

	it("does not start recovery after request cancellation", async () => {
		process.env.AWS_PROFILE = "work-sso";
		const expired = Object.assign(new Error("The SSO session has expired; run aws sso login"), {
			name: "CredentialsProviderError",
		});
		bedrockMock.send.mockRejectedValue(expired);
		const login = vi.fn(async () => true);
		const controller = new AbortController();
		controller.abort();
		const model = getModel("amazon-bedrock", "us.anthropic.claude-opus-4-8");

		const result = await streamBedrock(model, context, {
			cacheRetention: "none",
			signal: controller.signal,
			onInteractiveAuthRecovery: login,
		}).result();

		expect(result.stopReason).toBe("aborted");
		expect(login).not.toHaveBeenCalled();
		expect(bedrockMock.send).toHaveBeenCalledOnce();
	});

	it("never replays after the response stream has started", async () => {
		process.env.AWS_PROFILE = "work-sso";
		const expired = Object.assign(new Error("SSO session expired; run aws sso login"), {
			name: "CredentialsProviderError",
		});
		bedrockMock.send.mockResolvedValue({
			$metadata: {},
			stream: (async function* () {
				yield { messageStart: { role: "assistant" } };
				throw expired;
			})(),
		});
		const login = vi.fn(async () => true);
		const model = getModel("amazon-bedrock", "us.anthropic.claude-opus-4-8");

		const result = await streamBedrock(model, context, {
			cacheRetention: "none",
			onInteractiveAuthRecovery: login,
		}).result();

		expect(result.stopReason).toBe("error");
		expect(login).not.toHaveBeenCalled();
		expect(bedrockMock.send).toHaveBeenCalledOnce();
	});
});
