const catalogs = new Map([
	[
		"https://models.dev/api.json",
		{
			anthropic: {
				models: {
					"fixture-direct": { name: "Fixture Direct", tool_call: true, limit: { context: 8192, output: 1024 } },
				},
			},
		},
	],
	[
		"https://openrouter.ai/api/v1/models",
		{
			data: [
				{
					id: "fixture/router",
					name: "Fixture Router",
					supported_parameters: ["tools"],
					context_length: 8192,
					top_provider: { max_completion_tokens: 1024 },
				},
			],
		},
	],
	[
		"https://ai-gateway.vercel.sh/v1/models",
		{
			data: [
				{
					id: "fixture/gateway",
					name: "Fixture Gateway",
					tags: ["tool-use"],
					context_window: 8192,
					max_tokens: 1024,
				},
			],
		},
	],
]);

// Deliberately never delegate to the real fetch: this child cannot make provider requests.
globalThis.fetch = async (input) => {
	const url = String(input);
	const catalog = catalogs.get(url);
	if (!catalog) throw new Error(`Unexpected catalog URL: ${url}`);
	if (url !== process.env.PI_CATALOG_FIXTURE_SOURCE) return Response.json(catalog);
	switch (process.env.PI_CATALOG_FIXTURE_FAILURE) {
		case "network":
			throw new Error("Fixture network failure");
		case "http":
			// A valid body must not hide an unsuccessful status.
			return Response.json(catalog, { status: 503 });
		case "json":
			return new Response("{invalid-json");
		case "empty":
			return Response.json(url === "https://models.dev/api.json" ? {} : { data: [] });
		default:
			throw new Error("Unknown fixture failure");
	}
};
