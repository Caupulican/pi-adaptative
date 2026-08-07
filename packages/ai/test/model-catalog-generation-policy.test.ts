import { readFileSync } from "fs";
import { describe, expect, it, vi } from "vitest";
import { runModelCatalogGeneration } from "../scripts/model-catalog-generation-policy.ts";

describe("model catalog generation policy", () => {
	it("retains an existing committed catalog when live fetches are disabled", async () => {
		const generate = vi.fn(async () => {});
		const pathExists = vi.fn(() => true);
		const log = vi.fn();

		await expect(
			runModelCatalogGeneration({
				catalogPath: "/repo/src/models.generated.ts",
				skipFetch: "1",
				generate,
				pathExists,
				log,
			}),
		).resolves.toBe("retained");

		expect(pathExists).toHaveBeenCalledOnce();
		expect(pathExists).toHaveBeenCalledWith("/repo/src/models.generated.ts");
		expect(generate).not.toHaveBeenCalled();
		expect(log).toHaveBeenCalledOnce();
		expect(log).toHaveBeenCalledWith("PI_SKIP_MODEL_FETCH=1 - keeping committed models.generated.ts (no live fetch)");
	});

	it("fails closed when live fetches are disabled and the committed catalog is missing", async () => {
		const generate = vi.fn(async () => {});

		await expect(
			runModelCatalogGeneration({
				catalogPath: "/repo/src/models.generated.ts",
				skipFetch: "1",
				generate,
				pathExists: () => false,
			}),
		).rejects.toThrow(
			"PI_SKIP_MODEL_FETCH=1 requires an existing committed model catalog at /repo/src/models.generated.ts",
		);

		expect(generate).not.toHaveBeenCalled();
	});

	it("permits generation when live fetches are not disabled", async () => {
		const generate = vi.fn(async () => {});
		const pathExists = vi.fn(() => false);

		await expect(
			runModelCatalogGeneration({
				catalogPath: "/repo/src/models.generated.ts",
				skipFetch: undefined,
				generate,
				pathExists,
			}),
		).resolves.toBe("generated");

		expect(generate).toHaveBeenCalledOnce();
		expect(pathExists).not.toHaveBeenCalled();
	});

	it.each(["generate-models.ts", "generate-image-models.ts"])(
		"routes %s through the shared policy owner",
		(generatorFile) => {
			const source = readFileSync(new URL(`../scripts/${generatorFile}`, import.meta.url), "utf8");

			expect(source).toContain('import { runModelCatalogGeneration } from "./model-catalog-generation-policy.ts";');
			expect(source).toContain("await runModelCatalogGeneration({");
			expect(source).not.toMatch(/PI_SKIP_MODEL_FETCH\s*===/);
			expect(source).not.toContain("existsSync");
		},
	);
});
