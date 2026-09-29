import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { OPENAI_CODEX_CLIENT_VERSION } from "../src/providers/openai-codex-account.ts";

describe("Codex client version", () => {
	it("names the released client identity recorded with the Codex model catalogue", () => {
		const pinned = JSON.parse(
			readFileSync(new URL("../scripts/data/codex-models.json", import.meta.url), "utf8"),
		) as { source: { clientVersion: string; clientTag: string } };
		expect(OPENAI_CODEX_CLIENT_VERSION).toBe(pinned.source.clientVersion);
		expect(pinned.source.clientTag).toBe(`rust-v${OPENAI_CODEX_CLIENT_VERSION}`);
		expect(OPENAI_CODEX_CLIENT_VERSION).not.toBe("0.0.0");
	});
});
