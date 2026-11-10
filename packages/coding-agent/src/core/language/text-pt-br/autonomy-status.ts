/**
 * As palavras em português brasileiro do relatório de autonomia da sessão que o `/status` desenha: o título de cada
 * bloco, uma linha por fato, as palavras do estado de uma rotina e das transições de uma máquina, e a frase que diz por
 * que a continuação automática de um objetivo está parada. Nada aqui é lido por um modelo. Folhas que carregam um
 * valor, uma contagem ou uma concordância são funções, então cada língua coloca o valor e concorda com ele do seu jeito.
 */

import type {
	AutonomyAuthorityLine,
	AutonomyAwayChannel,
	AutonomyAwaySettings,
	AutonomyAwayState,
	AutonomyChannelJournal,
	AutonomyCollectionLine,
	AutonomyProactiveLine,
	AutonomyRoutineLine,
	AutonomyRunLine,
} from "../text-en/autonomy-status.ts";
import { SESSIONS } from "./sessions.ts";

export const AUTONOMY_STATUS = {
	head: (at: string) => `Situação da autonomia em ${at}`,
	blocks: {
		goal: "Objetivo",
		plans: "Planos",
		ownerDecisions: "Decisões do dono",
		review: "Revisão",
		sessionFile: "Arquivo da sessão",
		routines: "Rotinas",
		awayDaemon: "Daemon de ausência",
		hostEvents: "Eventos do host",
		actingAhead: "Agir antes",
		proactiveReview: "Revisão proativa",
		channels: "Canais",
		outwardDrafts: "Rascunhos de saída",
		harnessNotices: "Avisos do harness",
		knowledgeCollection: "Coleta de conhecimento",
		authority: "Autoridade",
		systemOne: "System One",
		machines: "Máquinas",
		recentRuns: "Execuções recentes",
	},
	unavailable: (reason: string) => `indisponível: ${reason}`,
	none: "nenhum",
	count: {
		plain: (used: string, max: string) => `${used} de ${max}`,
		money: (used: string, max: string) => `$${used} de $${max}`,
	},
	idle: "ocioso",
	more: (count: number) => `(mais ${count})`,

	goal: {
		line: (text: string, met: number, total: number, status: string) =>
			`Objetivo "${text}": ${met} de ${total} requisitos atendidos, ${status}.`,
		status: (status: string) => {
			const words: Readonly<Record<string, string>> = SESSIONS.goal.statusWords;
			return words[status] ?? status.replace(/_/g, " ");
		},
	},
	autoContinue: {
		no_goal: "Não há objetivo, então nada continua sozinho.",
		finished: "O objetivo terminou, então nada continua sozinho.",
		owner_paused:
			"A continuação automática está parada porque o objetivo está pausado. Use /goal resume para continuar.",
		budget_limit: "A continuação automática está parada porque o objetivo usou todo o orçamento.",
		usage_limit: "A continuação automática está parada porque o limite de uso do provedor foi atingido.",
		owner_answer_needed:
			"A continuação automática está parada: o objetivo está bloqueado e precisa da sua decisão ou resposta.",
		waiting_for_worker: "A continuação automática aguarda um worker terminar.",
		waiting_for_background_task: "A continuação automática aguarda uma tarefa de fundo terminar.",
		off: "A continuação automática está desligada, então o objetivo avança só quando você manda uma mensagem.",
		tools_unavailable:
			"A continuação automática não roda porque as ferramentas de objetivo não estão disponíveis nesta sessão.",
		interrupted:
			"A continuação automática parou porque você interrompeu. Ela recomeça depois da sua próxima mensagem.",
		running: "A continuação automática está trabalhando no objetivo agora.",
		waiting_for_turn: "A continuação automática aguarda o turno atual terminar.",
		scheduled: "A continuação automática começa em instantes.",
		retrying: "A continuação automática falhou e tenta de novo em instantes.",
		not_scheduled: "A continuação automática não está agendada agora. Ela recomeça depois da sua próxima mensagem.",
	},

	ownerDecisions: {
		waiting: (count: number) => `${count} esperando você`,
		item: (what: string, since: string | undefined) => (since === undefined ? what : `${what}, desde ${since}`),
	},

	review: {
		waitingOne: "1 resultado concluído chegou desde a sua última mensagem e espera a sua revisão.",
		waitingMany: (count: number) =>
			`${count} resultados concluídos chegaram desde a sua última mensagem e esperam a sua revisão.`,
		none: "Nenhum resultado concluído espera a sua revisão.",
		noticeOn: (at: number) => `Um aviso em ${at} esperando; nada fica retido.`,
		noticeOff: "O aviso de resultados esperando está desligado; nada fica retido.",
	},

	sessionFile: {
		saving: "Salvando normalmente.",
	},

	routines: {
		wakes: (count: string) => `despertares por resultado (24 h): ${count}`,
		intake: (state: string, reason: string | undefined) =>
			`entrada: ${state}${reason === undefined ? "" : ` (${reason})`}`,
		state: {
			enabled: "ligada",
			paused: "pausada",
			"paused-after-failures": "pausada após falhas repetidas",
			ended: "encerrada",
		},
		line: (line: AutonomyRoutineLine) =>
			`${line.routineId}: ${line.state}${line.ended === undefined ? "" : ` (${line.ended})`}, ${line.schedule}, próxima ${line.next}${line.startsFrom === undefined ? "" : ` (a partir de ${line.startsFrom})`}, última ${line.lastStatus}${line.awayRefusal === undefined ? "" : `, ausência recusada: ${line.awayRefusal}`}${line.pause ?? ""}${line.progress === undefined ? "" : `; onde parou: ${line.progress}`}`,
		pausedAfterFailures: (after: number, reason: string | undefined) =>
			`; pausada após ${after} ${after === 1 ? "falha" : "falhas"}${reason === undefined ? "" : `: ${reason}`}`,
	},

	awayDaemon: {
		state: (state: AutonomyAwayState) =>
			`${state.running ? "em execução" : "parado"}${state.pid === undefined ? "" : ` (pid ${state.pid})`}${state.running ? `, ${state.build}` : ""}, heartbeat ${state.heartbeat}, ${state.activeRoutines} ativas, ${state.dueRoutines} vencidas`,
		settings: (settings: AutonomyAwaySettings) =>
			`ausência ${settings.enabled ? "ligada" : "desligada"}: gasto de $${settings.spent} em $${settings.maxPerDay} (24 h), $${settings.maxPerRun} por execução, ${settings.maxParentHosts} hosts pais (configurações desta sessão; o daemon lê as configurações globais)`,
		parentsHosted: (hosted: string) => `hosts pais: ${hosted}`,
		service: (inspection: string | undefined, reason: string | undefined) =>
			inspection ?? `serviço sempre ativo: indisponível: ${reason}`,
		lastEnd: (reason: string, detail: string | undefined) =>
			`último encerramento: ${reason}${detail === undefined ? "" : `: ${detail}`}`,
		refusedAway: (routineId: string, reason: string) => `${routineId} recusou rodar na ausência: ${reason}`,
		channel: (channel: AutonomyAwayChannel) =>
			`canal ${channel.name} ausente em ${channel.cwd}: servido por ${channel.servedBy}, ${channel.awayDrafts === 1 ? "1 rascunho gravado espera" : `${channel.awayDrafts} rascunhos gravados esperam`} a próxima sessão (channel_reply)`,
	},

	hostEvents: {
		source: (source: string, state: string, reason: string | undefined) =>
			`origem ${source}: ${state}${reason === undefined ? "" : ` (${reason})`}`,
		ledger: (sources: number, subscriptions: number, pending: number, reserved: number) =>
			`registro: ${sources} origens, ${subscriptions} assinaturas, ${pending} entregas pendentes e ${reserved} reservadas`,
		ledgerUnavailable: (reason: string) => `registro: indisponível: ${reason}`,
		githubInterests: (value: string) => `Interesses no GitHub: ${value}`,
	},

	actingAhead: {
		state: (enabled: boolean, attempts: string, spend: string) =>
			`${enabled ? "ligado" : "desligado"}: tentativas ${attempts}, gasto ${spend} (24 h)`,
		episode: (episode: string, phase: string) => `${episode}: ${phase}`,
		patch: (episode: string, present: boolean, ageMinutes: number) =>
			`alteração preparada ${episode}: ${present ? "salva" : "sumiu"}, ${ageMinutes} min de idade`,
	},

	proactiveReview: {
		state: (line: AutonomyProactiveLine) =>
			`${line.enabled ? "ligada" : "desligada"} (${line.delivery}): despertares de turno ${line.turnWakes}, gasto em revisões ${line.reviewSpend} (24 h)${line.lastSkip === undefined ? "" : `, último motivo de dispensa: ${line.lastSkip}`}`,
		setAside: (until: string, label: string) => `deixado de lado até ${until}: ${label}`,
	},

	channels: {
		channel: (name: string, state: string, detail: string | undefined) =>
			`${name}: ${state}${detail === undefined ? "" : ` (${detail})`}`,
		journalUnavailable: (reason: string) => `despertares, gasto, rascunhos: indisponível: ${reason}`,
		journal: (line: AutonomyChannelJournal) =>
			`${line.name}: servido por ${line.servedBy}, ${line.wakes} despertares, ${line.spend} de gasto (24 h), ${line.ownerSpend === undefined ? "" : `gasto do dono ${line.ownerSpend} (24 h), `}${line.ownerFullAuthority ? "autoridade total do dono, " : ""}${line.ownerQuotaUsedPercent === undefined ? "" : `assinatura em ${Math.round(line.ownerQuotaUsedPercent)}% (limites em dólar suspensos), `}${line.pendingMessages} esperando, ${line.pendingDrafts === 1 ? "1 rascunho" : `${line.pendingDrafts} rascunhos`} (${line.awayDrafts} gravados sem sessão aberta), ${line.heldTotal} retidos, ${line.gaps === 1 ? "1 lacuna" : `${line.gaps} lacunas`}`,
	},

	outwardDrafts: {
		counts: (pending: number, approved: number, released: number, dismissed: number) =>
			`${pending} pendentes, ${approved > 0 ? `${approved} aprovados, ` : ""}${released} liberados, ${dismissed} descartados`,
		draft: (toolName: string, classes: string, origin: string, preparedAt: string) =>
			`${toolName} (${classes}) de ${origin}, preparado em ${preparedAt}`,
	},

	knowledgeCollection: {
		line: (line: AutonomyCollectionLine) =>
			`${line.state}${line.reason === undefined ? "" : ` (${line.reason})`}${line.spent === undefined ? "" : `, gasto $${line.spent}${line.max === undefined ? "" : ` de $${line.max}`}`}`,
	},

	harnessNotices: {
		counts: (waiting: number, unsaved: number) => `${waiting} esperam o próximo turno do dono, ${unsaved} não salvos`,
		notice: (kind: string, reason: string) => `${kind}: ${reason}`,
	},

	authority: {
		line: (line: AutonomyAuthorityLine) =>
			`execução: ${line.run}, fronteira ${line.edgeMode}, classes de terceiros: ${line.thirdParty === "" ? "nenhuma" : line.thirdParty}`,
		grant: (grantClass: string, source: string) => `concessão permanente ${grantClass} (${source})`,
	},

	systemOne: {
		noEngine: (cause: string) => `sem motor: ${cause}`,
	},

	machines: {
		line: (name: string, state: string, illegal: number, last: string | undefined) =>
			`${name}: ${state}, ${illegal} ${illegal === 1 ? "transição não declarada" : "transições não declaradas"}${last ?? ""}`,
		noTransition: "nenhuma transição registrada ainda",
		lastRecorded: (state: string) => `última registrada ${state}`,
		last: (from: string, to: string, reason: string) => `, última ${from}->${to} ${reason}`,
	},

	recentRuns: {
		line: (line: AutonomyRunLine) =>
			`${line.runId} ${line.authority}${line.authorityChanged ? " (mudou)" : ""}${line.running ? " em execução" : ""}: ${line.offered} ferramentas oferecidas, ${line.omitted} omitidas, ${line.refused} recusadas`,
		leftOut: (decision: string) => `  deixada de fora ${decision}`,
		refused: (decision: string) => `  recusada ${decision}`,
	},
};
