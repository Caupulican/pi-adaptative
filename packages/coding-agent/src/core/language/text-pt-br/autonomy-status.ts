/**
 * As palavras em português brasileiro do relatório de autonomia da sessão que o `/status` desenha: o título de cada
 * bloco, uma linha por fato, as palavras do estado de uma rotina, de uma máquina e de cada identificador que a sessão
 * guarda, e a frase que diz por que a continuação automática de um objetivo está parada. Um valor que é identificador é
 * palavra aqui; um texto que alguém escreveu é desenhado como veio. Nada aqui é lido por um modelo. Folhas que carregam
 * um valor, uma contagem ou uma concordância são funções, então cada língua coloca o valor e concorda com ele do seu
 * jeito.
 */

import type { RoutineStatusItem, StatusUnavailableCause } from "../../autonomy-status/autonomy-status.ts";
import type { ChannelServedBy } from "../../channels/away-channels.ts";
import type { ChannelRuntimeState } from "../../channels/session-channels.ts";
import type { BotDaemonEnd } from "../../delegation/bot-team-routine-helpers.ts";
import type { HostEventConnectionView } from "../../events/host-event-contract.ts";
import type { KnowledgeCollectionInactiveReason } from "../../memory/knowledge-collector.ts";
import type { ActAheadPhase } from "../../proactivity/act-ahead-record.ts";
import type { RoutineDefinitionView } from "../../routines/routine-contract.ts";
import type { RoutineIntakeInactiveReason, RoutineIntakeStatus } from "../../routines/routine-intake.ts";
import type { SYSTEM_ONE_NO_ENGINE_CAUSE } from "../../system-one/semantic-plane-health.ts";
import type { TurnAuthority, TurnOriginKind } from "../../turn-origin.ts";
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
	AutonomyStatusBlockKey,
} from "../text-en/autonomy-status.ts";
import { SESSIONS } from "./sessions.ts";

/** A entrada de rotinas e a coleta de conhecimento dizem o mesmo estado; as duas são femininas em português. */
const ACTIVE_STATE: Readonly<Record<"active" | "inactive", string>> = { active: "ativa", inactive: "inativa" };

/**
 * Por que a entrada de rotinas e a coleta de conhecimento não começam. Os códigos vêm do domínio, e o mesmo código tem
 * a mesma razão nas duas, então a tabela é uma só.
 */
const INACTIVE_REASON: Readonly<Record<KnowledgeCollectionInactiveReason | RoutineIntakeInactiveReason, string>> = {
	disabled: "desligada nas configurações",
	configuration_unreadable: "as configurações não puderam ser lidas",
	invalid_settings: "as configurações são inválidas",
	no_model: "nenhum modelo configurado",
	model_unpriced: "o modelo não tem preço cadastrado",
	no_engine: "sem motor",
	budget_exhausted: "orçamento esgotado",
	accounting_unresolved: "os gastos ainda não fecharam",
	ephemeral_session: "a sessão não é salva",
	child_session: "esta sessão não grava a memória do dono",
	memory_unavailable: "a memória não está disponível",
};

/** O estado de um canal, pelo identificador que a sessão guarda. */
const CHANNEL_STATE: Readonly<Record<ChannelRuntimeState, string>> = {
	not_configured: "não configurado",
	invalid: "inválido",
	ignored: "ignorado",
	served_elsewhere: "atendido em outro lugar",
	starting: "iniciando",
	armed: "ativo",
	suspended: "suspenso",
	capped: "limitado",
	stopped: "parado",
};

/** Quem atende um canal agora, pelo identificador que o registro do canal guarda. */
const SERVED_BY: Readonly<Record<ChannelServedBy, string>> = {
	"this session": "atendido por esta sessão",
	"the daemon": "atendido pelo daemon",
	"another session": "atendido por outra sessão",
	nobody: "ninguém atende",
};

/** Por que uma rotina terminou, pelo identificador que o relatório guarda. */
const ROUTINE_ENDED: Readonly<Record<NonNullable<RoutineStatusItem["ended"]>, string>> = {
	spent: "execução única feita",
	condition: "condição atingida",
	expired: "prazo vencido",
};

/** O tipo de agenda de uma rotina, pelo identificador que a definição guarda. */
const SCHEDULE_KIND: Readonly<Record<RoutineStatusItem["schedule"], string>> = {
	interval: "intervalo",
	once: "uma vez",
	calendar: "calendário",
	event: "evento",
};

