import { describe, expect, it } from "vitest";
import { executeBashWithOperations } from "../src/core/bash-executor.ts";
import { createLocalBashOperations, setCommandSilenceMsForTests } from "../src/core/tools/bash.ts";

describe("bash-executor silence sentinel mapping", () => {
	it("maps the raw silence:<secs> sentinel to the friendly message instead of leaking it", async () => {
		setCommandSilenceMsForTests(300);
		try {
			let caught: unknown;
			try {
				await executeBashWithOperations("sleep 30", process.cwd(), createLocalBashOperations());
			} catch (err) {
				caught = err;
			}
			expect(caught).toBeInstanceOf(Error);
			const message = (caught as Error).message;
			// The raw sentinel must never reach the caller; only the friendly message should.
			expect(message).not.toMatch(/^silence:/);
			expect(message).toMatch(
				/Command killed after .*s of silence \(no output\)\. If the command is legitimately quiet/,
			);
		} finally {
			setCommandSilenceMsForTests(undefined);
		}
	}, 15_000);
});
