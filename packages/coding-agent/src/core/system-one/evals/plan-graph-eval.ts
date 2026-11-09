/**
 * Plan graph review measurement: does System One's reading of a plan graph (J1-J4, `plan-graph-review.ts`) agree with
 * labelled plan graphs?
 *
 * Each case is one small plan with the labels a careful reader gives it: whether the request has a part no step covers
 * (J1), whether a candidate pair's later step needs the earlier step's result (J2, with J3 the evidence check), and
 * whether a thin step stands on its own brief (J4). The cases are written in English, Portuguese, Spanish and Chinese
 * and each language carries the same six shapes. The review is the production `reviewPlanGraph`, so the exits and cuts
 * measured are the ones a plan meets. A judgment ships when its agreement reaches the accept cut
 * (`PLAN_GRAPH_EVAL_THRESHOLDS`); an open reading counts as a miss, because it settles nothing.
 */
import type { PlanNodeSpec } from "../../plan/plan-graph.ts";
import type { OperationEffectEngine } from "../operation-classifier.ts";
import { type PlanGraphReviewInput, reviewPlanGraph } from "../plan-graph-review.ts";

export type PlanGraphEvalLanguage = "en" | "pt" | "es" | "zh";

export interface PlanGraphEvalCase {
	readonly id: string;
	readonly language: PlanGraphEvalLanguage;
	/** The owner's request, as the plan must cover it. */
	readonly request: string;
	readonly nodes: readonly { readonly id: string; readonly intent: string }[];
	/** Candidate pairs (earlier, later) with the label: does `later` need `earlier`'s result? */
	readonly pairs: readonly { readonly earlier: string; readonly later: string; readonly needs: boolean }[];
	/** Thin steps with the label: can the step be done from its own brief? */
	readonly thin: readonly { readonly id: string; readonly selfContained: boolean }[];
	/** The label: the request has a part no step covers. */
	readonly gap: boolean;
}

/** The judgments ship when each question agrees with the labels at least this often (the accept cut of `orchestration`). */
export const PLAN_GRAPH_EVAL_THRESHOLDS = Object.freeze({ agreement: 0.9 });

