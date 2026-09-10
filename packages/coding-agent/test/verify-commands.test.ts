import { describe, expect, it, vi } from "vitest";
import { handleVerifyCommand, VERIFY_USAGE } from "../src/modes/interactive/verify-commands.ts";

function host(obligations: { id: string; command?: string; cwd?: string }[]) {
	const active = [...obligations];
	return {
		active,
		getVerificationObligations: () => [...active],
		dismissVerificationObligations: vi.fn(async (ids: readonly string[]) => {
			const dismissed = ids.filter((id) => active.some((o) => o.id === id));
			for (const id of dismissed)
				active.splice(
					active.findIndex((o) => o.id === id),
					1,
				);
			return dismissed;
		}),
		showStatus: vi.fn(),
		showError: vi.fn(),
		showText: vi.fn(),
	};
}

describe("/verify", () => {
	it("lists obligations with their command and directory, or says none are active", async () => {
		const empty = host([]);
		await handleVerifyCommand(empty, "/verify");
		expect(empty.showStatus).toHaveBeenCalledWith("No verification obligations are active.");
		const h = host([
			{ id: "shell-test-a", command: "vitest run test/x.test.ts", cwd: "/repo" },
			{ id: "shell-test-b" },
		]);
		await handleVerifyCommand(h, "/verify list");
		const text = h.showText.mock.calls[0]?.[0] as string;
		expect(text).toContain("2 verification obligations active");
		expect(text).toContain("1. vitest run test/x.test.ts (in /repo)");
		expect(text).toContain("id shell-test-a");
		expect(text).toContain("2. (command not recorded)");
	});

	it("dismisses one or all by the operator's authority and refuses unknown ids", async () => {
		const h = host([{ id: "shell-test-a" }, { id: "shell-test-b" }]);
		await handleVerifyCommand(h, "/verify dismiss shell-test-a environment fault");
		expect(h.dismissVerificationObligations).toHaveBeenCalledWith(["shell-test-a"], "environment fault");
		expect(h.showStatus).toHaveBeenLastCalledWith(expect.stringContaining("Dismissed 1 verification obligation"));
		await handleVerifyCommand(h, "/verify dismiss nope");
		expect(h.showError).toHaveBeenLastCalledWith("No active obligation nope.");
		await handleVerifyCommand(h, "/verify dismiss all");
		expect(h.dismissVerificationObligations).toHaveBeenLastCalledWith(["shell-test-b"], undefined);
		await handleVerifyCommand(h, "/verify dismiss all");
		expect(h.showError).toHaveBeenLastCalledWith("No verification obligations are active.");
		await handleVerifyCommand(h, "/verify bogus");
		expect(h.showError).toHaveBeenLastCalledWith(VERIFY_USAGE);
	});
});
