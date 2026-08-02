import { describe, expect, it } from "vitest";
import { parseAuthorizationInput, raceAuthorizationInput } from "../src/utils/oauth/authorization-input.ts";

describe("OAuth authorization input", () => {
	it("parses callback URLs and form-style manual input", () => {
		expect(parseAuthorizationInput(" https://localhost/callback?code=url-code&state=url-state ")).toEqual({
			code: "url-code",
			state: "url-state",
		});
		expect(parseAuthorizationInput("code=form-code&state=form-state")).toEqual({
			code: "form-code",
			state: "form-state",
		});
	});

	it("preserves compact and plain-code inputs", () => {
		expect(parseAuthorizationInput("compact-code#compact-state")).toEqual({
			code: "compact-code",
			state: "compact-state",
		});
		expect(parseAuthorizationInput("plain-code")).toEqual({ code: "plain-code" });
		expect(parseAuthorizationInput("   ")).toEqual({});
	});

	it("does not invent absent callback fields", () => {
		expect(parseAuthorizationInput("https://localhost/callback?state=only-state")).toEqual({
			code: undefined,
			state: "only-state",
		});
	});

	it("accepts the callback without waiting for an unresolved manual input", async () => {
		const result = await raceAuthorizationInput({
			manualInput: () => new Promise<string>(() => {}),
			waitForCallback: async () => ({ code: "callback-code", state: "expected" }),
			cancelWait: () => {},
			expectedState: "expected",
			stateMismatchMessage: "state mismatch",
		});

		expect(result).toEqual({ source: "callback", code: "callback-code", state: "expected" });
	});

	it("cancels the callback wait and validates manual state through one owner", async () => {
		let finishCallback: (value: null) => void = () => {};
		const callback = new Promise<null>((resolve) => {
			finishCallback = resolve;
		});
		const result = await raceAuthorizationInput({
			manualInput: async () => "manual-code#expected",
			waitForCallback: () => callback,
			cancelWait: () => finishCallback(null),
			expectedState: "expected",
			stateMismatchMessage: "state mismatch",
		});

		expect(result).toEqual({ source: "manual", code: "manual-code", state: "expected" });
		await expect(
			raceAuthorizationInput({
				manualInput: async () => "manual-code#wrong",
				waitForCallback: async () => null,
				cancelWait: () => {},
				expectedState: "expected",
				stateMismatchMessage: "state mismatch",
			}),
		).rejects.toThrow("state mismatch");
	});
});
