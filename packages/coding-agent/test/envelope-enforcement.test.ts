import { describe, expect, it } from "vitest";
import type { CapabilityEnvelope } from "../src/core/autonomy/contracts.ts";
import {
	extractPathArguments,
	isPathWithinEnvelope,
	wrapToolWithEnvelopeScope,
} from "../src/core/autonomy/envelope-enforcement.ts";

const envelope = (overrides: Partial<CapabilityEnvelope>): CapabilityEnvelope => ({
	id: "env-1",
	capabilities: ["read_files"],
	...overrides,
});

describe("envelope path scope", () => {
	it("deny wins over allow; empty allow means no positive restriction", () => {
		const scoped = envelope({ allowedPaths: ["src"], deniedPaths: ["src/secret"] });
		expect(isPathWithinEnvelope(scoped, "src/core/a.ts", "/repo")).toBe(true);
		expect(isPathWithinEnvelope(scoped, "src/secret/key.pem", "/repo")).toBe(false);
		expect(isPathWithinEnvelope(scoped, "docs/readme.md", "/repo")).toBe(false);

		const denyOnly = envelope({ deniedPaths: ["node_modules"] });
		expect(isPathWithinEnvelope(denyOnly, "anything/else.ts", "/repo")).toBe(true);
		expect(isPathWithinEnvelope(denyOnly, "node_modules/x/index.js", "/repo")).toBe(false);
	});

	it("prefix tricks do not escape roots (src-evil is not src)", () => {
		const scoped = envelope({ allowedPaths: ["src"] });
		expect(isPathWithinEnvelope(scoped, "src-evil/a.ts", "/repo")).toBe(false);
		expect(isPathWithinEnvelope(scoped, "src/../etc/passwd", "/repo")).toBe(false);
		expect(isPathWithinEnvelope(scoped, "/etc/passwd", "/repo")).toBe(false);
	});

	it("extracts every conventional path argument shape", () => {
		expect(extractPathArguments({ path: "a", file_path: "b", cwd: "c", paths: ["d", "e"], other: 1 }).sort()).toEqual(
			["a", "b", "c", "d", "e"],
		);
		expect(extractPathArguments(undefined)).toEqual([]);
	});
});

describe("wrapToolWithEnvelopeScope", () => {
	it("refuses out-of-scope paths STRUCTURALLY at execution time and passes in-scope calls through", async () => {
		let ran = 0;
		const tool = {
			name: "read",
			execute: (..._args: unknown[]) => {
				ran++;
				return { content: [{ type: "text", text: "file body" }] };
			},
		};
		const wrapped = wrapToolWithEnvelopeScope(tool, envelope({ allowedPaths: ["src"] }), "/repo");

		const denied = wrapped.execute("tc-1", { path: "/etc/passwd" }) as {
			isError?: boolean;
			details?: { outcome?: string };
		};
		expect(denied.isError).toBe(true);
		expect(denied.details?.outcome).toBe("envelope_path_denied");
		expect(ran).toBe(0);

		const allowed = wrapped.execute("tc-2", { path: "src/main.ts" }) as { isError?: boolean };
		expect(allowed.isError).toBeUndefined();
		expect(ran).toBe(1);
	});
});
