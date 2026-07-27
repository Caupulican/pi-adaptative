import assert from "node:assert";
import { describe, it } from "node:test";
import { Input } from "../src/components/input.ts";

describe("Input sensitive mode", () => {
	it("returns the real value while rendering only mask characters", () => {
		const input = new Input({ sensitive: true });
		const secret = "token-value-42";
		input.handleInput(secret);

		assert.strictEqual(input.getValue(), secret);
		const rendered = input.render(80).join("\n");
		assert.ok(!rendered.includes(secret));
		assert.ok(!rendered.includes("token"));
		assert.ok(rendered.includes("•"));
	});

	it("preserves multiline bracketed paste without rendering its contents", () => {
		const input = new Input({ sensitive: true });
		input.handleInput("\x1b[200~line-one\r\nline-two\tend\x1b[201~");

		assert.strictEqual(input.getValue(), "line-one\nline-two\tend");
		const rendered = input.render(80).join("\n");
		assert.ok(!rendered.includes("line-one"));
		assert.ok(!rendered.includes("line-two"));
	});

	it("clears the live value and paste state", () => {
		const input = new Input({ sensitive: true });
		input.handleInput("\x1b[200~partial-secret");
		input.clear();
		input.handleInput("safe");

		assert.strictEqual(input.getValue(), "safe");
		assert.ok(!input.render(40).join("\n").includes("partial-secret"));
	});

	it("does not retain deleted values in undo or kill-ring history", () => {
		const input = new Input({ sensitive: true });
		input.handleInput("secret-history-marker");
		input.handleInput("\x15"); // Ctrl+U
		assert.strictEqual(input.getValue(), "");

		input.handleInput("\x19"); // Ctrl+Y
		input.handleInput("\x1b[45;5u"); // Ctrl+- (undo)
		assert.strictEqual(input.getValue(), "");
	});
});