export const PLAN_GRAPH_EVAL_CASES: readonly PlanGraphEvalCase[] = [
	// English
	{
		id: "en-request-gap",
		language: "en",
		request: "Add CSV export to the reports page, document the export format, and rate-limit the export endpoint.",
		nodes: [
			{ id: "a", intent: "Add a CSV export button to the reports page that calls the export endpoint" },
			{ id: "b", intent: "Document the CSV export format in the README" },
		],
		pairs: [],
		thin: [],
		gap: true,
	},
	{
		id: "en-request-covered",
		language: "en",
		request: "Rename the config key timeout to timeoutMs everywhere it is read.",
		nodes: [
			{ id: "a", intent: "Rename the timeout key to timeoutMs in the config loader and its schema" },
			{ id: "b", intent: "Update the docs and examples that show the timeout key" },
		],
		pairs: [],
		thin: [],
		gap: false,
	},
	{
		id: "en-dependency",
		language: "en",
		request: "Store invoices in a new table and list them on the billing page.",
		nodes: [
			{ id: "a", intent: "Create the migration that adds the invoices table" },
			{ id: "b", intent: "Write the query that lists invoices from the invoices table for the billing page" },
		],
		pairs: [{ earlier: "a", later: "b", needs: true }],
		thin: [],
		gap: false,
	},
	{
		id: "en-independent",
		language: "en",
		request: "Fix the footer copyright year and add retries to the webhook sender.",
		nodes: [
			{ id: "a", intent: "Update the copyright year in the site footer" },
			{ id: "b", intent: "Add exponential retries to the webhook sender" },
		],
		pairs: [{ earlier: "a", later: "b", needs: false }],
		thin: [],
		gap: false,
	},
	{
		id: "en-thin-brief",
		language: "en",
		request: "Clean up the import ordering.",
		nodes: [{ id: "a", intent: "Fix the ordering the way we agreed with the client earlier" }],
		pairs: [],
		thin: [{ id: "a", selfContained: false }],
		gap: false,
	},
	{
		id: "en-self-brief",
		language: "en",
		request: "Add a unit test for parseDuration.",
		nodes: [
			{ id: "a", intent: "Add a unit test for parseDuration in src/duration.ts that covers hours and minutes" },
		],
		pairs: [],
		thin: [{ id: "a", selfContained: true }],
		gap: false,
	},
	// Portuguese
	{
		id: "pt-request-gap",
		language: "pt",
		request:
			"Adicione exportação em CSV na página de relatórios, documente o formato e limite a taxa de chamadas do endpoint de exportação.",
		nodes: [
			{
				id: "a",
				intent: "Adicionar o botão de exportação CSV na página de relatórios que chama o endpoint de exportação",
			},
			{ id: "b", intent: "Documentar o formato do CSV no README" },
		],
		pairs: [],
		thin: [],
		gap: true,
	},
	{
		id: "pt-request-covered",
		language: "pt",
		request: "Renomeie a chave de configuração timeout para timeoutMs em todos os lugares.",
		nodes: [
			{ id: "a", intent: "Renomear a chave timeout para timeoutMs no carregador de configuração e no esquema" },
			{ id: "b", intent: "Atualizar a documentação e os exemplos que mostram a chave timeout" },
		],
		pairs: [],
		thin: [],
		gap: false,
	},
	{
		id: "pt-dependency",
		language: "pt",
		request: "Guarde as faturas em uma nova tabela e liste-as na página de cobrança.",
		nodes: [
			{ id: "a", intent: "Criar a migração que adiciona a tabela de faturas" },
			{ id: "b", intent: "Escrever a consulta que lista as faturas da tabela de faturas para a página de cobrança" },
		],
		pairs: [{ earlier: "a", later: "b", needs: true }],
		thin: [],
		gap: false,
	},
	{
		id: "pt-independent",
		language: "pt",
		request: "Corrija o ano do rodapé e adicione novas tentativas ao envio de webhooks.",
		nodes: [
			{ id: "a", intent: "Atualizar o ano de direitos autorais no rodapé do site" },
			{ id: "b", intent: "Adicionar novas tentativas com espera exponencial ao envio de webhooks" },
		],
		pairs: [{ earlier: "a", later: "b", needs: false }],
		thin: [],
		gap: false,
	},
	{
		id: "pt-thin-brief",
		language: "pt",
		request: "Organize a ordem dos imports.",
		nodes: [{ id: "a", intent: "Ajustar a ordem como combinamos antes na conversa com o cliente" }],
		pairs: [],
		thin: [{ id: "a", selfContained: false }],
		gap: false,
	},
	{
		id: "pt-self-brief",
		language: "pt",
		request: "Adicione um teste unitário para parseDuration.",
		nodes: [
			{
				id: "a",
				intent: "Adicionar um teste unitário para parseDuration em src/duration.ts cobrindo horas e minutos",
			},
		],
		pairs: [],
		thin: [{ id: "a", selfContained: true }],
		gap: false,
	},
	// Spanish
	{
		id: "es-request-gap",
		language: "es",
		request:
			"Añade exportación a CSV en la página de informes, documenta el formato y limita las peticiones del endpoint de exportación.",
		nodes: [
			{
				id: "a",
				intent: "Añadir el botón de exportar CSV en la página de informes que llama al endpoint de exportación",
			},
			{ id: "b", intent: "Documentar el formato CSV en el README" },
		],
		pairs: [],
		thin: [],
		gap: true,
	},
	{
		id: "es-request-covered",
		language: "es",
		request: "Renombra la clave de configuración timeout a timeoutMs en todos los sitios donde se lee.",
		nodes: [
			{ id: "a", intent: "Renombrar la clave timeout a timeoutMs en el cargador de configuración y en el esquema" },
			{ id: "b", intent: "Actualizar la documentación y los ejemplos que muestran la clave timeout" },
		],
		pairs: [],
		thin: [],
		gap: false,
	},
	{
		id: "es-dependency",
		language: "es",
		request: "Guarda las facturas en una tabla nueva y muéstralas en la página de facturación.",
		nodes: [
			{ id: "a", intent: "Crear la migración que añade la tabla de facturas" },
			{
				id: "b",
				intent: "Escribir la consulta que lista las facturas de la tabla de facturas para la página de facturación",
			},
		],
		pairs: [{ earlier: "a", later: "b", needs: true }],
		thin: [],
		gap: false,
	},
	{
		id: "es-independent",
		language: "es",
		request: "Corrige el año del pie de página y añade reintentos al envío de webhooks.",
		nodes: [
			{ id: "a", intent: "Actualizar el año de copyright en el pie de página del sitio" },
			{ id: "b", intent: "Añadir reintentos con espera exponencial al envío de webhooks" },
		],
		pairs: [{ earlier: "a", later: "b", needs: false }],
		thin: [],
		gap: false,
	},
	{
		id: "es-thin-brief",
		language: "es",
		request: "Ordena los imports.",
		nodes: [{ id: "a", intent: "Arreglarlo como acordamos antes con el cliente en la conversación anterior" }],
		pairs: [],
		thin: [{ id: "a", selfContained: false }],
		gap: false,
	},
	{
		id: "es-self-brief",
		language: "es",
		request: "Añade un test unitario para parseDuration.",
		nodes: [
			{ id: "a", intent: "Añadir un test unitario para parseDuration en src/duration.ts que cubra horas y minutos" },
		],
		pairs: [],
		thin: [{ id: "a", selfContained: true }],
		gap: false,
	},
	// Chinese
	{
		id: "zh-request-gap",
		language: "zh",
		request: "在报表页面添加 CSV 导出，编写导出格式文档，并为导出接口添加限流。",
		nodes: [
			{ id: "a", intent: "在报表页面添加导出 CSV 按钮，调用导出接口" },
			{ id: "b", intent: "在 README 中编写 CSV 导出格式说明" },
		],
		pairs: [],
		thin: [],
		gap: true,
	},
	{
		id: "zh-request-covered",
		language: "zh",
		request: "把配置项 timeout 全部改名为 timeoutMs。",
		nodes: [
			{ id: "a", intent: "在配置加载器和 schema 中把 timeout 改名为 timeoutMs" },
			{ id: "b", intent: "更新文档和示例中出现的 timeout 配置项" },
		],
		pairs: [],
		thin: [],
		gap: false,
	},
	{
		id: "zh-dependency",
		language: "zh",
		request: "把发票保存到新表中，并在账单页面列出来。",
		nodes: [
			{ id: "a", intent: "创建新增发票表的迁移脚本" },
			{ id: "b", intent: "编写从发票表中查询发票并用于账单页面的查询语句" },
		],
		pairs: [{ earlier: "a", later: "b", needs: true }],
		thin: [],
		gap: false,
	},
	{
		id: "zh-independent",
		language: "zh",
		request: "修正页脚的版权年份，并为 webhook 发送添加重试。",
		nodes: [
			{ id: "a", intent: "更新站点页脚的版权年份" },
			{ id: "b", intent: "为 webhook 发送添加指数退避重试" },
		],
		pairs: [{ earlier: "a", later: "b", needs: false }],
		thin: [],
		gap: false,
	},
	{
		id: "zh-thin-brief",
		language: "zh",
		request: "整理 import 顺序。",
		nodes: [{ id: "a", intent: "按照之前和客户在聊天中说好的方式处理" }],
		pairs: [],
		thin: [{ id: "a", selfContained: false }],
		gap: false,
	},
	{
		id: "zh-self-brief",
		language: "zh",
		request: "为 parseDuration 添加单元测试。",
		nodes: [{ id: "a", intent: "在 src/duration.ts 中为 parseDuration 添加单元测试，覆盖小时和分钟" }],
		pairs: [],
		thin: [{ id: "a", selfContained: true }],
		gap: false,
	},
];

