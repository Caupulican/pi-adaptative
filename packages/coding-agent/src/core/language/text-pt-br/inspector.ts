/**
 * The Brazilian Portuguese words of the workbench's inspector: the plan and team blocks it builds, the headings a group
 * of rows sits under, the state words, counts and hints of those rows, and the group names of the team hierarchy.
 */

import type { FixedSectionId } from "../../tools/orchestration-panel.ts";
import { PANES } from "./panes.ts";

export const INSPECTOR = {
	heading: {
		requirements: "Requisitos",
		evidence: "Evidências",
		taskSteps: "Etapas da tarefa",
		peerFindings: "Achados do peer",
		workers: "Workers",
		backgroundTools: "Ferramentas em segundo plano",
	} satisfies Record<FixedSectionId, string>,
	group: {
		brain: "Mente",
		decider: "Decisor",
		workers: "Workers",
		leaders: "Líderes",
		routing: "Roteamento",
	},
	systemOne: "System One",
	judging: (label: string, elapsed: string) => `avaliando ${label} ${elapsed}`,
	lastJudgment: (label: string) => `última: ${label}`,
	ready: "pronto",
	decidesNext: "decide o próximo passo",
	waitingForYou: "aguardando você",
	root: "mente",
	forRoot: "para a Mente",
	forActor: (name: string) => `para ${name}`,
	requirements: (satisfied: number, total: number) => `${satisfied} / ${total} requisitos`,
	workComplete: (steps: number) => `Trabalho concluído · ${steps} ${steps === 1 ? "etapa" : "etapas"}`,
	noOpenSteps: PANES.noOpenSteps,
	activeTime: (duration: string) => `${duration} ativo`,
	rounds: (count: number) => `${count} ${count === 1 ? "rodada" : "rodadas"}`,
	more: (count: number) => `+${count} mais`,
	failing: (count: number) => `${count} com falha`,
	checkHint: "rodar a mesma verificação de novo, ou /verify dismiss",
	activeFindings: (count: number) => `${count} ${count === 1 ? "ativo" : "ativos"}`,
	findingHint: "responder com evidência, ou /verification waive <id|all> <reason>",
	executorsRunning: (count: number) => `${count} em execução`,
	executorsIdle: "ocioso",
	noWorkersRunning: "Nenhum worker em execução",
};