/** Como o daemon de ausência terminou da última vez, pelo identificador que o lease guarda. */
const DAEMON_END: Readonly<Record<BotDaemonEnd["reason"], string>> = {
	released: "uma sessão o parou",
	signal: "o processo dele foi interrompido",
	failed: "erro",
};

/** O estado da ligação de uma origem de eventos do host; sem estado, a origem está ativa. */
const SOURCE_STATE: Readonly<Record<HostEventConnectionView["state"], string>> = {
	armed: "ativa",
	waiting: "aguardando",
	suspended: "suspensa",
};

/** A fase de um episódio de agir antes, pelo identificador que o registro guarda. */
const ACT_AHEAD_PHASE: Readonly<Record<ActAheadPhase, string>> = {
	armed: "preparado",
	admitted: "admitido",
	working: "trabalhando",
	ready: "pronto",
	abandoned: "abandonado",
	capped: "limitado",
	settled: "concluído",
};

/** O estado da última execução de uma rotina; a linha diz "última", então a palavra concorda com ela. */
const RUN_STATUS: Readonly<Record<NonNullable<RoutineDefinitionView["lastStatus"]>, string>> = {
	queued: "na fila",
	running: "em execução",
	succeeded: "concluída",
	failed: "falhou",
	cancelled: "cancelada",
	uncertain: "incerta",
};

/** A autoridade que uma execução detém, pelo identificador que ela guarda. */
const TURN_AUTHORITY: Readonly<Record<TurnAuthority, string>> = {
	owner: "dono",
	"remote-owner": "dono remoto",
	"third-party": "terceiro",
};

/** De onde vieram as palavras de uma execução, pelo identificador que o turno guarda. */
const TURN_ORIGIN: Readonly<Record<TurnOriginKind, string>> = {
	"owner-typed": "mensagem digitada",
	"extension-message": "mensagem de extensão",
	routine: "rotina",
	"host-event": "evento do host",
	"peer-agent": "agente peer",
	"inbound-channel": "mensagem de canal",
	"owner-channel": "canal do dono",
	"worker-result": "resultado de worker",
	"goal-continuation": "continuação de objetivo",
	"proactive-review": "revisão proativa",
	harness: "harness",
};

/**
 * A descrição que o mapa `describe` de uma máquina dá a cada estado. A chave é o nome da máquina, sem o número da
 * instância que o registro do estado acrescenta; uma máquina sem descrição fica com a que o domínio deu.
 */
const MACHINE_STATE: Readonly<Record<string, Readonly<Record<string, string>>>> = {
	"fleet-admission": {
		running: "admitindo workers conforme o espaço disponível",
		stopped: "parada: nada novo começa até retomar",
	},
	"plan-node": {
		planned: "aguardando as etapas anteriores",
		ready: "pronta para começar",
		admitted: "começando",
		running: "em execução",
		settled: "concluída",
		held: "retida",
		superseded: "substituída",
		cancelled: "cancelada",
	},
	"worker-outcome": {
		none: "sem resultado ainda",
		succeeded: "concluído",
		partial: "feito em parte",
		blocked: "bloqueado",
		failed: "falhou",
		cancelled: "cancelado",
	},
};

/** Por que uma seção não traz o que o relatório pede: a frase em inglês continua ao lado do código, na própria seção. */
const UNAVAILABLE_CAUSE: Readonly<Record<StatusUnavailableCause, string>> = {
	routine_store: "o armazenamento de rotinas não está carregado nesta sessão",
	child_session: "esta sessão não guarda rotinas",
	service_routine_store: "o armazenamento de rotinas não está carregado, então o serviço não é lido",
	away_parents: "o daemon de ausência não registra as sessões pai que hospeda",
	worker_ledger: "o registro de workers não está carregado nesta sessão",
	no_edge_grants: "a sessão não fornece concessões de fronteira",
};

/** O vazio de cada bloco: estes títulos são femininos e pedem "nenhuma", e os outros ficam com "nenhum". */
const EMPTY_WORD: Readonly<Partial<Record<AutonomyStatusBlockKey, string>>> = {
	ownerDecisions: "nenhuma",
	review: "nenhuma",
	routines: "nenhuma",
	proactiveReview: "nenhuma",
	knowledgeCollection: "nenhuma",
	authority: "nenhuma",
	machines: "nenhuma",
	recentRuns: "nenhuma",
};

