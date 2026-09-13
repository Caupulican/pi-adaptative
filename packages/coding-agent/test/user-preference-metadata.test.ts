import { describe, expect, it } from "vitest";
import {
	collectUserPreferenceEntries,
	describeUserPreferenceStrength,
	formatUserPreferenceLine,
	isUserPreferenceApplicable,
	newUserPreferenceId,
	parseUserPreferenceLine,
	renderUserPreferenceForPrompt,
	stripUserPreferenceMetadata,
	type UserPreferenceMetadata,
} from "../src/core/memory/user-preference-metadata.ts";

const explicitGlobal: UserPreferenceMetadata = {
	id: "3f9c1a2b",
	scope: { kind: "global" },
	basis: "explicit",
	observations: 1,
	revision: 2,
	sources: ["a1b2c3d4/entry-7"],
};

describe("USER.md preference metadata trailer", () => {
	it("round-trips a formatted line and keeps the text clean", () => {
		const line = formatUserPreferenceLine("Prefers short status updates.", explicitGlobal);
		expect(line).toBe(
			"Prefers short status updates. [pref 3f9c1a2b | global | explicit | n=1 | rev=2 | src=a1b2c3d4/entry-7]",
		);
		expect(parseUserPreferenceLine(line)).toEqual({
			text: "Prefers short status updates.",
			metadata: explicitGlobal,
		});
		expect(stripUserPreferenceMetadata(line)).toBe("Prefers short status updates.");
	});

	it("carries the accepted line's evidence time in the trailer and back", () => {
		const withFence = { ...explicitGlobal, evidenceAt: "2026-09-12T20:00:00.000Z" };
		const line = formatUserPreferenceLine("Prefers short status updates.", withFence);
		expect(line).toContain("| rev=2 | at=2026-09-12T20:00:00.000Z | src=a1b2c3d4/entry-7]");
		expect(parseUserPreferenceLine(line).metadata).toEqual(withFence);
		// A malformed time is not a fence and is not written.
		expect(formatUserPreferenceLine("x", { ...explicitGlobal, evidenceAt: "yesterday" })).not.toContain("at=");
	});

	it("keeps the nearest heading path as section context for legacy lines only", () => {
		const entries = collectUserPreferenceEntries(
			"# User profile\n\nArchived preferences: [x](y)\nPrefers tabs.\n## GrimDex engineering roles\nRoot designs; Luna implements.\n### Luna\nLuna owns the UI.\n## Other\nKeep it short. [pref 3f9c1a2b | global | explicit | n=1 | rev=1]\n",
		);
		expect(entries).toEqual([
			{ line: "Prefers tabs." },
			{ line: "Root designs; Luna implements.", section: "GrimDex engineering roles" },
			{ line: "Luna owns the UI.", section: "GrimDex engineering roles › Luna" },
			{ line: "Keep it short. [pref 3f9c1a2b | global | explicit | n=1 | rev=1]", section: "Other" },
		]);
		expect(renderUserPreferenceForPrompt(parseUserPreferenceLine(entries[1].line), entries[1].section)).toBe(
			"- GrimDex engineering roles: Root designs; Luna implements.",
		);
		// An annotated line has verified scope and never borrows a heading.
		expect(renderUserPreferenceForPrompt(parseUserPreferenceLine(entries[3].line), entries[3].section)).toBe(
			"- Keep it short. (explicit)",
		);
	});

	it("treats an unannotated line as legacy: usable, never evidence-backed", () => {
		const parsed = parseUserPreferenceLine("Prefers tabs.");
		expect(parsed).toEqual({ text: "Prefers tabs." });
		expect(describeUserPreferenceStrength(parsed.metadata)).toBe("");
		expect(renderUserPreferenceForPrompt(parsed)).toBe("- Prefers tabs.");
	});

	it("negative control: a malformed or forged trailer is not metadata", () => {
		expect(
			parseUserPreferenceLine("Prefers tabs. [pref zzzz | global | explicit | n=1 | rev=1]").metadata,
		).toBeUndefined();
		expect(
			parseUserPreferenceLine("Prefers tabs. [pref 3f9c1a2b | project=nothex | inferred | n=2 | rev=1]").metadata,
		).toBeUndefined();
		expect(
			parseUserPreferenceLine("Prefers tabs. [pref 3f9c1a2b | global | verified | n=2 | rev=1]").metadata,
		).toBeUndefined();
	});

	it("scopes a project preference to its directory key and labels strength honestly", () => {
		const project: UserPreferenceMetadata = {
			id: newUserPreferenceId("Run the fast test shard first here."),
			scope: { kind: "project", projectKey: "0123456789abcdef" },
			basis: "inferred",
			observations: 2,
			revision: 1,
			sources: ["s1/e1", "s2/e9"],
		};
		const parsed = parseUserPreferenceLine(formatUserPreferenceLine("Run the fast test shard first here.", project));
		expect(parsed.metadata).toEqual(project);
		expect(isUserPreferenceApplicable(parsed.metadata, "0123456789abcdef")).toBe(true);
		expect(isUserPreferenceApplicable(parsed.metadata, "fedcba9876543210")).toBe(false);
		expect(isUserPreferenceApplicable(undefined, "fedcba9876543210")).toBe(true);
		expect(describeUserPreferenceStrength(parsed.metadata)).toBe("inferred, 2 independent observations");
		expect(renderUserPreferenceForPrompt(parsed)).toBe(
			"- Run the fast test shard first here. (inferred, 2 independent observations)",
		);
		expect(newUserPreferenceId("  run the FAST test shard first here.")).toBe(project.id);
	});

	it("drops invalid source ids and bounds the source list", () => {
		const line = formatUserPreferenceLine("Prefers tabs.", {
			...explicitGlobal,
			sources: ["ok/one", "bad id with spaces", ...Array.from({ length: 10 }, (_, i) => `s/${i}`)],
		});
		expect(parseUserPreferenceLine(line).metadata?.sources).toEqual([
			"ok/one",
			"s/0",
			"s/1",
			"s/2",
			"s/3",
			"s/4",
			"s/5",
			"s/6",
		]);
	});
});
