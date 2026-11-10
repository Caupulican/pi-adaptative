/**
 * The Brazilian Portuguese words of the work inspector behind the activity lane: its panel labels, the sections its rows
 * sit under, the counts in its summary line and its footer keys. Counts agree with their own noun, and the state a row is
 * drawn in stays the identifier the panel decides on.
 */

import type { InterfaceText } from "../interface-text.ts";

export const AGENTS_OVERLAY = {
	agents: "Agentes",
	work: "Trabalho",
	compact: "Trabalho / Time",
	emptyAgents: "Nenhum agente ou trabalho em segundo plano agora",
	emptyWork: "Nenhum objetivo, plano, agente ou trabalho em segundo plano agora",
	unnamedTask: "Tarefa sem nome",
	kindManaged: "gerenciado",
	kindAgent: "agente",
	reason: (reason: string) => `motivo: ${reason}`,
	started: (time: string) => `iniciado: ${time}`,
	completed: (time: string) => `concluído: ${time}`,
	running: (count: number) => `${count} em execução`,
	queued: (count: number) => `${count} na fila`,
	idle: (count: number) => `${count} ${count === 1 ? "ocioso" : "ociosos"}`,
	backgroundToolCount: (count: number) =>
		`${count} ${count === 1 ? "ferramenta em segundo plano" : "ferramentas em segundo plano"}`,
	goal: (status: string) => `objetivo ${status}`,
	requirements: (satisfied: number, total: number) =>
		`${satisfied}/${total} ${total === 1 ? "requisito" : "requisitos"}`,
	plans: (count: number) => `${count} ${count === 1 ? "plano" : "planos"}`,
	taskStepCount: (count: number) => `${count} ${count === 1 ? "etapa de tarefa" : "etapas de tarefa"}`,
	peerFindingCount: (count: number) => `${count} ${count === 1 ? "achado do peer" : "achados do peer"}`,
	more: (count: number) => `+${count} mais`,
	total: (count: number) => `${count} no total`,
	scope: (scope: string) => `escopo: ${scope}`,
	aboutOutcome: "sobre: um resultado",
	aboutRepository: "sobre: o repositório",
	finished: (count: number) => `${count} ${count === 1 ? "concluído" : "concluídos"}`,
	scrollHint: "rolar",
	pageHint: "página",
	jumpHint: "pular",
	switchChatHint: "trocar de chat",
	closeHint: "fechar",
} satisfies InterfaceText["agentsOverlay"];
