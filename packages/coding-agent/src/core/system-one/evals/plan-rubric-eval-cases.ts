/**
 * The labelled cases of the vote rubric measurement (S6, D11): four languages, four shapes each. A shape is one criterion of
 * a vote and one candidate's evidence at a labelled Score level (3 and 2 meet the criterion, 1 and 0 do not), with the same
 * labels in every language. Paths, command names and function names stay as they are in every language.
 *
 * `measurePlanRubric` runs the production `judgeCandidates` over the cases and scores each criterion reading against its
 * label; an open reading is a miss, as in the other plan measurements. Nothing here runs at import time: the owner's
 * `eval:plan-graph` run calls it.
 */

import type { WorkerReportChange } from "../../autonomy/contracts.ts";
import type { ResultPacket } from "../../plan/plan-evidence.ts";
import type { RubricReading } from "../../plan/plan-vote-decision.ts";
import type { OperationEffectEngine } from "../operation-classifier.ts";
import { judgeCandidates, type VoteCandidateEvidence } from "../plan-vote-rubric.ts";
import { PLAN_GRAPH_EVAL_THRESHOLDS } from "./plan-graph-eval.ts";

export type PlanRubricEvalLanguage = "en" | "pt" | "es" | "zh";
export type PlanRubricEvalLevel = 0 | 1 | 2 | 3;

export interface PlanRubricEvalCase {
	readonly id: string;
	readonly language: PlanRubricEvalLanguage;
	/** The labelled Score level of the candidate's evidence against the criterion: 3 and 2 meet it, 1 and 0 do not. */
	readonly level: PlanRubricEvalLevel;
	readonly criterion: string;
	readonly evidence: VoteCandidateEvidence;
}

const CODE_FILE = "src/api/export.ts";
const DOCS_FILE = "docs/export.md";

function evidence(
	file: string,
	what: string,
	excerpt: string,
	receipts: ResultPacket["receipts"] = [],
): VoteCandidateEvidence {
	return {
		memberId: "candidate",
		packet: {
			nodeId: "candidate",
			status: "succeeded",
			changedFiles: [file],
			uncovered: [],
			remaining: [],
			findings: [],
			receipts,
			assurance: "host_check",
			excerpt,
		},
		changes: [{ file, what } satisfies WorkerReportChange],
	};
}

/** One language's wording of the shape: the criterion, what the code change says, and the excerpt at each level. */
interface ShapeText {
	readonly criterion: string;
	/** What the code change says it did (levels 3, 2 and 1 change the same file). */
	readonly change: string;
	/** What the documentation change says it did (level 0 changes only the documentation file). */
	readonly doc: string;
	readonly excerpt3: string;
	readonly excerpt2: string;
	readonly excerpt1: string;
	readonly excerpt0: string;
}

function casesOf(language: PlanRubricEvalLanguage, text: ShapeText): PlanRubricEvalCase[] {
	const at = (level: PlanRubricEvalLevel, candidate: VoteCandidateEvidence): PlanRubricEvalCase => ({
		id: `${language}-rubric-${level}`,
		language,
		level,
		criterion: text.criterion,
		evidence: candidate,
	});
	return [
		at(3, evidence(CODE_FILE, text.change, text.excerpt3, [{ command: "npm run check", exitCode: 0 }])),
		at(2, evidence(CODE_FILE, text.change, text.excerpt2)),
		at(1, evidence(CODE_FILE, text.change, text.excerpt1)),
		at(0, evidence(DOCS_FILE, text.doc, text.excerpt0)),
	];
}

const ENGLISH: ShapeText = {
	criterion: "the export endpoint rejects more than 10 requests per minute",
	change: "per-client limiter on the export route",
	doc: "export format notes",
	excerpt3: "added a 10/min limiter with a 429 response; check passes",
	excerpt2: "added a 10/min limiter",
	excerpt1: "added a limiter; the limit is read from config, default unset",
	excerpt0: "documented the export format",
};

const PORTUGUESE: ShapeText = {
	criterion: "o endpoint de exportação rejeita mais de 10 requisições por minuto",
	change: "limitador por cliente na rota de exportação",
	doc: "notas sobre o formato de exportação",
	excerpt3: "adicionou um limitador de 10/min com resposta 429; a verificação passa",
	excerpt2: "adicionou um limitador de 10/min",
	excerpt1: "adicionou um limitador; o limite é lido da configuração, padrão não definido",
	excerpt0: "documentou o formato de exportação",
};

