import type { Api, Model } from "@caupulican/pi-ai";

export const ANTIGRAVITY_EFFORT_ORDER = ["low", "medium", "high"] as const;

export function antigravityGeminiEffortFamily(model: Model<Api>): string | undefined {
	if (model.provider !== "google-antigravity" || !model.id.startsWith("gemini-")) return undefined;
	const label = /^(Gemini .+) \((Low|Medium|High)\)$/.exec(model.name);
	if (!label || model.defaultThinkingLevel !== label[2]?.toLowerCase()) return undefined;
	return label[1];
}
