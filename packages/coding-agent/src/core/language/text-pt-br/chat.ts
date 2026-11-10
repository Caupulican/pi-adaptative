/**
 * The Brazilian Portuguese words of the conversation that is not the root chat: the title beside the target it names,
 * the chip that switches back, the status lines and hints under the input, and the header, memory line and empty-chat
 * hint of a bot chat and a team chat. Prose around a command changes; the command never does.
 */

import type { InterfaceText } from "../interface-text.ts";
import { COMMON } from "./common.ts";
import { PANES } from "./panes.ts";

export const CHAT = {
	conversation: "Conversa",
	conversationRoot: "Conversa · Mente",
	conversationOf: (badge: string) => `Conversa · ${badge}`,
	rootBadge: "Mente (raiz)",
	botBadge: (agentId: string, state: string) => `Bot: ${agentId} · ${state}`,
	botBadgeOnly: (agentId: string) => `Bot: ${agentId}`,
	teamBadge: (teamId: string, bots: number) => `Time: ${teamId} (${bots} ${bots === 1 ? "bot" : "bots"})`,
	teamBadgeOnly: (teamId: string) => `Time: ${teamId}`,
	switchBack: "Conversas · Mente ↩",
	switchCount: (count: number) => `Conversas (${count})`,
	switchChip: "Conversas",
	switchedToRoot: "A conversa ativa agora é com a Mente (raiz).",
	sentRemote: (agentId: string) => `Enviado para ${agentId}; a resposta volta aqui.`,
	sentStarted: "ele começou a trabalhar nisso",
	sentFollowedUp: "adicionado à conversa dele",
	sentSteered: "enviado enquanto ele trabalha",
	sentQueued: "na fila para ele",
	sentToBot: (agentId: string, how: string, modelRef: string) => `Enviado para ${agentId}: ${how} (${modelRef}).`,
	sentToTeam: (teamId: string, delivered: number) =>
		`Enviado para o time ${teamId} (entregue a ${delivered} ${delivered === 1 ? "membro" : "membros"}).`,
	writingAnswer: "escrevendo a resposta",
	messagesTo: (target: string) => `mensagem para ${target}`,
	messagesPeer: "mensagem para um peer",
	liveBotChat: (agentId: string) => `● CONVERSA AO VIVO COM O BOT · ${agentId}`,
	remote: PANES.roster.remote,
	botFacts: (model: string, thinking: string, state: string) => ` · ${model} · raciocínio ${thinking} · ${state}`,
	unknownModel: "modelo desconhecido",
	defaultThinking: "padrão",
	unknownState: "desconhecido",
	teams: (ids: string) => `Times: ${ids}`,
	routines: (list: string) => `Rotinas: ${list}`,
	routine: {
		every: (interval: string) => `a cada ${interval}`,
		onceAt: (instant: string) => `uma vez em ${instant}`,
		calendar: (cron: string, timeZone: string) => `"${cron}" em ${timeZone}`,
		branch: (name: string) => `branch ${name}`,
		ownPullRequests: "pull requests próprios",
		by: (authors: string) => `por ${authors}`,
		github: (kinds: string, scope: string) => `no GitHub ${kinds}${scope ? ` (${scope})` : ""}`,
		ci: (conclusions: string, workflowPath: string | undefined) =>
			`no CI ${conclusions}${workflowPath === undefined ? "" : ` de ${workflowPath}`}`,
		mainSessionOnly: "Rotinas da sessão principal pertencem à ferramenta de rotinas do dono.",
	},
	memory: (path: string) => `Memória: ${path}`,
	resumedVia: (reference: string) => `Retomado de ${reference}`,
	directChatHint: (agentId: string) =>
		`Conversa direta ativa: o que você enviar aqui vai direto para ${agentId} · /chat root ou Alt+A volta para a Mente · /bot stop ${agentId} para parar`,
	noMessagesWith: (agentId: string) =>
		`  Nenhuma mensagem com ${agentId} ainda. Escreva abaixo e tecle Enter para mandar mensagem direto para ${agentId}.`,
	waitingToStart: "aguardando para começar",
	starting: "começando",
	noMembers: COMMON.noMembers,
	teamHint: "Escreva para falar com todos · @bot para um só · /chat root volta para a Mente",
	noTeamMessages: (teamId: string) =>
		`  Nenhuma mensagem no time ${teamId} ainda. Escreva abaixo e tecle Enter para mandar mensagem para o time.`,
} satisfies InterfaceText["chat"];
