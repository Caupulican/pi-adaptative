import { describe, expect, it } from "vitest";
import { redactCredentialContent } from "../src/core/secrets/credential-model-content.ts";

describe("structured credential content projection", () => {
	it("projects values and keys while retaining protocol identities and unchanged references", () => {
		const unchanged = { role: "user", content: "ordinary text" };
		const input = {
			model: "fixture-model",
			arguments: { "registered-secret": "prefix registered-secret suffix", ordinary: "text" },
			schema: { title: "registered-secret", enum: ["registered-secret", "ordinary"] },
			unchanged,
		};
		const projected = redactCredentialContent(
			input,
			(text) => text.replaceAll("registered-secret", "[REDACTED]"),
			(_path, key) => key === "model",
		);
		expect(projected).not.toBe(input);
		expect(projected.unchanged).toBe(unchanged);
		expect(projected.model).toBe("fixture-model");
		expect(projected.arguments).toEqual({ "[REDACTED]": "prefix [REDACTED] suffix", ordinary: "text" });
		expect(projected.schema).toEqual({ title: "[REDACTED]", enum: ["[REDACTED]", "ordinary"] });
		expect(unchanged).toEqual({ role: "user", content: "ordinary text" });
	});

	it("keeps a preserved opaque value live, however exotic its prototype, while redacting everything around it", () => {
		// A Google-style payload carries its transport signal inside the config. Without an opaque exemption the
		// non-plain prototype forced a JSON round trip, which replaced the signal with a plain `{}`.
		const controller = new AbortController();
		const payload = {
			model: "fixture-model",
			contents: [{ parts: [{ text: "prefix registered-secret suffix" }] }],
			config: { abortSignal: controller.signal, maxOutputTokens: 100 },
		};
		const projected = redactCredentialContent(
			payload,
			(text) => text.replaceAll("registered-secret", "[REDACTED]"),
			(_path, key) => key === "model",
			(_path, value) => value instanceof AbortSignal,
		);
		expect(projected.config.abortSignal).toBe(controller.signal);
		expect(projected.config.abortSignal).toBeInstanceOf(AbortSignal);
		expect(projected.config.maxOutputTokens).toBe(100);
		expect(projected.contents[0]?.parts[0]?.text).toBe("prefix [REDACTED] suffix");
		controller.abort();
		expect(projected.config.abortSignal.aborted).toBe(true);

		// Without the exemption the same payload is still normalized, so the exemption is what keeps it live.
		const normalized = redactCredentialContent(payload, (text) => text);
		expect(normalized.config.abortSignal).not.toBeInstanceOf(AbortSignal);
	});

	it("fails closed on collisions and cycles while normalizing valid enumerable accessors", () => {
		const cyclic: { child?: unknown } = {};
		cyclic.child = cyclic;
		const getter = Object.defineProperty({}, "secret", { enumerable: true, get: () => "registered-secret" });
		const collision = { "registered-secret": 1, "[REDACTED]": 2 };
		expect(() => redactCredentialContent(cyclic, (text) => text)).toThrow(/cycle/u);
		expect(
			JSON.stringify(redactCredentialContent(getter, (text) => text.replaceAll("registered-secret", "[REDACTED]"))),
		).toBe('{"secret":"[REDACTED]"}');
		expect(() =>
			redactCredentialContent(collision, (text) => (text === "registered-secret" ? "[REDACTED]" : text)),
		).toThrow(/collision/u);
	});

	it("normalizes native Date metadata with JSON.stringify's standard ISO projection", () => {
		const date = new Date("2026-09-30T00:00:00.000Z");
		expect(JSON.stringify(date)).toBe('"2026-09-30T00:00:00.000Z"');
		expect(JSON.stringify(redactCredentialContent(date, (text) => text))).toBe(JSON.stringify(date));
	});

	it("keeps valid deeply nested and large array payloads within the existing JSON contract", () => {
		let deep: unknown = "end";
		for (let index = 0; index < 256; index++) deep = { child: deep };
		let cursor = redactCredentialContent(deep, (text) => text);
		for (let index = 0; index < 256; index++) cursor = (cursor as { child: unknown }).child;
		expect(cursor).toBe("end");

		const large = Array.from({ length: 100_100 }, (_, index) => `item-${index}`);
		expect(redactCredentialContent(large, (text) => text)).toBe(large);

		const mapPayload = Object.assign(new Map(), { extension: "registered-secret" });
		const normalizedMap = redactCredentialContent(mapPayload, (text) =>
			text.replaceAll("registered-secret", "[REDACTED]"),
		);
		expect(JSON.stringify(mapPayload)).toBe('{"extension":"registered-secret"}');
		expect(normalizedMap).toEqual({ extension: "[REDACTED]" });
	});
});
