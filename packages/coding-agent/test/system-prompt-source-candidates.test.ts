import { describe, expect, it } from "vitest";
import { collectSelfModificationSourceCandidates } from "../src/core/system-prompt-builder.ts";

describe("self-modification source candidates", () => {
	it("normalizes once while preserving configured priority and duplicates", () => {
		expect(
			collectSelfModificationSourceCandidates({
				sourcePaths: [" /wsl/source ", "", " /shared/source "],
				sourcePath: " /shared/source ",
			}),
		).toEqual(["/wsl/source", "/shared/source", "/shared/source"]);
	});

	it("returns an empty bounded list when no source is configured", () => {
		expect(collectSelfModificationSourceCandidates({})).toEqual([]);
	});
});
