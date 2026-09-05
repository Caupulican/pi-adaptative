import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execute = promisify(execFile);
const fixture = fileURLToPath(new URL("./fixtures/webfetch-native-contract.ts", import.meta.url));

describe("WebFetch native transport", () => {
	it("enforces redirects, cancellation, decoded bounds, TLS, and proxy bypass over real native I/O", async () => {
		const result = await execute(process.execPath, [fixture], { timeout: 25000 });
		expect(result.stdout).toContain("webfetch native contract passed");
		expect(result.stderr).toBe("");
	}, 30000);
});
