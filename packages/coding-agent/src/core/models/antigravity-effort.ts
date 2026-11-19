import type { Api, Model } from "@caupulican/pi-ai";

export const ANTIGRAVITY_EFFORT_ORDER = ["low", "medium", "high", "xhigh"] as const;

const familyLabel = new RegExp(`^(Gemini .+) \\((${ANTIGRAVITY_EFFORT_ORDER.join("|")})\\)$`, "i");

export function antigravityGeminiEffortFamily(model: Model<Api>): string | undefined {
	if (model.provider !== "google-antigravity" || !model.id.startsWith("gemini-")) return undefined;
	const label = familyLabel.exec(model.name);
	return label && model.defaultThinkingLevel === label[2]?.toLowerCase() ? label[1] : undefined;
}
