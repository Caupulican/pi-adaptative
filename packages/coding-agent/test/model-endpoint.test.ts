import { describe, expect, it } from "vitest";
import { isLoopbackModelEndpoint } from "../src/core/models/model-endpoint.ts";

describe("isLoopbackModelEndpoint", () => {
	it.each(["http://localhost:11434", "http://127.0.0.1:8080/v1", "http://[::1]:9000"])(
		"accepts loopback endpoint %s",
		(baseUrl) => {
			expect(isLoopbackModelEndpoint(baseUrl)).toBe(true);
		},
	);

	it.each(["https://models.example.com/v1", "not a URL"])("rejects non-loopback endpoint %s", (baseUrl) => {
		expect(isLoopbackModelEndpoint(baseUrl)).toBe(false);
	});
});
