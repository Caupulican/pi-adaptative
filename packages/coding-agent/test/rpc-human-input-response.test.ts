import { describe, expect, it } from "vitest";
import { decodeRpcCommand, decodeRpcExtensionUIResponse } from "../src/modes/rpc/rpc-types.ts";

describe("RPC command decoding", () => {
	it("accepts typed command variants and rejects malformed nested fields", () => {
		expect(decodeRpcCommand({ type: "prompt", message: "inspect", images: [] })).toBeDefined();
		expect(decodeRpcCommand({ type: "set_thinking_level", level: "ultra" })).toBeDefined();
		expect(decodeRpcCommand({ type: "prompt", message: "inspect", images: [{ type: "image" }] })).toBeUndefined();
		expect(decodeRpcCommand({ type: "set_auto_retry", enabled: "yes" })).toBeUndefined();
		expect(decodeRpcCommand({ type: "switch_session", sessionPath: 42 })).toBeUndefined();
	});
});

describe("RPC extension UI response decoding", () => {
	it("accepts each typed response variant", () => {
		expect(
			decodeRpcExtensionUIResponse({ type: "extension_ui_response", id: "q", answers: [], images: [] }),
		).toBeDefined();
		expect(decodeRpcExtensionUIResponse({ type: "extension_ui_response", id: "s", value: "choice" })).toBeDefined();
		expect(decodeRpcExtensionUIResponse({ type: "extension_ui_response", id: "c", confirmed: true })).toBeDefined();
		expect(decodeRpcExtensionUIResponse({ type: "extension_ui_response", id: "x", cancelled: true })).toBeDefined();
	});

	it("rejects missing ids, malformed payloads, and ambiguous variants", () => {
		expect(decodeRpcExtensionUIResponse({ type: "extension_ui_response", answers: [] })).toBeUndefined();
		expect(
			decodeRpcExtensionUIResponse({ type: "extension_ui_response", id: "q", answers: "invalid" }),
		).toBeUndefined();
		expect(
			decodeRpcExtensionUIResponse({ type: "extension_ui_response", id: "q", answers: [], cancelled: true }),
		).toBeUndefined();
	});
});
