import { describe, expect, it } from "vitest";
import { enforceExplicitOptionalToolRequest, optionalToolRequestAliases } from "../src/core/tool-applicability-gate.ts";

describe("optional tool applicability gate", () => {
	it("rejects a project-name inference and speculative credential discovery", () => {
		const request =
			"We will work in GrimDex. We have work to finish. I want this to be a pure coding session without needing the work machine.";

		expect(enforceExplicitOptionalToolRequest({ toolName: "trello", aliases: ["trello"], request })).toMatchObject({
			block: true,
		});
		expect(
			enforceExplicitOptionalToolRequest({
				toolName: "secret_store",
				aliases: ["secret store", "credentials", "authentication", "oauth", "api key"],
				request,
			}),
		).toMatchObject({ block: true });
	});

	it("allows tools expressly named by the current owner request", () => {
		expect(
			enforceExplicitOptionalToolRequest({
				toolName: "trello",
				aliases: ["trello"],
				request: "Use Trello to inspect the GrimDex cards before coding.",
			}),
		).toBeUndefined();
		expect(
			enforceExplicitOptionalToolRequest({
				toolName: "secret_store",
				aliases: ["secret store", "credentials", "authentication", "oauth", "api key"],
				request: "Configure the credentials needed for Trello.",
			}),
		).toBeUndefined();
	});

	it("requires whole alias words instead of substrings", () => {
		expect(
			enforceExplicitOptionalToolRequest({
				toolName: "trello",
				aliases: ["trello"],
				request: "Inspect the trellometer implementation.",
			}),
		).toMatchObject({ block: true });
	});

	it("gates profile extensions while leaving built-in and bundled tools alone", () => {
		const source = (name: string) => ({
			path: `/extensions/${name}/index.ts`,
			source: name,
			scope: "user" as const,
			origin: "top-level" as const,
		});

		expect(optionalToolRequestAliases("trello", source("profile"))).toEqual(["trello"]);
		expect(optionalToolRequestAliases("pi_collaboration", source("bundled"))).toBeUndefined();
		expect(optionalToolRequestAliases("read", source("builtin"))).toBeUndefined();
		expect(optionalToolRequestAliases("secret_store", source("builtin"))).toContain("credentials");
	});

	it("admits only the active extension verifier while retaining credential and unrelated-tool gates", () => {
		const source = {
			path: "/extensions/new-tool.ts",
			source: "local",
			scope: "temporary" as const,
			origin: "top-level" as const,
		};
		const verification = () => ({ toolName: "new_probe", path: source.path });
		expect(optionalToolRequestAliases("new_probe", source, verification)).toBeUndefined();
		expect(optionalToolRequestAliases("other_probe", source, verification)).toEqual(["other probe"]);
		expect(
			optionalToolRequestAliases("new_probe", { ...source, path: "/extensions/unrelated.ts" }, verification),
		).toEqual(["new probe"]);
		expect(optionalToolRequestAliases("new_probe", source, () => undefined)).toEqual(["new probe"]);
		expect(
			optionalToolRequestAliases("secret_store", source, () => ({ toolName: "secret_store", path: source.path })),
		).toContain("credentials");
	});
});
