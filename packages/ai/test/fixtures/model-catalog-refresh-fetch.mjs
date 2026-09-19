const catalogs = new Map([
	[
		"https://models.dev/api.json",
		{
			anthropic: {
				models: {
					"fixture-direct": { name: "Fixture Direct", tool_call: true, limit: { context: 8192, output: 1024 } },
				},
			},
			"github-copilot": {
				models: {
					"gpt-6-astra": { name: "GPT-6 Astra", tool_call: true, reasoning: true },
					"gpt-4.1": { name: "GPT-4.1", tool_call: true, reasoning: false },
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
				{
					id: "~deepseek/deepseek-flash-latest",
					name: "DeepSeek Flash Latest",
					alias_target: { slug: "deepseek/deepseek-v4.1-flash" },
					supported_parameters: ["tools", "reasoning"],
					reasoning: { mandatory: false, supported_efforts: ["low", "high", "max"], default_effort: "high" },
					pricing: { prompt: "0.000001", completion: "0.000002" },
				},
				{
					id: "~openai/gpt-astra-latest",
					name: "GPT Astra Latest",
					alias_target: { slug: "openai/gpt-6-astra" },
					supported_parameters: ["tools", "reasoning"],
					reasoning: {
						mandatory: true,
						supported_efforts: ["low", "medium", "high", "xhigh", "max"],
						default_effort: "medium",
					},
				},
				{
					id: "inception/mercury-2.5",
					name: "Mercury 2.5",
					supported_parameters: ["tools", "reasoning"],
					reasoning: { mandatory: false, supported_efforts: ["low", "medium", "high"] },
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
	const rawUrl = String(input);
	const url = rawUrl.split("?")[0];
	const catalog = catalogs.get(url);
	if (!catalog) throw new Error(`Unexpected catalog URL: ${rawUrl}`);
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
