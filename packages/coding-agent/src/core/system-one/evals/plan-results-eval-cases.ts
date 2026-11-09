/**
 * The labelled cases of the plan-result measurement (`plan-results-eval.ts`): six shapes in each of English, Portuguese,
 * Spanish and Chinese, with the same labels in every language. Dependent shapes label what a careful reader says a
 * dependent step must do (`changes_dependent_work`) and whether the result states enough to say so
 * (`result_evidence_sufficient`); finding shapes label whether two findings about one place contradict
 * (`findings_contradict`) and whether they say enough to tell (`finding_evidence_sufficient`). Paths, requirement ids and
 * function names stay as they are in every language.
 */

import type { OutcomeStatus } from "../../delegation/worker-outcome-contract.ts";
import type { ResultPacket } from "../../plan/plan-evidence.ts";

export type PlanResultsEvalLanguage = "en" | "pt" | "es" | "zh";

export interface PlanResultsEvalCase {
	readonly id: string;
	readonly language: PlanResultsEvalLanguage;
	/** Dependent cases: the settled step's result. */
	readonly result?: ResultPacket;
	/** Dependent cases: the step that depends on the result. */
	readonly dependent?: { readonly id: string; readonly intent: string };
	/** Dependent cases: the two labels. Absent on finding cases, where those questions are not labelled. */
	readonly labels?: { readonly changes_dependent_work: boolean; readonly result_evidence_sufficient: boolean };
	/** Finding cases: two findings from two steps that cite the same place, with their labels. */
	readonly findings?: {
		readonly a: string;
		readonly b: string;
		readonly cite: string;
		readonly labels: { readonly findings_contradict: boolean; readonly finding_evidence_sufficient: boolean };
	};
}

/** A settled step's result as the judgment reads it: the changes, the open items and the excerpt the case states. */
function settled(
	nodeId: string,
	status: OutcomeStatus,
	changedFiles: readonly string[],
	excerpt: string,
	open: { readonly uncovered?: readonly string[]; readonly remaining?: readonly string[] } = {},
): ResultPacket {
	return {
		nodeId,
		status,
		changedFiles,
		uncovered: open.uncovered ?? [],
		remaining: open.remaining ?? [],
		findings: [],
		receipts: [],
		assurance: "host_check",
		excerpt,
	};
}

