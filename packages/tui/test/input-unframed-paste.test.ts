import assert from "node:assert";
import { describe, it } from "node:test";
import { Input } from "../src/components/input.ts";

describe("Input unframed paste", () => {
	it("inserts a callback URL with a trailing newline instead of dropping it", () => {
		const input = new Input();
		input.handleInput("https://antigravity.google/oauth-callback?code=pasted-code&state=s\n");
		assert.strictEqual(input.getValue(), "https://antigravity.google/oauth-callback?code=pasted-code&state=s");
	});

	it("does not treat a lone Enter as paste", () => {
		const input = new Input();
		let submitted: string | undefined;
		input.onSubmit = (value) => {
			submitted = value;
		};
		input.handleInput("\n");
		assert.strictEqual(input.getValue(), "");
		assert.strictEqual(submitted, "");
	});
});