/** A step the labels describe: the file-free intent, no write scope and no brief (the review reads only these). */
function planNode(id: string, intent: string): PlanNodeSpec {
	return {
		id,
		kind: "work",
		intent,
		inputs: [],
		after: [],
		writeScope: [],
		requirementIds: [],
		effort: "normal",
		since: 1,
	};
}

export function planGraphEvalInput(testCase: PlanGraphEvalCase): PlanGraphReviewInput {
	const nodes = testCase.nodes.map((entry) => planNode(entry.id, entry.intent));
	const byId = new Map(nodes.map((node) => [node.id, node]));
	const pairs = testCase.pairs.map((pair) => {
		const earlier = byId.get(pair.earlier);
		const later = byId.get(pair.later);
		if (!earlier || !later) throw new Error(`case ${testCase.id} names a missing step in a pair`);
		return { earlier, later };
	});
	const selfContained = testCase.thin.map((entry) => {
		const node = byId.get(entry.id);
		if (!node) throw new Error(`case ${testCase.id} names a missing thin step`);
		return node;
	});
	return { request: testCase.request, nodes, pairs, selfContained };
}

export interface PlanGraphCaseScore {
	readonly id: string;
	readonly language: PlanGraphEvalLanguage;
	readonly gap: { readonly correct: boolean };
	readonly pairs: readonly {
		readonly pair: string;
		readonly reading: "edge" | "independent" | "open";
		readonly correct: boolean;
	}[];
	readonly thin: readonly {
		readonly id: string;
		readonly reading: "annotated" | "standing";
		readonly correct: boolean;
	}[];
}

