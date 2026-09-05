import { getImagesApiProvider, OPENAI_CODEX_IMAGE_MODEL } from "@caupulican/pi-ai";
import { expect, it } from "vitest";
import { extractToolPathArguments } from "../src/core/autonomy/envelope-enforcement.ts";
import { getDefaultActiveToolNames } from "../src/core/default-tool-surface.ts";
import { deriveModelCapabilityProfile, filterToolNamesForCapability } from "../src/core/model-capability.ts";
import { credentialToolBlockReason } from "../src/core/secrets/credential-exposure-guard.ts";
import { WORKER_FORBIDDEN_TOOLS } from "../src/core/session-role.ts";
import { envelopeHasToolCapability } from "../src/core/tool-capability-policy.ts";

it("makes subscription image generation available only on the selected ChatGPT provider", () => {
	const full = deriveModelCapabilityProfile({ mode: "full" });
	const requested = getDefaultActiveToolNames();
	expect(requested).toContain("image_generate");
	expect(filterToolNamesForCapability(requested, full, { provider: "openai-codex" })).toContain("image_generate");
	for (const provider of ["openai", "anthropic", "openrouter"]) {
		expect(filterToolNamesForCapability(requested, full, { provider })).not.toContain("image_generate");
	}
	expect(filterToolNamesForCapability(requested, full)).not.toContain("image_generate");
	expect(getImagesApiProvider(OPENAI_CODEX_IMAGE_MODEL.api)).toBeDefined();
});

it("keeps native image work out of ungranted workers and requires network, authentication and reference-read authority", () => {
	expect(WORKER_FORBIDDEN_TOOLS.has("image_generate")).toBe(true);
	expect(envelopeHasToolCapability(["network.http"], "image_generate")).toBe(false);
	expect(envelopeHasToolCapability(["network.http", "credentials.use", "filesystem.read"], "image_generate")).toBe(
		true,
	);
});

it("routes every image reference through the shared path and credential boundary", () => {
	const args = { referenced_image_paths: ["one.png", ".env"] };
	expect(extractToolPathArguments("image_generate", args)).toEqual(["one.png", ".env"]);
	expect(credentialToolBlockReason("image_generate", args, process.cwd())).toMatch(/Credential/);
	expect(
		credentialToolBlockReason("image_generate", { referenced_image_paths: ["one.png"] }, process.cwd()),
	).toBeUndefined();
});
