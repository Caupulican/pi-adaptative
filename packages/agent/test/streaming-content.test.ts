import { describe, expect, test, vi } from "vitest";
import { GeometricStreamingProjector, StreamingTextBuffer } from "../src/utils/streaming-content.ts";

describe("streaming content buffers", () => {
	test("materializes immutable chunks only when requested", () => {
		const buffer = new StreamingTextBuffer();
		for (let index = 0; index < 10_000; index++) buffer.append("x");
		expect(buffer.length).toBe(10_000);
		expect(buffer.materialize()).toBe("x".repeat(10_000));
		expect(buffer.materialize()).toBe("x".repeat(10_000));
	});

	test("bounds growing-prefix projections geometrically and always projects the final value", () => {
		const project = vi.fn((text: string) => text.length);
		const projector = new GeometricStreamingProjector(project);
		for (let index = 0; index < 65_536; index++) projector.append("x");

		expect(projector.finish()).toBe(65_536);
		expect(project).toHaveBeenCalledTimes(18);
	});
});