export interface PlanGraphEvalSummary {
	readonly cases: readonly PlanGraphCaseScore[];
	/** Agreement per question: the share of labelled answers the review gave, open readings counted as misses. */
	readonly agreement: { readonly coverage: number; readonly dependency: number; readonly brief: number };
	/** Open readings across the set (a question System One did not settle). */
	readonly open: number;
}

/** Runs the production review over every case, sequentially, against the engine the caller passes. */
export async function runPlanGraphEval(
	engine: OperationEffectEngine,
	cases: readonly PlanGraphEvalCase[] = PLAN_GRAPH_EVAL_CASES,
): Promise<PlanGraphEvalSummary> {
	const scores: PlanGraphCaseScore[] = [];
	for (const testCase of cases) {
		const review = await reviewPlanGraph(engine, planGraphEvalInput(testCase));
		const pairs = testCase.pairs.map((pair) => {
			const key = `${pair.earlier}>${pair.later}`;
			const edge = review.addEdges.some((ref) => ref.earlier === pair.earlier && ref.later === pair.later);
			const open = review.open.some((ref) => ref.earlier === pair.earlier && ref.later === pair.later);
			const reading = edge ? "edge" : open ? "open" : "independent";
			return { pair: key, reading, correct: pair.needs ? reading === "edge" : reading === "independent" } as const;
		});
		const thin = testCase.thin.map((entry) => {
			const annotated = review.annotate.includes(entry.id);
			return {
				id: entry.id,
				reading: annotated ? ("annotated" as const) : ("standing" as const),
				correct: entry.selfContained !== annotated,
			};
		});
		scores.push({
			id: testCase.id,
			language: testCase.language,
			gap: { correct: review.gap === testCase.gap },
			pairs,
			thin,
		});
	}
	return summarize(scores);
}

function ratio(correct: number, total: number): number {
	return total === 0 ? 1 : correct / total;
}

function summarize(scores: readonly PlanGraphCaseScore[]): PlanGraphEvalSummary {
	const coverage = scores.map((score) => score.gap.correct);
	const pairs = scores.flatMap((score) => score.pairs);
	const brief = scores.flatMap((score) => score.thin);
	const open = pairs.filter((pair) => pair.reading === "open").length;
	return {
		cases: scores,
		agreement: {
			coverage: ratio(coverage.filter(Boolean).length, coverage.length),
			dependency: ratio(pairs.filter((pair) => pair.correct).length, pairs.length),
			brief: ratio(brief.filter((entry) => entry.correct).length, brief.length),
		},
		open,
	};
}

/** Whether every question clears the accept cut: a judgment ships only when all three do. */
export function planGraphEvalPasses(summary: PlanGraphEvalSummary): boolean {
	return Object.values(summary.agreement).every((value) => value >= PLAN_GRAPH_EVAL_THRESHOLDS.agreement);
}