export const PLAN_RESULTS_EVAL_CASES: readonly PlanResultsEvalCase[] = [
	// English
	{
		id: "en-rename-open",
		language: "en",
		result: settled("a", "succeeded", ["src/api/client.ts"], "Renamed fetchUser to loadUser in the API client.", {
			remaining: ["renamed fetchUser to loadUser; callers not updated"],
		}),
		dependent: { id: "b", intent: "Add retry to every fetchUser call in src/pages" },
		labels: { changes_dependent_work: true, result_evidence_sufficient: true },
	},
	{
		id: "en-uncovered-requirement",
		language: "en",
		result: settled(
			"a",
			"partial",
			["src/auth/session.ts"],
			"Session handling changed; token refresh is not finished.",
			{
				uncovered: ["R2"],
			},
		),
		dependent: { id: "c", intent: "Build the logout button; refresh already works (R2)" },
		labels: { changes_dependent_work: true, result_evidence_sufficient: true },
	},
	{
		id: "en-docs-only",
		language: "en",
		result: settled("a", "succeeded", ["docs/README.md"], "Documented the install steps."),
		dependent: { id: "b", intent: "Add a unit for parseDate in src/util/date.ts" },
		labels: { changes_dependent_work: false, result_evidence_sufficient: true },
	},
	{
		id: "en-result-unstated",
		language: "en",
		result: settled("a", "succeeded", [], ""),
		dependent: { id: "b", intent: "Wire the export button to the endpoint" },
		labels: { changes_dependent_work: false, result_evidence_sufficient: false },
	},
	{
		id: "en-findings-conflict",
		language: "en",
		findings: {
			a: "hashFile is pure",
			b: "hashFile writes a cache file",
			cite: "src/util/hash.ts:12",
			labels: { findings_contradict: true, finding_evidence_sufficient: true },
		},
	},
	{
		id: "en-findings-agree",
		language: "en",
		findings: {
			a: "get returns null on a miss",
			b: "get returns null when the key is absent",
			cite: "src/store/get.ts:30",
			labels: { findings_contradict: false, finding_evidence_sufficient: true },
		},
	},
	// Portuguese
	{
		id: "pt-rename-open",
		language: "pt",
		result: settled("a", "succeeded", ["src/api/client.ts"], "Renomeei fetchUser para loadUser no cliente da API.", {
			remaining: ["renomeou fetchUser para loadUser; os chamadores não foram atualizados"],
		}),
		dependent: { id: "b", intent: "Adicionar retry a cada chamada de fetchUser em src/pages" },
		labels: { changes_dependent_work: true, result_evidence_sufficient: true },
	},
	{
		id: "pt-uncovered-requirement",
		language: "pt",
		result: settled("a", "partial", ["src/auth/session.ts"], "A sessão mudou; a renovação do token não terminou.", {
			uncovered: ["R2"],
		}),
		dependent: { id: "c", intent: "Criar o botão de sair; a renovação já funciona (R2)" },
		labels: { changes_dependent_work: true, result_evidence_sufficient: true },
	},
	{
		id: "pt-docs-only",
		language: "pt",
		result: settled("a", "succeeded", ["docs/README.md"], "Documentei os passos de instalação."),
		dependent: { id: "b", intent: "Adicionar um teste unitário para parseDate em src/util/date.ts" },
		labels: { changes_dependent_work: false, result_evidence_sufficient: true },
	},
	{
		id: "pt-result-unstated",
		language: "pt",
		result: settled("a", "succeeded", [], ""),
		dependent: { id: "b", intent: "Ligar o botão de exportação ao endpoint" },
		labels: { changes_dependent_work: false, result_evidence_sufficient: false },
	},
	{
		id: "pt-findings-conflict",
		language: "pt",
		findings: {
			a: "hashFile é puro",
			b: "hashFile grava um arquivo de cache",
			cite: "src/util/hash.ts:12",
			labels: { findings_contradict: true, finding_evidence_sufficient: true },
		},
	},
	{
		id: "pt-findings-agree",
		language: "pt",
		findings: {
			a: "get retorna null quando não encontra o item",
			b: "get retorna null quando a chave não existe",
			cite: "src/store/get.ts:30",
			labels: { findings_contradict: false, finding_evidence_sufficient: true },
		},
	},
	// Spanish
	{
		id: "es-rename-open",
		language: "es",
		result: settled(
			"a",
			"succeeded",
			["src/api/client.ts"],
			"Renombré fetchUser a loadUser en el cliente de la API.",
			{
				remaining: ["renombró fetchUser a loadUser; los llamadores no se actualizaron"],
			},
		),
		dependent: { id: "b", intent: "Añadir reintentos a cada llamada de fetchUser en src/pages" },
		labels: { changes_dependent_work: true, result_evidence_sufficient: true },
	},
	{
		id: "es-uncovered-requirement",
		language: "es",
		result: settled(
			"a",
			"partial",
			["src/auth/session.ts"],
			"Cambió el manejo de la sesión; la renovación del token no terminó.",
			{
				uncovered: ["R2"],
			},
		),
		dependent: { id: "c", intent: "Construir el botón de cerrar sesión; la renovación ya funciona (R2)" },
		labels: { changes_dependent_work: true, result_evidence_sufficient: true },
	},
	{
		id: "es-docs-only",
		language: "es",
		result: settled("a", "succeeded", ["docs/README.md"], "Documenté los pasos de instalación."),
		dependent: { id: "b", intent: "Añadir un test unitario para parseDate en src/util/date.ts" },
		labels: { changes_dependent_work: false, result_evidence_sufficient: true },
	},
	{
		id: "es-result-unstated",
		language: "es",
		result: settled("a", "succeeded", [], ""),
		dependent: { id: "b", intent: "Conectar el botón de exportar al endpoint" },
		labels: { changes_dependent_work: false, result_evidence_sufficient: false },
	},
	{
		id: "es-findings-conflict",
		language: "es",
		findings: {
			a: "hashFile es puro",
			b: "hashFile escribe un archivo de caché",
			cite: "src/util/hash.ts:12",
			labels: { findings_contradict: true, finding_evidence_sufficient: true },
		},
	},
	{
		id: "es-findings-agree",
		language: "es",
		findings: {
			a: "get devuelve null si no encuentra la clave",
			b: "get devuelve null cuando la clave no existe",
			cite: "src/store/get.ts:30",
			labels: { findings_contradict: false, finding_evidence_sufficient: true },
		},
	},
	// Chinese
	{
		id: "zh-rename-open",
		language: "zh",
		result: settled("a", "succeeded", ["src/api/client.ts"], "已在 API 客户端中把 fetchUser 重命名为 loadUser。", {
			remaining: ["把 fetchUser 重命名为 loadUser；调用方尚未更新"],
		}),
		dependent: { id: "b", intent: "为 src/pages 中每个 fetchUser 调用添加重试" },
		labels: { changes_dependent_work: true, result_evidence_sufficient: true },
	},
	{
		id: "zh-uncovered-requirement",
		language: "zh",
		result: settled("a", "partial", ["src/auth/session.ts"], "会话处理已修改，令牌刷新尚未完成。", {
			uncovered: ["R2"],
		}),
		dependent: { id: "c", intent: "实现退出登录按钮；令牌刷新已经可用（R2）" },
		labels: { changes_dependent_work: true, result_evidence_sufficient: true },
	},
	{
		id: "zh-docs-only",
		language: "zh",
		result: settled("a", "succeeded", ["docs/README.md"], "已记录安装步骤。"),
		dependent: { id: "b", intent: "为 src/util/date.ts 中的 parseDate 添加单元测试" },
		labels: { changes_dependent_work: false, result_evidence_sufficient: true },
	},
	{
		id: "zh-result-unstated",
		language: "zh",
		result: settled("a", "succeeded", [], ""),
		dependent: { id: "b", intent: "把导出按钮接到该接口" },
		labels: { changes_dependent_work: false, result_evidence_sufficient: false },
	},
	{
		id: "zh-findings-conflict",
		language: "zh",
		findings: {
			a: "hashFile 是纯函数",
			b: "hashFile 会写入缓存文件",
			cite: "src/util/hash.ts:12",
			labels: { findings_contradict: true, finding_evidence_sufficient: true },
		},
	},
	{
		id: "zh-findings-agree",
		language: "zh",
		findings: {
			a: "get 未命中时返回 null",
			b: "键不存在时 get 返回 null",
			cite: "src/store/get.ts:30",
			labels: { findings_contradict: false, finding_evidence_sufficient: true },
		},
	},
];
