/**
 * The Brazilian Portuguese lines of the operator's status: what the session is doing, why, and what comes next. A goal's
 * status word is an identifier in the data, so the words the owner reads for it are written here.
 */

import type { InterfaceText } from "../interface-text.ts";

/** The owner's words for a goal that is not executing, by the goal's status. */
const DORMANT_GOAL: Readonly<Record<string, string>> = {
	paused: "pausado",
	usage_limited: "parado no limite de uso",
	budget_limited: "parado no limite de orçamento",
	cancelled: "cancelado",
};

export const STATUS = {
	ready: "Aguardando instruções",
	dormantGoal: (status: string) => `Objetivo ${DORMANT_GOAL[status] ?? status.replace("_", " ")}`,
	framing: (goal: string) => `Entendendo ${goal}`,
	decomposing: (goal: string | undefined) =>
		goal ? `Dividindo em etapas: ${goal}` : "Dividindo o objetivo em etapas",
	implementing: "Implementando",
	operatorTurn: "Trabalhando no seu pedido",
	adapting: "Adaptando o runtime",
	fastIteration: "iteração rápida · validação direcionada",
	runningProof: "Rodando a prova de aceitação",
	delivering: "Entregando as mudanças autorizadas",
	completed: (goal: string | undefined) => (goal ? `Concluído: ${goal}` : "Objetivo concluído"),
	working: "Trabalhando",
	standingBy: "Nada em andamento",
	criteriaSatisfied: (satisfied: number, total: number) => `${satisfied}/${total} critérios de aceitação atendidos`,
	deliveredWith: (satisfied: number, total: number) => `Entregue com ${satisfied}/${total} critérios atendidos`,
	advancing: "Avançando no objetivo",
	nextVerify: (pending: number) =>
		pending > 0
			? `verificar ${pending} ${pending === 1 ? "critério em aberto" : "critérios em aberto"}`
			: "verificar",
	nextDeliver: "entregar",
	rootActor: "Mente",
	semanticPlane: {
		ok: "ok",
		degraded: (detail: string | undefined) => (detail === undefined ? "degradado" : `degradado · ${detail}`),
		evaluating: "avaliando",
		ready: "pronto",
		noEngine: "sem motor",
		off: "desligado",
		uncertain: (value: string, count: number) => `${value} · ${count} em dúvida`,
	},
	workerActor: (shortId: string) => `Worker ${shortId}`,
} satisfies InterfaceText["status"];
