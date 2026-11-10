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
	teamBadge: (teamId: string, bots: number) => `Equipe: ${teamId} (${bots} ${bots === 1 ? "bot" : "bots"})`,
	teamBadgeOnly: (teamId: string) => `Equipe: ${teamId}`,
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
	sentToTeam: (teamId: string, delivered: number, failed: number) =>
		`Enviado para a equipe ${teamId} (entregue a ${delivered} ${delivered === 1 ? "membro" : "membros"}${failed === 0 ? "" : `, ${failed} ${failed === 1 ? "entrega falhou" : "entregas falharam"}`}).`,
	writingAnswer: "escrevendo a resposta",
	messagesTo: (target: string) => `mensagem para ${target}`,
	messagesPeer: "mensagem para um peer",
	liveBotChat: (agentId: string) => `● CONVERSA AO VIVO COM O BOT · ${agentId}`,
	remote: PANES.roster.remote,
	botFacts: (model: string, thinking: string, state: string) => ` · ${model} · raciocínio ${thinking} · ${state}`,
	unknownModel: "modelo desconhecido",
	defaultThinking: "padrão",
	unknownState: "desconhecido",
	teams: (ids: string) => `Equipes: ${ids}`,
	routines: (list: string) => `Rotinas: ${list}`,
	/** A linha de progresso de uma rotina, parte por parte; o texto de cada parte é o que a execução ou o dono gravou. */
	routineProgress: {
		position: (text: string) => `posição: ${text}`,
		next: (text: string) => `próximo passo: ${text}`,
		ownerNote: (text: string) => `sua anotação: ${text}`,
		recurringSnag: (seenCount: number, what: string, remedy: string | undefined) =>
			`problema recorrente (${seenCount === 1 ? "1 vez" : `${seenCount} vezes`}): ${what}${remedy === undefined ? "" : `; solução tentada: ${remedy}`}`,
		untrusted: "escrito em parte por uma execução que leu texto de terceiros",
	},
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
	/** Uma espera de rotina nas palavras do dono; o modelo lê a sua própria grafia dos mesmos fatos. */
	watch: {
		globChanged: (name: string) => `acompanhando mudanças nos arquivos que casam com ${name}`,
		globCreated: (name: string) => `aguardando um arquivo que casa com ${name} aparecer`,
		globRemoved: (name: string) => `aguardando os arquivos que casam com ${name} serem removidos`,
		fileChanged: (name: string) => `acompanhando mudanças em ${name}`,
		fileCreated: (name: string) => `aguardando ${name} aparecer`,
		fileRemoved: (name: string) => `aguardando ${name} ser removido`,
		processExit: "aguardando um processo gerenciado terminar",
		pidExit: (every: string, pid: number) => `verificando a cada ${every} se o processo ${pid} terminou`,
		port: (port: number, host: string | undefined, every: string, opens: boolean) =>
			`verificando a cada ${every} se a porta ${port}${host === undefined ? "" : ` em ${host}`} ${opens ? "abriu" : "fechou"}`,
		commandCheck: (every: string) => `rodando uma verificação por comando a cada ${every}`,
		http: (host: string, every: string) => `verificando ${host} a cada ${every}`,
	},
	daemonBuildRunning: (build: string | undefined) =>
		build === undefined ? "build sem identificação (um build anterior)" : `build ${build}`,
	daemonBuildSession: (running: string, session: string | undefined) =>
		`${running}; esta sessão roda ${session ?? "um build desconhecido"}`,
	alwaysOnMode: (autostart: string) => `routines.away.autostart está em ${autostart}`,
	alwaysOnMissing: (mode: string, unavailable: string | undefined) =>
		unavailable === undefined
			? `Sempre ativo: não instalado (${mode}); \`/bot daemon service install\` instala.`
			: `Sempre ativo: não instalado (${mode}); não é possível instalar aqui: ${unavailable}`,
	alwaysOnInstalled: (path: string, current: boolean, mode: string, lingerOff: boolean) =>
		`Sempre ativo: instalado em ${path}${current ? "" : " (uma definição antiga; a próxima instalação substitui)"} (${mode}).${lingerOff ? " O lingering está desligado: o serviço roda do login ao logout." : ""}`,
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
		`  Nenhuma mensagem na equipe ${teamId} ainda. Escreva abaixo e tecle Enter para mandar mensagem para a equipe.`,
} satisfies InterfaceText["chat"];
