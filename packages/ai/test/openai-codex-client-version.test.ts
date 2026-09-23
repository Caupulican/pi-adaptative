import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { OPENAI_CODEX_CLIENT_VERSION } from "../src/providers/openai-codex-account.ts";

describe("Codex client version", () => {
	it("names the release the Codex model catalogue was pinned from", () => {
		const pinned = JSON.parse(
			readFileSync(new URL("../scripts/data/codex-models.json", import.meta.url), "utf8"),
		) as { source: { clientVersion: string } };
		expect(OPENAI_CODEX_CLIENT_VERSION).toBe(pinned.source.clientVersion);
	});
});