const SPANISH: ShapeText = {
	criterion: "el endpoint de exportación rechaza más de 10 solicitudes por minuto",
	change: "limitador por cliente en la ruta de exportación",
	doc: "notas sobre el formato de exportación",
	excerpt3: "añadió un limitador de 10/min con respuesta 429; la verificación pasa",
	excerpt2: "añadió un limitador de 10/min",
	excerpt1: "añadió un limitador; el límite se lee de la configuración, sin valor por defecto",
	excerpt0: "documentó el formato de exportación",
};

const CHINESE: ShapeText = {
	criterion: "导出接口拒绝每分钟超过 10 次的请求",
	change: "导出路由上的按客户端限流",
	doc: "导出格式说明",
	excerpt3: "添加了每分钟 10 次的限流器，返回 429；检查通过",
	excerpt2: "添加了每分钟 10 次的限流器",
	excerpt1: "添加了限流器；限额从配置读取，默认未设置",
	excerpt0: "记录了导出格式",
};

export const PLAN_RUBRIC_EVAL_CASES: readonly PlanRubricEvalCase[] = [
	...casesOf("en", ENGLISH),
	...casesOf("pt", PORTUGUESE),
	...casesOf("es", SPANISH),
	...casesOf("zh", CHINESE),
];

export interface PlanRubricCaseScore {
	readonly id: string;
	readonly language: PlanRubricEvalLanguage;
	readonly level: PlanRubricEvalLevel;
	readonly reading: RubricReading;
	readonly correct: boolean;
}

export interface PlanRubricEvalSummary {
	readonly cases: readonly PlanRubricCaseScore[];
	/** The share of cases whose criterion reading matches its label. */
	readonly agreement: number;
	/** Cases whose reading settled neither way (open, or unanswered). */
	readonly open: number;
}

/** A level of 2 or 3 is a criterion met; 1 and 0 are not. */
function expectedReading(level: PlanRubricEvalLevel): "meets" | "fails" {
	return level >= 2 ? "meets" : "fails";
}

/** Runs the production rubric judgment over every case, one case at a time, against the engine the caller passes. */
export async function measurePlanRubric(
	engine: OperationEffectEngine,
	cases: readonly PlanRubricEvalCase[] = PLAN_RUBRIC_EVAL_CASES,
): Promise<PlanRubricEvalSummary> {
	const scores: PlanRubricCaseScore[] = [];
	for (const testCase of cases) {
		const judged = await judgeCandidates(engine, [testCase.criterion], [testCase.evidence]);
		const reading: RubricReading = judged?.[0]?.reading.criteria[0] ?? "open";
		scores.push({
			id: testCase.id,
			language: testCase.language,
			level: testCase.level,
			reading,
			correct: reading === expectedReading(testCase.level),
		});
	}
	const correct = scores.filter((score) => score.correct).length;
	return {
		cases: scores,
		agreement: scores.length === 0 ? 1 : correct / scores.length,
		open: scores.filter((score) => score.reading === "open").length,
	};
}

/** Whether the criterion readings clear the accept cut: the rubric ships only when they do. */
export function planRubricEvalPasses(summary: PlanRubricEvalSummary): boolean {
	return summary.agreement >= PLAN_GRAPH_EVAL_THRESHOLDS.agreement;
}

function percent(value: number): string {
	return `${(value * 100).toFixed(0)}%`;
}

export function formatPlanRubricEval(summary: PlanRubricEvalSummary): string {
	const lines = summary.cases.map((score) =>
		score.correct
			? `${score.id.padEnd(16)} level ${score.level}: agrees (${score.reading})`
			: `${score.id.padEnd(16)} level ${score.level}: differs (${score.reading})`,
	);
	lines.push("");
	lines.push(
		`criterion reading agreement ${percent(summary.agreement)} (need ${percent(PLAN_GRAPH_EVAL_THRESHOLDS.agreement)})`,
	);
	lines.push(`open readings across the rubric set: ${summary.open}`);
	return lines.join("\n");
}
