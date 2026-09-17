import { inspect } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { antigravityOAuthProvider } from "../src/utils/oauth/google-antigravity.ts";
import { getOAuthApiKey, OAuthRefreshCompletedError } from "../src/utils/oauth/index.ts";

afterEach(() => vi.restoreAllMocks());

it("retains a credential snapshot without exposing tokens through error serialization", () => {
	const credentials = {
		access: "access-fixture-secret",
		refresh: "refresh-fixture-secret",
		expires: 1,
		modelCatalog: { model: { maxTokens: 100 } },
	};
	const error = new OAuthRefreshCompletedError("fixture", credentials, new Error("discovery unavailable"));
	credentials.access = "changed";
	credentials.modelCatalog.model.maxTokens = 200;
	const firstRead = error.credentials;
	expect(firstRead.access).toBe("access-fixture-secret");
	expect(firstRead.modelCatalog).toEqual({ model: { maxTokens: 100 } });
	firstRead.access = "changed again";
	expect(error.credentials.access).toBe("access-fixture-secret");
	for (const rendered of [String(error), JSON.stringify(error), inspect(error)]) {
		expect(rendered).not.toContain("access-fixture-secret");
		expect(rendered).not.toContain("refresh-fixture-secret");
	}
});

it.each(["direct", "registry"])("preserves typed completion through %s callers", async (caller) => {
	const credentials = { access: "old-access", refresh: "old-refresh", expires: 0 };
	const request = vi
		.spyOn(globalThis, "fetch")
		.mockResolvedValueOnce(
			Response.json({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 }),
		)
		.mockResolvedValueOnce(new Response("unavailable", { status: 503 }));
	const result =
		caller === "direct"
			? antigravityOAuthProvider.refreshToken(credentials)
			: getOAuthApiKey("google-antigravity", { "google-antigravity": credentials });
	const error: unknown = await result.catch((failure: unknown) => failure);
	expect(error).toBeInstanceOf(OAuthRefreshCompletedError);
	if (!(error instanceof OAuthRefreshCompletedError)) throw new Error("Missing completed rotation");
	expect(error.credentials).toMatchObject({ access: "new-access", refresh: "new-refresh" });
	expect(error.cause).toMatchObject({ message: "Antigravity loadCodeAssist failed (HTTP 503)" });
	expect(request).toHaveBeenCalledTimes(2);
});

it("does not describe invalid token responses as completed rotations", async () => {
	const request = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(Response.json({ access_token: "new-access" }));
	const result = antigravityOAuthProvider.refreshToken({ access: "old-access", refresh: "old-refresh", expires: 0 });
	await expect(result).rejects.not.toBeInstanceOf(OAuthRefreshCompletedError);
	expect(request).toHaveBeenCalledTimes(1);
});

it.each(["project", "catalog", "malformed-groups", "empty-models"])(
	"retains the preceding account snapshot after %s failure",
	async (failure) => {
		const previous = {
			access: "old-access",
			refresh: "old-refresh",
			expires: 0,
			projectId: "previous-project",
			modelCatalog: { "gemini-previous": { maxTokens: 10000, maxOutputTokens: 1000 } },
		};
		const request = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(
				Response.json({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 }),
			)
			.mockResolvedValueOnce(
				failure === "project"
					? new Response("unavailable", { status: 503 })
					: Response.json({ cloudaicompanionProject: "new-project" }),
			)
			.mockResolvedValueOnce(
				failure === "catalog"
					? new Response("unavailable", { status: 503 })
					: Response.json({ models: {}, agentModelSorts: failure === "empty-models" ? [] : [{ groups: null }] }),
			);
		const error: unknown = await antigravityOAuthProvider.refreshToken(previous).catch((value: unknown) => value);
		expect(error).toBeInstanceOf(OAuthRefreshCompletedError);
		if (!(error instanceof OAuthRefreshCompletedError)) throw new Error("Missing completed rotation");
		expect(error.credentials).toEqual({
			...previous,
			access: "new-access",
			refresh: "new-refresh",
			expires: expect.any(Number),
		});
		expect(error.credentials.projectId).not.toBe("new-project");
		expect(previous.access).toBe("old-access");
		expect(request).toHaveBeenCalledTimes(failure === "project" ? 2 : 3);
	},
);

it("replaces project and catalog together only after complete discovery", async () => {
	const request = vi
		.spyOn(globalThis, "fetch")
		.mockResolvedValueOnce(
			Response.json({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 }),
		)
		.mockResolvedValueOnce(Response.json({ cloudaicompanionProject: "new-project" }))
		.mockResolvedValueOnce(
			Response.json({
				models: { "gemini-new": { maxTokens: 10000, maxOutputTokens: 1000 } },
				agentModelSorts: [{ groups: [{ modelIds: ["gemini-new"] }] }],
			}),
		);
	const credentials = await antigravityOAuthProvider.refreshToken({
		access: "old-access",
		refresh: "old-refresh",
		expires: 0,
		projectId: "previous-project",
		modelCatalog: { "gemini-previous": { maxTokens: 1000, maxOutputTokens: 100 } },
	});
	expect(credentials.projectId).toBe("new-project");
	expect(Object.keys(credentials.modelCatalog as object)).toEqual(["gemini-new"]);
	expect(request).toHaveBeenCalledTimes(3);
});

it.each(["token", "discovery"])(
	"isolates the submitted credential from caller mutation during %s I/O",
	async (stage) => {
		const credentials = {
			access: "old-access",
			refresh: "submitted-refresh",
			expires: 0,
			projectId: "previous-project",
			modelCatalog: { "gemini-previous": { maxTokens: 10000, maxOutputTokens: 1000 } },
		};
		const expected = structuredClone(credentials);
		const mutate = () => {
			credentials.refresh = "another-account-refresh";
			credentials.projectId = "another-project";
			credentials.modelCatalog["gemini-previous"].maxTokens = 100000;
		};
		vi.spyOn(globalThis, "fetch")
			.mockImplementationOnce(async (_input, init) => {
				expect(String(init?.body)).toContain("refresh_token=submitted-refresh");
				if (stage === "token") mutate();
				// An omitted refresh token must retain the token actually submitted.
				return Response.json({ access_token: "new-access", expires_in: 3600 });
			})
			.mockImplementationOnce(async () => {
				if (stage === "discovery") mutate();
				return new Response("unavailable", { status: 503 });
			});
		const error: unknown = await antigravityOAuthProvider.refreshToken(credentials).catch((value: unknown) => value);
		expect(error).toBeInstanceOf(OAuthRefreshCompletedError);
		if (!(error instanceof OAuthRefreshCompletedError)) throw new Error("Missing completed rotation");
		expect(error.credentials).toEqual({ ...expected, access: "new-access", expires: expect.any(Number) });
	},
);