/** O nome da máquina, sem o número da instância que o registro do estado acrescenta (`fleet-admission#1`). */
function machineName(label: string): string {
	return label.replace(/#\d+$/, "");
}

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
	unavailable: (cause: StatusUnavailableCause | undefined, reason: string) =>
		`indisponível: ${cause === undefined ? reason : UNAVAILABLE_CAUSE[cause]}`,
	none: (block: AutonomyStatusBlockKey) => EMPTY_WORD[block] ?? "nenhum",
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
		noticeOn: (at: number) => `Um aviso ao chegar a ${at} resultados esperando; nada fica retido.`,
		noticeOff: "O aviso de resultados esperando está desligado; nada fica retido.",
	},

	sessionFile: {
		saving: "Salvando normalmente.",
	},

	routines: {
		wakes: (count: string) => `turnos iniciados por resultados (24 h): ${count}`,
		intake: (state: RoutineIntakeStatus["state"], reason: RoutineIntakeInactiveReason | undefined) =>
			`entrada: ${ACTIVE_STATE[state]}${reason === undefined ? "" : ` (${INACTIVE_REASON[reason]})`}`,
		state: {
			enabled: "ligada",
			paused: "pausada",
			"paused-after-failures": "pausada após falhas repetidas",
			ended: "encerrada",
		},
		ended: (reason: NonNullable<RoutineStatusItem["ended"]>) => ROUTINE_ENDED[reason],
		schedule: (kind: RoutineStatusItem["schedule"]) => SCHEDULE_KIND[kind],
		lastStatus: (status: NonNullable<RoutineDefinitionView["lastStatus"]>) => RUN_STATUS[status],
		line: (line: AutonomyRoutineLine) =>
			`${line.routineId}: ${line.state}${line.ended === undefined ? "" : ` (${line.ended})`}, ${line.schedule}, próxima ${line.next}${line.startsFrom === undefined ? "" : ` (a partir de ${line.startsFrom})`}, última ${line.lastStatus}${line.awayRefusal === undefined ? "" : `, ausência recusada: ${line.awayRefusal}`}${line.pause ?? ""}${line.originLoss ?? ""}${line.progress === undefined ? "" : `; onde parou: ${line.progress}`}`,
		pausedAfterFailures: (after: number, reason: string | undefined) =>
			`; pausada após ${after} ${after === 1 ? "falha" : "falhas"}${reason === undefined ? "" : `: ${reason}`}`,
		originLoss: (run: "undelivered" | "unstarted", at: string, why: string): string =>
			run === "undelivered"
				? `; um resultado não pôde ser entregue (${at}): ${why}`
				: `; uma execução foi cancelada antes de começar (${at}): ${why}`,
	},

	awayDaemon: {
		state: (state: AutonomyAwayState) =>
			`${state.running ? "em execução" : "parado"}${state.pid === undefined ? "" : ` (pid ${state.pid})`}${state.running ? `, ${state.build}` : ""}, heartbeat ${state.heartbeat}, ${state.activeRoutines} ativas, ${state.dueRoutines} vencidas`,
		settings: (settings: AutonomyAwaySettings) =>
			`ausência ${settings.enabled ? "ligada" : "desligada"}: gasto $${settings.spent} de $${settings.maxPerDay} (24 h), $${settings.maxPerRun} por execução, até ${settings.maxParentHosts} ${settings.maxParentHosts === 1 ? "sessão pai" : "sessões pai"} (configurações desta sessão; o daemon lê as configurações globais)`,
		parentsHosted: (hosted: string) => `sessões pai hospedadas: ${hosted}`,
		service: (inspection: string | undefined, unavailable: string) =>
			inspection ?? `serviço sempre ativo: ${unavailable}`,
		lastEnd: (reason: BotDaemonEnd["reason"], detail: string | undefined) =>
			`último encerramento: ${DAEMON_END[reason]}${detail === undefined ? "" : `: ${detail}`}`,
		refusedAway: (routineId: string, reason: string) => `${routineId} recusou rodar na ausência: ${reason}`,
		channel: (channel: AutonomyAwayChannel) =>
			`canal ${channel.name} na ausência, em ${channel.cwd}: ${SERVED_BY[channel.servedBy]}, ${channel.awayDrafts === 1 ? "1 rascunho gravado espera" : `${channel.awayDrafts} rascunhos gravados esperam`} a próxima sessão (channel_reply)`,
	},

	hostEvents: {
		source: (source: string, state: HostEventConnectionView["state"], reason: string | undefined) =>
			`origem ${source}: ${SOURCE_STATE[state]}${reason === undefined ? "" : ` (${reason})`}`,
		ledger: (sources: number, subscriptions: number, pending: number, reserved: number) =>
			`registro: ${sources} origens, ${subscriptions} assinaturas, ${pending} entregas pendentes e ${reserved} reservadas`,
		ledgerUnavailable: (unavailable: string) => `registro: ${unavailable}`,
		githubInterests: (value: string) => `Interesses no GitHub: ${value}`,
	},

	actingAhead: {
		state: (enabled: boolean, attempts: string, spend: string) =>
			`${enabled ? "ligado" : "desligado"}: tentativas ${attempts}, gasto ${spend} (24 h)`,
		episode: (episode: string, phase: ActAheadPhase) => `${episode}: ${ACT_AHEAD_PHASE[phase]}`,
		patch: (episode: string, present: boolean, ageMinutes: number) =>
			`alteração preparada ${episode}: ${present ? "salva" : "sumiu"}, ${ageMinutes} min de idade`,
	},

	proactiveReview: {
		state: (line: AutonomyProactiveLine) =>
			`${line.enabled ? "ligada" : "desligada"} (${line.delivery}): turnos iniciados ${line.turnWakes}, gasto em revisões ${line.reviewSpend} (24 h)${line.lastSkip === undefined ? "" : `, último motivo de dispensa: ${line.lastSkip}`}`,
		setAside: (until: string, label: string) => `deixado de lado até ${until}: ${label}`,
	},

	channels: {
		channel: (name: string, state: ChannelRuntimeState, detail: string | undefined) =>
			`${name}: ${CHANNEL_STATE[state]}${detail === undefined ? "" : ` (${detail})`}`,
		journalUnavailable: (unavailable: string) => `turnos iniciados, gasto, rascunhos: ${unavailable}`,
		journal: (line: AutonomyChannelJournal) =>
			`${line.name}: ${SERVED_BY[line.servedBy]}, ${line.wakes} turnos iniciados, ${line.spend} de gasto (24 h), ${line.ownerSpend === undefined ? "" : `gasto do dono ${line.ownerSpend} (24 h), `}${line.ownerFullAuthority ? "autoridade total do dono, " : ""}${line.ownerQuotaUsedPercent === undefined ? "" : `assinatura em ${Math.round(line.ownerQuotaUsedPercent)}% (limites em dólar suspensos), `}${line.pendingMessages} esperando, ${line.pendingDrafts === 1 ? "1 rascunho" : `${line.pendingDrafts} rascunhos`} (${line.awayDrafts} gravados sem sessão aberta), ${line.heldTotal} retidos, ${line.gaps === 1 ? "1 lacuna" : `${line.gaps} lacunas`}`,
	},

	outwardDrafts: {
		counts: (pending: number, approved: number, released: number, dismissed: number) =>
			`${pending} pendentes, ${approved > 0 ? `${approved} aprovados, ` : ""}${released} liberados, ${dismissed} descartados`,
		draft: (toolName: string, classes: string, origin: string, preparedAt: string) =>
			`${toolName} (${classes}) de ${origin}, preparado em ${preparedAt}`,
	},

	knowledgeCollection: {
		line: (line: AutonomyCollectionLine) =>
			`${ACTIVE_STATE[line.state]}${line.reason === undefined ? "" : ` (${INACTIVE_REASON[line.reason]})`}${line.spent === undefined ? "" : `, gasto $${line.spent}${line.max === undefined ? "" : ` de $${line.max}`}`}`,
	},

	harnessNotices: {
		counts: (waiting: number, unsaved: number) => `${waiting} esperam o próximo turno do dono, ${unsaved} não salvos`,
		notice: (kind: string, reason: string) => `${kind}: ${reason}`,
	},

	authority: {
		line: (line: AutonomyAuthorityLine) =>
			`execução: ${line.run}, fronteira ${line.edgeMode}, classes de terceiros: ${line.thirdParty === "" ? "nenhuma" : line.thirdParty}`,
		held: (authority: TurnAuthority) => TURN_AUTHORITY[authority],
		origin: (origin: TurnOriginKind) => TURN_ORIGIN[origin],
		grant: (grantClass: string, source: string) => `concessão permanente ${grantClass} (${source})`,
	},

	systemOne: {
		state: (state: "on" | "off") => (state === "on" ? "ligado" : "desligado"),
		noEngine: (_cause: typeof SYSTEM_ONE_NO_ENGINE_CAUSE) =>
			"sem motor: o System One está configurado para esta sessão, mas nenhum motor de decisão foi fornecido",
	},

	machines: {
		plain: (name: string, state: string, description: string) =>
			MACHINE_STATE[machineName(name)]?.[state] ?? description,
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
