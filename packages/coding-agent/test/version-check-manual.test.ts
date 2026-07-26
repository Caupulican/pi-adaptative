import { afterEach, describe, expect, it, vi } from "vitest";
import { checkForNewPiVersion, getLatestPiRelease } from "../src/utils/version-check.ts";

const originalSkipVersionCheck = process.env.PI_SKIP_VERSION_CHECK;

afterEach(() => {
	vi.unstubAllGlobals();
	if (originalSkipVersionCheck === undefined) {
		delete process.env.PI_SKIP_VERSION_CHECK;
	} else {
		process.env.PI_SKIP_VERSION_CHECK = originalSkipVersionCheck;
	}
});

describe("manual version checks", () => {
	it("allows an explicit release lookup when automatic checks are disabled", async () => {
		process.env.PI_SKIP_VERSION_CHECK = "1";
		const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
			new Response(JSON.stringify({ version: "1.2.4" }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestPiRelease("1.2.3")).resolves.toEqual({ version: "1.2.4" });
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it("still suppresses the automatic startup check", async () => {
		process.env.PI_SKIP_VERSION_CHECK = "1";
		const fetchMock = vi.fn<typeof fetch>();
		vi.stubGlobal("fetch", fetchMock);

		await expect(checkForNewPiVersion("1.2.3")).resolves.toBeUndefined();
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
