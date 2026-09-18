import { afterEach, expect, it, vi } from "vitest";
import { discoverAntigravityAccount, parseAntigravityModels } from "../src/utils/antigravity.ts";
import { antigravityOAuthProvider } from "../src/utils/oauth/google-antigravity.ts";

const validModel = { displayName: "Gemini fixture", maxTokens: 10000, maxOutputTokens: 1000 };

afterEach(() => vi.unstubAllGlobals());

it.each([null, false, 7, "invalid", []].map((invalid) => ({ invalid })))(
	"isolates malformed model metadata: $invalid",
	({ invalid }) => {
		expect(
			parseAntigravityModels({
				"unrelated-model": invalid,
				"gemini-malformed": invalid,
				"gemini-valid": validModel,
			}).map((model) => model.id),
		).toEqual(["gemini-valid"]);
	},
);

it("retains valid metadata and rejects invalid token limits without aborting other entries", () => {
	expect(
		parseAntigravityModels({
			"gemini-valid": validModel,
			"gemini-invalid": { maxTokens: 10, maxOutputTokens: 11 },
			"gemini-empty": {},
		}).map((model) => model.id),
	).toEqual(["gemini-valid"]);
});

it.each([null, [], "invalid"].map((invalid) => ({ invalid })))(
	"still rejects an invalid catalog envelope: $invalid",
	({ invalid }) => {
		expect(() => parseAntigravityModels(invalid)).toThrow("Invalid Antigravity response");
	},
);

it("still bounds the catalog before skipping invalid entries", () => {
	const oversized = Object.fromEntries(Array.from({ length: 201 }, (_, index) => [`gemini-${index}`, null]));
	expect(() => parseAntigravityModels(oversized)).toThrow("size limit");
});

it.each(["login", "refresh"])(
	"preserves a usable %s result despite unrelated malformed model metadata",
	async (action) => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				Response.json({ access_token: "next-access", refresh_token: "next-refresh", expires_in: 3600 }),
			)
			.mockResolvedValueOnce(Response.json({ cloudaicompanionProject: "fixture-project" }))
			.mockResolvedValueOnce(
				Response.json({
					models: { "unrelated-model": null, "gemini-malformed": [], "gemini-valid": validModel },
					agentModelSorts: [{ groups: [{ modelIds: ["gemini-malformed", "gemini-valid"] }] }],
				}),
			);
		vi.stubGlobal("fetch", fetchMock);
		const credentials =
			action === "login"
				? await antigravityOAuthProvider.login({
						onAuth: () => {},
						onDeviceCode: () => {},
						onSelect: async () => undefined,
						onPrompt: async () => "fixture-code",
					})
				: await antigravityOAuthProvider.refreshToken({ access: "old", refresh: "old-refresh", expires: 0 });
		expect(credentials).toMatchObject({
			access: "next-access",
			refresh: "next-refresh",
			projectId: "fixture-project",
			modelCatalog: { "gemini-valid": validModel },
		});
		expect(antigravityOAuthProvider.modifyModels?.([], credentials).map((model) => model.id)).toEqual([
			"gemini-valid",
		]);
		expect(fetchMock).toHaveBeenCalledTimes(3);
	},
);

it.each([
	{ models: { "gemini-valid": validModel }, agentModelSorts: [{ groups: [{ modelIds: [] }] }] },
	{ models: { "gemini-malformed": null }, agentModelSorts: [{ groups: [{ modelIds: ["gemini-malformed"] }] }] },
])("does not fabricate access when no usable advertised model remains", async (catalog) => {
	vi.stubGlobal(
		"fetch",
		vi
			.fn()
			.mockResolvedValueOnce(Response.json({ cloudaicompanionProject: "fixture-project" }))
			.mockResolvedValueOnce(Response.json(catalog)),
	);
	await expect(discoverAntigravityAccount("fixture-token")).rejects.toThrow(
		"Antigravity returned no supported chat models",
	);
});
