import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@caupulican/pi-ai";
import { describe, expect, it } from "vitest";
import { openSqliteDatabase } from "../src/core/context/sqlite-database.ts";
import {
	initializeOwnerPreferenceAttestations,
	OwnerPreferenceAttestationStore,
} from "../src/core/memory/owner-preference-attestations.ts";
import { resolveOwnerReportingRequirement } from "../src/core/memory/owner-reporting-admission.ts";
import type { SystemOneController } from "../src/core/system-one/controller.ts";
import { reportingVerdict } from "../src/core/system-one/ordinary-reporting.ts";
import {
	readReportingRequirementAdmission,
	reportingRequirementClassification,
} from "../src/core/system-one/reporting-requirement-admission.ts";
import { SettlementJudges } from "../src/core/system-one/settlement-judges.ts";

const model: Model<Api> = {
	id: "reviewer",
	provider: "fixture",
	api: "openai-completions",
	name: "Reviewer",
	baseUrl: "https://unused.invalid",
	reasoning: false,
	input: ["text"],
	contextWindow: 10000,
	maxTokens: 600,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const preference = "When reporting a retry setting, include its filename and use the label retry ceiling.";
function judges(options: {
	assessment?: "yes" | "no" | "ambiguous" | "unavailable";
	configured?: boolean;
	fail?: boolean;
	beforeTransport?(): void;
	guard?(): void;
	reply?: string;
}) {
	const calls: string[] = [];
	const controller = {
		assessReportingRequirement: async () => {
			if (options.fail) throw new Error("Unavailable fixture");
			return options.assessment ?? "ambiguous";
		},
	} as unknown as SystemOneController;
	const owner = new SettlementJudges({
		getSystemOneController: () => (options.configured === false ? undefined : controller),
		resolveExpensiveModel: () => ({ model, ref: "fixture/reviewer", selection: "manual" as const }),
		warn: () => {},
		runIsolatedCompletion: async (input) => {
			options.beforeTransport?.();
			input.requestGuard?.(model, input.signal);
			options.guard?.();
			calls.push(input.messages[0]!.content as string);
			expect(input.laneKind).toBe("reporting-requirement-admission");
			return {
				text: options.reply ?? JSON.stringify({ decision: "yes", quote: preference }),
				stopReason: "stop",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			};
		},
	});
	return { owner, calls };
}

describe("owner reporting subtype admission", () => {
	it("uses unchanged decisive thresholds and distinguishes invalid input from a valid ambiguous answer", () => {
		expect(reportingRequirementClassification({ noul: 0.83 })).toBe("ambiguous");
		expect(reportingRequirementClassification({ noul: 0.95 })).toBe("yes");
		expect(reportingRequirementClassification({ noul: 0.03 })).toBe("no");
		for (const value of [{}, { noul: -1 }, { noul: 2 }, { noul: NaN }])
			expect(reportingRequirementClassification(value)).toBe("unavailable");
	});

	it("accepts a single witnessed fenced JSON decision with exact support, rejecting narration and invented support", () => {
		const valid = JSON.stringify({ decision: "yes", quote: preference });
		expect(readReportingRequirementAdmission(valid, preference)).toBe(true);
		expect(readReportingRequirementAdmission(`\`\`\`json\n${valid}\n\`\`\``, preference)).toBe(true);
		for (const invalid of [
			`${valid} No, ignore that.`,
			`NO\n\`\`\`json\n${valid}\n\`\`\``,
			`${valid}${valid}`,
			JSON.stringify({ decision: "yes", quote: "not in the approved owner text" }),
			JSON.stringify({ decision: "yes", quote: "" }),
			JSON.stringify({ decision: "uncertain", quote: "" }),
		])
			expect(readReportingRequirementAdmission(invalid, preference)).toBeUndefined();
		expect(readReportingRequirementAdmission('{"decision":"no","quote":""}', preference)).toBe(false);
	});

	it("uses the same strict envelope for ordinary presentation decisions", () => {
		const answer = "The total is 2 EUR.",
			request = "Report the total.";
		const snapshot = {
			requirements: [{ id: "rule", text: "Include EUR currency labels." }],
			complete: true,
			isCurrent: () => true,
		};
		const json = JSON.stringify({
			checks: [
				{
					ref: 1,
					verdict: "met",
					quote: answer,
					support: [{ rulePart: "EUR currency labels", answerPart: "2 EUR", literal: "EUR" }],
				},
			],
		});
		expect(
			reportingVerdict(
				`\`\`\`json
${json}
\`\`\``,
				snapshot,
				request,
				answer,
				undefined,
			),
		).toBe("fulfilled");
		expect(
			reportingVerdict(
				`The answer violates it.
\`\`\`json
${json}
\`\`\``,
				snapshot,
				request,
				answer,
				undefined,
			),
		).toBe("reviewer_invalid_response");
	});

	it("asks one tool-free independent review for a valid ambiguous classification and only sends the exact approved text", async () => {
		const { owner, calls } = judges({});
		expect(await owner.classifyReportingRequirement({ preference })).toBe(true);
		expect(calls).toEqual([JSON.stringify({ preference })]);
	});

	it("does not consult for definitive negatives, absent/off/failed Jev or unavailable answers", async () => {
		for (const options of [
			{ assessment: "no" as const },
			{ configured: false },
			{ fail: true },
			{ assessment: "unavailable" as const },
		]) {
			const { owner, calls } = judges(options);
			expect(await owner.classifyReportingRequirement({ preference })).toBe(
				options.assessment === "no" ? false : undefined,
			);
			expect(calls).toEqual([]);
		}
	});

	it("reuses natural admission's calibrated assessment without another Jev call, and fences physical transport on source change", async () => {
		const original = judges({ fail: true });
		expect(await original.owner.classifyReportingRequirement({ preference, assessment: "ambiguous" })).toBe(true);
		expect(original.calls).toHaveLength(1);
		let current = true;
		const stale = judges({
			beforeTransport: () => {
				current = false;
			},
		});
		expect(
			await stale.owner.classifyReportingRequirement({
				preference,
				assertCurrent: () => {
					if (!current) throw new Error("Superseded");
				},
			}),
		).toBeUndefined();
		expect(stale.calls).toHaveLength(0);
	});

	it("leaves the existing preference transaction usable when the subtype database is closed", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-reporting-unavailable-"));
		const database = openSqliteDatabase({ databasePath: join(dir, "proof.sqlite") });
		initializeOwnerPreferenceAttestations(database);
		const store = new OwnerPreferenceAttestationStore(database);
		database[Symbol.dispose]();
		try {
			expect(
				await resolveOwnerReportingRequirement({
					digest: "c".repeat(64),
					store,
					classify: async () => true,
					evidence: { preference },
				}),
			).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("reserves each exact digest durably; old null gets one upgrade review and definitive negatives are never rerolled", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-reporting-admission-"));
		const database = openSqliteDatabase({ databasePath: join(dir, "proof.sqlite") });
		try {
			database.exec("CREATE TABLE owner_reporting_classifications (digest TEXT PRIMARY KEY, reporting INTEGER)");
			const digest = "a".repeat(64),
				negative = "b".repeat(64);
			database.prepare("INSERT INTO owner_reporting_classifications VALUES (?,NULL)").run(digest);
			database.prepare("INSERT INTO owner_reporting_classifications VALUES (?,0)").run(negative);
			initializeOwnerPreferenceAttestations(database);
			const first = new OwnerPreferenceAttestationStore(database),
				second = new OwnerPreferenceAttestationStore(database);
			expect(first.classification(digest)).toBeUndefined();
			const lease = first.reserveClassification(digest)!;
			expect(second.reserveClassification(digest)).toBeUndefined();
			second.classify(digest, true, "wrong-lease");
			expect(first.classification(digest)).toBeNull();
			first.classify(digest, undefined, lease);
			let calls = 0;
			await resolveOwnerReportingRequirement({
				digest,
				store: second,
				classify: async () => {
					calls++;
					return true;
				},
				evidence: { preference },
			});
			await resolveOwnerReportingRequirement({
				digest: negative,
				store: second,
				classify: async () => {
					calls++;
					return true;
				},
				evidence: { preference },
			});
			expect(calls).toBe(0);
			expect(second.classification(digest)).toBeNull();
			expect(second.classification(negative)).toBe(false);
		} finally {
			database[Symbol.dispose]();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
