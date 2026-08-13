import { readFileSync } from "fs";
import { describe, expect, it, vi } from "vitest";
import { runModelCatalogGeneration } from "../scripts/model-catalog-generation-policy.ts";

describe("model catalog generation policy", () => {
	it("retains an existing committed catalog when a live fetch is not requested", async () => {
		const generate = vi.fn(async () => {});
		const pathExists = vi.fn(() => true);
		const log = vi.fn();

		await expect(
			runModelCatalogGeneration({
				catalogPath: "/repo/src/models.generated.ts",
				fetchRequested: undefined,
				generate,
				pathExists,
				log,
			}),
		).resolves.toBe("retained");

		expect(pathExists).toHaveBeenCalledOnce();
		expect(pathExists).toHaveBeenCalledWith("/repo/src/models.generated.ts");
		expect(generate).not.toHaveBeenCalled();
		expect(log).toHaveBeenCalledOnce();
		expect(log).toHaveBeenCalledWith(
			"Hermetic build - keeping committed models.generated.ts (set PI_FETCH_MODELS=1 to refresh from live data)",
		);
	});

	it("fails closed when a live fetch is not requested and the committed catalog is missing", async () => {
		const generate = vi.fn(async () => {});

		await expect(
			runModelCatalogGeneration({
				catalogPath: "/repo/src/models.generated.ts",
				fetchRequested: undefined,
				generate,
				pathExists: () => false,
			}),
		).rejects.toThrow(
			"No committed model catalog at /repo/src/models.generated.ts and PI_FETCH_MODELS=1 was not set",
		);

		expect(generate).not.toHaveBeenCalled();
	});

	it("permits generation when a live fetch is explicitly requested", async () => {
		const generate = vi.fn(async () => {});
		const pathExists = vi.fn(() => false);

		await expect(
			runModelCatalogGeneration({
				catalogPath: "/repo/src/models.generated.ts",
				fetchRequested: "1",
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
			expect(source).not.toMatch(/PI_FETCH_MODELS\s*===/);
			expect(source).not.toContain("existsSync");
		},
	);
});
