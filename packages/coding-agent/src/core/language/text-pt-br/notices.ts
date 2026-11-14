/**
 * Os avisos em português do Brasil que o host escreve na tela: as linhas de erro e de aviso em volta de uma falha, o
 * que uma compactação e uma nova tentativa dizem ao começar, terminar e cair para a alternativa, e os avisos de uma
 * linha das checagens de início, e as frases dos avisos do harness que o dono lê (o modelo as lê em inglês). Nada daqui
 * chega a um modelo: uma mensagem que uma ferramenta ou um provedor escreveu é entregue inteira e mantém as próprias
 * palavras.
 */

import type { UnansweredReason } from "../../channels/batch-outcome.ts";
import type { ChannelGapRecord } from "../../channels/channel-journal.ts";
import type { KnowledgeNoticeReason } from "../../context/memory-diagnostics.ts";
import type { HostEventReplayGap } from "../../events/host-event-contract.ts";
import type { ExternalKeep } from "../../orchestration/retention.ts";
import type { RetentionHold } from "../../orchestration/retention-eligibility.ts";
import type { SYSTEM_ONE_NO_ENGINE_CAUSE } from "../../system-one/semantic-plane-health.ts";
import type { TurnOriginRecord } from "../../turn-origin.ts";
import type { InterfaceText } from "../interface-text.ts";

/** Por que a coleta de conhecimento parou e o que você pode fazer, pelo motivo que ela informa. */
const KNOWLEDGE_PAUSED: Readonly<Record<KnowledgeNoticeReason, string>> = {
	invalid_settings:
		"os limites de conhecimento do autoLearn são inválidos. Corrija autoLearn.knowledgeMaxUsd, knowledgeSessionMaxUsd, knowledgeIdleDelayMs ou knowledgeMaxSourcesPerPass.",
	no_model: "o modelo do autoLearn não resolve. Defina autoLearn.model como um modelo configurado e com login.",
	model_unpriced:
		"o modelo da coleta não tem preço declarado, então nenhuma requisição limitada pode ser admitida. Defina autoLearn.model como um modelo com preço declarado.",
	no_engine: "nenhum juiz semântico está disponível.",
};

/** Por que uma conversa entregue ficou sem resposta, pelo motivo que o canal registra. */
const UNANSWERED_REASONS: Readonly<Record<UnansweredReason, string>> = {
	not_delivered: "não foi entregue",
	owner_steered: "o dono interveio",
	owner_channel_joined: "o dono entrou pelo canal",
	mixed: "outra origem entrou no turno",
	aborted: "o turno foi interrompido",
	empty_answer: "resposta vazia",
	no_answer: "sem resposta",
};

/** O que continua funcionando enquanto a leitura automática de rotinas está parada, como a frase depois da causa. */
const INTAKE_UNREAD =
	"Pedidos de trabalho automático nas suas mensagens não são lidos enquanto isso durar; a ferramenta de rotinas continua funcionando.";

/** Por que um objetivo fechado fica, nas palavras do aviso. */
const HOLD_WORDS: Readonly<Record<RetentionHold, string>> = {
	unfinished_task: "com uma tarefa inacabada ou não verificada",
	live_attempt: "com um turno ainda em execução",
	pending_notice: "com um aviso ainda não entregue",
	pending_approval: "com uma aprovação pendente",
	open_plan: "sob um plano aberto",
	receipt_outbox: "com um resultado ou cobrança ainda não recebido pela sessão principal",
	awaiting_parent: "cujo último resultado a sessão principal ainda não respondeu",
	host_event_custody: "com eventos do host ainda em trânsito",
	resume_basis: "a partir do qual um agente ativo retoma",
	managed_lane: "cujo worker gerenciado não foi aposentado",
	tree_live: "cuja árvore de workers ainda está rodando",
	referenced: "do qual depende trabalho retido",
};

/** O que mantém um objetivo fechado fora do armazenamento, nas palavras do aviso. */
const EXTERNAL_KEEP_WORDS: Readonly<Record<ExternalKeep, string>> = {
	outcome_undelivered: "com um resultado ainda não entregue à sessão principal",
	delegated_message_pending: "com uma mensagem delegada ainda pendente",
	follower_open: "com um seguidor ainda aberto",
	current_goal: "que é o objetivo atual",
	delegation_open_parent: "sob uma delegação principal aberta",
	legacy_window: "dentro da janela de uma delegação aberta",
	agent_message_pending: "com uma mensagem na fila para um dos agentes dele",
};

/** Por que resultados de CI nunca chegaram a uma sessão, pelo motivo que a lacuna registra. */
const GAP_CAUSES: Readonly<Record<HostEventReplayGap["reason"], string>> = {
	consumer_expired: "a custódia de eventos desta sessão expirou depois que ela ficou fechada por 7 dias",
	consumer_evicted:
		"a custódia de eventos desta sessão foi removida enquanto ela estava fechada, para abrir espaço a sessões ativas",
	consumer_inactive: "a posição de eventos salva desta sessão é mais antiga que o histórico que a fonte guarda",
};

export const NOTICES = {
	earendilJoined: "O pi entrou na Earendil",
	earendilReadPost: "Leia o post do blog:",
	error: (message: string) => `Erro: ${message}`,
	warning: (message: string) => `Aviso: ${message}`,
	toCancel: (keys: string) => `(${keys} para cancelar)`,
	unknownErrorOccurred: "Erro desconhecido ao executar",
	unknownError: "Erro desconhecido",
	errorWord: "Erro",

	compactionCancelled: "Compactação cancelada",
	compactionFailed: "A compactação falhou",
	contextCompacted: "Contexto compactado",
	contextCompactedWithFallback: (cause: string) => `Contexto compactado (alternativa: ${cause})`,
	compactionFallbackLost: (cause: string) =>
		`A compactação caiu para um checkpoint mais simples (${cause}): o resumo narrativo foi perdido; ficaram só os arquivos e os fatos da tarefa.`,
	compactionSkipped: (reason: string) => `Compactação ignorada · ${reason}`,
	compactingContext: (cancelHint: string) => `Compactando o contexto ${cancelHint}`,
	autoCompacting: (overflow: boolean, cancelHint: string) =>
		`${overflow ? "Contexto acima do limite · " : ""}Compactação automática ${cancelHint}`,
	compactionFallbackCause: (cause: string) =>
		(
			({
				unresolved: "o modelo de resumo não está configurado",
				unauthed: "o modelo de resumo não tem credenciais",
				exhausted: "a cota do modelo de resumo acabou",
			}) as Readonly<Record<string, string>>
		)[cause] ?? "o modelo de resumo não respondeu",

	retryCountdown: (attempt: number, maxAttempts: number, seconds: number, keys: string) =>
		`Nova tentativa ${attempt}/${maxAttempts} em ${seconds}s · ${keys} cancelar`,
	retryFailed: (attempts: number, error: string) =>
		`A nova tentativa falhou depois de ${attempts} tentativas: ${error}`,

	unhandledRejection: (headline: string) => `Promise rejeitada sem tratamento. A sessão continua. ${headline}`,

	migratedCredentials: (providers: string) => `Credenciais migradas para auth.json: ${providers}`,
	modelsJsonError: (error: string) => `Erro em models.json: ${error}`,
	themeLoadFailed: (theme: string, error: string) =>
		`Falha ao carregar o tema "${theme}": ${error}\nVoltando para o tema escuro.`,
	autoLearnOfferFailed: (error: string) => `Falha ao oferecer o Auto Learn de novo: ${error}`,
	historyLoadFailed: (error: string) => `Falha ao carregar o histórico da TUI: ${error}`,
	pendingInputResumeFailed: (error: string) => `Falha ao retomar a entrada pendente: ${error}`,
	curatorArchived: (count: number, names: string) =>
		`Curador: ${count} ${count === 1 ? "skill antiga arquivada" : "skills antigas arquivadas"} automaticamente: ${names}. Para restaurar, use /curate restore <name>.`,

	shortcutHandlerError: (message: string) => `Erro no atalho: ${message}`,
	terminalInputHandlerError: (message: string) => `Erro no handler de entrada do terminal: ${message}`,
	handlerFailed: "O handler falhou.",
	extensionError: (extension: string, error: string) => `Erro na extensão "${extension}": ${error}`,

	savingPaused: "Gravação pausada: /resume reabre esta sessão",
	sessionSavePaused:
		"A gravação está pausada: a última escrita no arquivo desta sessão não terminou bem, então nada mais é gravado até o arquivo ser reaberto. O que está na tela continua. Use /resume e escolha esta sessão para reabrir, ou /new para começar outra.",
	resumeThisSession: "Para retomar esta sessão:",

	suspendUnsupported: "Suspender para segundo plano não é suportado no Windows",

	failedToCreateSession: "Falha ao criar a sessão",
	failedToForkSession: "Falha ao fazer fork da sessão",
	/** Uma espera salva com a sua aprovação cujo uso não pôde ser registrado, e cujo salvamento também não pôde ser desfeito. */
	watchArmedApprovalUnrecorded: (watchId: string, cause: string) =>
		`A espera "${watchId}" está armada, mas o uso da sua aprovação da verificação dela não pôde ser registrado e desfazer o salvamento também falhou (${cause}). A aprovação não consta como usada; apague a espera se ela não deve rodar.`,
	/** Por que um resultado de rotina nunca poderá chegar à sessão à qual se destinava (`routine-origin-reach.ts`). */
	routineOriginLoss: (loss: "session-file-gone" | "origin-entry-absent"): string =>
		loss === "session-file-gone"
			? "o arquivo de sessão ao qual ele se destinava não existe mais"
			: "o ponto desta conversa ao qual ele se destinava não está no arquivo da sessão, por exemplo perdido numa queda antes de ser gravado",
	/** Os estados de rotina que o agendador de uma sessão conta como avisos do harness (`routine-state-notices.ts`). */
	routineStates: {
		paused: (routineId: string, after: number) =>
			`A rotina ${routineId} foi pausada após ${after} execuções com falha seguidas e fica pausada até você retomá-la.`,
		unschedulable: (routineId: string, timeZone: string) =>
			`A rotina ${routineId} não pode ser agendada: o fuso horário ${JSON.stringify(timeZone)} não é suportado por este runtime, então ela não roda até você mudar o fuso ou um runtime que o suporte abrir a sessão.`,
		snag: (routineId: string, seenCount: number, held: "paused" | "off" | undefined): string => {
			const stumbling = `continua tropeçando na mesma coisa (${seenCount} execuções até agora).`;
			if (held === undefined)
				return `A rotina ${routineId} ${stumbling} Uma nota pela ferramenta de rotinas chega à próxima execução dela.`;
			const state = held === "paused" ? "pausada até você retomá-la" : "desligada até você ativá-la";
			return `A rotina ${routineId} está ${state}; uma nota pela ferramenta de rotinas chega à primeira execução depois disso. Ela ${stumbling}`;
		},
		resultUndeliverable: (routineId: string, why: string) =>
			`Um resultado da rotina ${routineId} nunca poderá chegar a esta sessão, então ele não espera mais pela entrega: ${why}.`,
		removedOriginLost: (routineId: string) =>
			`A rotina ${routineId} foi removida: o ponto desta sessão em que ela foi salva nunca mais poderá ser alcançado (o arquivo da sessão não existe mais, ou a entrada dela falta no arquivo da sessão), então nenhuma execução dela poderia informar aqui. Salve-a de novo para que continue rodando.`,
	},

	knowledgeCollection: {
		paused: (reason: KnowledgeNoticeReason, _cause: string): string =>
			`A coleta automática de conhecimento está pausada porque ${KNOWLEDGE_PAUSED[reason]}`,
		sessionSpent: (_cause: string): string =>
			"A coleta automática de conhecimento está pausada porque o limite de gasto com conhecimento desta sessão foi atingido (autoLearn.knowledgeSessionMaxUsd). Aumente autoLearn.knowledgeSessionMaxUsd para retomá-la nesta sessão.",
		sourceUnpaid:
			"A coleta automática de conhecimento está pausada porque autoLearn.knowledgeMaxUsd é zero, então nenhuma fonte pode ser paga. Aumente autoLearn.knowledgeMaxUsd para retomá-la.",
		capReached:
			"A coleta automática de conhecimento está pausada porque o teto de custo estimado desta sessão não permite mais gasto.",
	},
	proactiveReview: {
		spendReached:
			"A revisão proativa está pausada porque o gasto com revisões nas últimas 24 horas, somando as sessões deste agente, atingiu proactivity.maxUsdPerDay. As revisões voltam quando o gasto mais antigo sai do dia móvel, ou antes se essa configuração for aumentada.",
		modelUnresolved: (model: string) =>
			`A revisão proativa está pausada porque proactivity.model ${JSON.stringify(model)} não resolve para um modelo disponível. Defina proactivity.model como um modelo configurado e com login, ou remova-o para usar o modelo da sessão.`,
		modelTooSmall:
			"A revisão proativa está pausada porque a faixa de capacidade do modelo dela não permite trilhas em segundo plano. Defina proactivity.model como um modelo com janela de contexto maior.",
	},
	reviewBacklog: (waiting: number) =>
		`${waiting} resultados prontos esperam a sua revisão: trabalho novo se acumula mais rápido do que é revisado. Considere apertar as verificações ou pausar novas ramificações até pôr a revisão em dia; nada foi retido.`,
	routineResultWakesHeld: (bound: number) =>
		`Resultados de rotinas iniciaram ${bound} turnos da sessão principal nas últimas 24 horas, o limite routines.maxResultWakesPerDay; os próximos resultados esperam o seu próximo turno até o dia ter espaço. Aumentar a configuração deixa mais deles iniciarem turnos.`,
	workerLogin: {
		expiredMoved: (name: string, provider: string) =>
			`O seu login em ${name} expirou, então os workers usam outro modelo de assinatura. Rode /login ${provider} para entrar de novo.`,
		expiredUnstarted: (name: string, provider: string) =>
			`O seu login em ${name} expirou, então um worker nele não pôde iniciar. Rode /login ${provider} para entrar de novo.`,
	},
	actAhead: {
		readyReproduced: (sha: string, where: string, files: number, command: string) =>
			`O CI falhou em ${sha}, reproduzido localmente: uma correção está pronta em ${where}, ${files} arquivo(s); \`${command}\` passa com ela. Diga "aplique" para aplicá-la.`,
		readyDiagnosed: (sha: string, where: string, files: number, command: string) =>
			`O CI falhou em ${sha}: uma correção diagnosticada pelo log do CI (a etapa que falhou não roda de novo localmente) está pronta em ${where}, ${files} arquivo(s); \`${command}\` passa com ela. Diga "aplique" para aplicá-la.`,
	},
	systemOneNoEngine: (_cause: typeof SYSTEM_ONE_NO_ENGINE_CAUSE) =>
		"O System One está configurado para esta sessão, mas nenhum motor de decisão foi fornecido, então as chamadas de ferramenta rodam só sob as travas determinísticas, sem a revisão dos efeitos delas pelo System One.",
	ciResults: {
		gap: (count: number, reason: HostEventReplayGap["reason"]) =>
			`Até ${count} ${count === 1 ? "resultado de CI nunca foi entregue" : "resultados de CI nunca foram entregues"} a esta sessão: ${GAP_CAUSES[reason]}. Consulte o CI diretamente para ver os resultados desse período.`,
		journalReplaced:
			"Resultados de CI que esta sessão ainda não tinha recebido foram descartados: o diário de eventos do CI foi substituído porque estava ilegível ou outra versão começou um novo. Consulte o CI diretamente para ver os resultados de antes de agora.",
	},

	soul: {
		holdUnreadable:
			"Uma sessão anterior deixou uma retenção de revisão do soul.md que não pôde ser lida; o soul.md foi aceito como está.",
		holdResumedDeleted:
			"Uma sessão anterior terminou enquanto uma exclusão do soul.md esperava para ser desfeita. Ele foi restaurado.",
		holdResumedChanged:
			"Uma sessão anterior terminou antes de o System One revisar uma mudança no soul.md. A mudança fica no disco, mas não é aceita até o System One revisá-la; ela é revertida se a revisão a rejeitar.",
		writeUnsupported: (error: string) =>
			`As escritas do agente no soul.md são recusadas: ${error}. Configure um motor do System One capaz de rodar a revisão do soul.`,
		writeHeld: (error: string) =>
			`O System One não conseguiu revisar a escrita do agente no soul.md (${error}). Ela está retida, não escrita: o harness a escreve quando o System One a revisar e permitir.`,
		writeReplaced:
			"A escrita retida do soul.md foi descartada: uma escrita mais nova do soul.md foi revisada, permitida e escrita. O texto dela fica no histórico do /soul.",
		writeDropped:
			"A escrita retida do soul.md foi descartada em favor de uma escrita mais nova permitida que não chegou ao fim. O texto dela fica no histórico do /soul.",
		changeHeld: (error: string, attempts: number) =>
			`O soul.md foi alterado durante uma chamada de ferramenta enquanto o System One não conseguia revisá-lo (${error}). A mudança fica no disco, mas não é aceita até o System One revisá-la; ela é revertida após ${attempts} revisões com falha.`,
		changeReplaced:
			"A mudança do soul.md retida para revisão do System One foi substituída por uma mudança mais nova antes de ser revisada.",
		changeAccepted: "O System One revisou e permitiu a mudança retida do soul.md; ela foi aceita.",
		changeAcceptedUnreviewed:
			"A mudança retida do soul.md foi aceita sem revisão: o System One não está mais configurado.",
		changeReverted: (reason: string) => `A mudança retida do soul.md não foi aceita (${reason}); ela foi revertida.`,
		changeWithheld: (attempts: number) =>
			`O System One não conseguiu revisar a mudança retida do soul.md em ${attempts} tentativas; ela foi revertida e o texto dela fica no histórico do /soul.`,
		writeStale:
			"A escrita retida do soul.md não foi escrita: o soul.md mudou desde que ela foi proposta. O texto dela fica no histórico do /soul.",
		writeWithheld: (attempts: number) =>
			`O System One não conseguiu revisar a escrita retida do soul.md em ${attempts} tentativas; ela não foi escrita e o texto dela fica no histórico do /soul.`,
		heldUnsupported: (error: string) =>
			`A escrita retida do soul.md não foi escrita: ${error}. O texto dela fica no histórico do /soul.`,
		writeRejected: (clauses: string) =>
			`O System One rejeitou a escrita retida do soul.md (${clauses}); ela não foi escrita.`,
		writeApplied: "O System One revisou e permitiu a escrita retida do soul.md; o harness a escreveu.",
		writeAppliedUnreviewed:
			"A escrita retida do soul.md foi escrita sem revisão: o System One não está mais configurado.",
		writeLocked:
			"A escrita retida do soul.md foi permitida, mas não escrita: o soul.md continuou bloqueado por outra sessão. O texto dela fica no histórico do /soul.",
	},

	heldActionOrigin: (origin: TurnOriginRecord): string => {
		if (origin.k === "peer-agent") return `um agente par em ${origin.channel ?? "a malha de chat"}`;
		if (origin.k === "host-event") return "um evento escrito por outra pessoa";
		return origin.channel ? `o canal ${origin.channel}` : "uma fonte cuja origem não pôde ser lida";
	},
	heldDraft: (classes: string, origin: string, grants: string) => ({
		head: "Retida, não executada: ",
		tail: ` (${classes}), pedida por ${origin}. Ela roda se você mesmo pedir${grants === "" ? "" : `; ${grants} permite que execuções assim a façam`}.`,
	}),
	heldDraftsFull: (origin: string, max: number) =>
		`Retidas, não executadas: ações pedidas por ${origin}; ${max} ações retidas já esperam por você, então nenhuma outra é registrada. Elas rodam se você mesmo pedir.`,

	channels: {
		notConfigured: (name: string) =>
			`O canal ${name} está registrado, mas não foi iniciado: não há política channels.${name} nas configurações globais nem nas do perfil do diretório.`,
		invalid: (name: string, detail: string | undefined) =>
			`O canal ${name} não foi iniciado: ${detail ?? "a política dele não pode ser lida"}.`,
		servedElsewhere: (name: string) => `O canal ${name} não foi iniciado nesta sessão: outra sessão aberta o atende.`,
		connectionLost: (name: string, detail: string) => `O canal ${name} não está recebendo mensagens: ${detail}.`,
		startFailed: (name: string, detail: string | undefined, builtIn: boolean) =>
			`O canal ${name} não iniciou (${detail ?? "a inicialização falhou"}); ele é tentado de novo quando as configurações mudam ou ${builtIn ? "uma sessão começa" : "o provedor se registra de novo"}.`,
		capped: (name: string, detail: string | undefined) =>
			`O canal ${name} retém mensagens novas: ${detail ?? "o limite diário dele foi atingido"}. Elas esperam até 24 horas.`,
		senderHeld: (name: string, senderId: string) =>
			`O canal ${name} reteve uma mensagem do remetente ${senderId}, que não está em channels.${name}.allowedSenders. Para deixá-lo iniciar turnos, adicione "${senderId}" a essa lista.`,
		senderHeldUnnamed: (name: string) =>
			`O canal ${name} reteve um remetente verificado que não está em channels.${name}.allowedSenders; a ação list do channel_reply mostra o id dele.`,
		gap: (name: string, reason: ChannelGapRecord["reason"], count: number): string =>
			reason === "expired"
				? `Canal ${name}: ${count} mensagem(ns) esperaram mais de 24 horas e foram descartadas sem entrega.`
				: reason === "unanswered"
					? `Canal ${name}: ${count} conversa(s) entregue(s) ficaram sem resposta (o turno terminou sem responder a elas, ou a sessão que as atendia fechou).`
					: `Canal ${name}: o diário dele não pôde ser lido e foi substituído; mensagens e rascunhos que ele guardava não são entregues.`,
		full: (name: string, max: number) =>
			`O canal ${name} recusa mensagens novas: ${max} esperam sem entrega. O provedor é chamado a entregá-las de novo mais tarde.`,
		unanswered: (name: string, reason: UnansweredReason) =>
			`Canal ${name}: uma conversa entregue ficou sem resposta (${UNANSWERED_REASONS[reason]}).`,
		ownerUnanswered: (name: string, reason: UnansweredReason) =>
			`Canal ${name}: uma mensagem do dono ficou sem resposta (${UNANSWERED_REASONS[reason]}).`,
		draftWaits: (name: string, draftId: string, reason: string) =>
			`Canal ${name}: uma resposta espera como rascunho ${draftId} (${reason}). A ferramenta channel_reply a envia ou descarta.`,
		ownerUnverifiable: (name: string) =>
			`Canal ${name}: há remetentes donos listados, mas o transporte não consegue verificá-los; a autoridade do dono está desligada.`,
		ownerUnhostable: (name: string) =>
			`Canal ${name}: há remetentes donos listados, mas esta sessão não pode hospedar turnos do dono; a autoridade do dono está desligada.`,
		away: {
			served: (name: string, parts: readonly string[]) =>
				`Enquanto o daemon atendia o canal ${name}: ${parts.join("; ")}.`,
			drafts: (count: number, listed: readonly string[]) =>
				`${count} rascunho(s) de resposta esperam pelo channel_reply${listed.length > 0 ? ` (${listed.join(", ")})` : ""}`,
			more: (count: number) => `e mais ${count}`,
			expired: (count: number) => `${count} mensagem(ns) expiraram após 24 horas`,
			unanswered: (count: number) => `${count} conversa(s) entregue(s) ficaram sem resposta`,
			held: (count: number, kinds: readonly string[] | undefined) =>
				`${count} mensagem(ns) retida(s)${kinds ? ` (${kinds.join(", ")})` : ""}`,
			notAllowed: (count: number, name: string) => `${count} fora de channels.${name}.allowedSenders`,
			unverified: (count: number) => `${count} não verificada(s)`,
			burst: (count: number, name: string) => `${count} acima de channels.${name}.maxPendingPerConversation`,
		},
	},

	routineIntake: {
		noModel: `A leitura automática de rotinas está inativa: nenhum modelo está disponível para ler as suas mensagens. ${INTAKE_UNREAD}`,
		modelUnpriced: `A leitura automática de rotinas está inativa: o modelo da sessão não declara preços, então a leitura não consegue limitar o próprio gasto. ${INTAKE_UNREAD}`,
		noEngine: `A leitura automática de rotinas está inativa: nenhum juiz capaz de limitar o gasto dela está disponível. ${INTAKE_UNREAD}`,
		budgetExhausted: (maxUsd: number) =>
			`A leitura automática de rotinas está inativa: a verba dela para esta sessão (no máximo $${maxUsd.toFixed(2).replace(".", ",")}, dentro do limite de custo da sessão) foi gasta. ${INTAKE_UNREAD}`,
		sourceSecret:
			"A leitura de rotinas não leu uma mensagem sua que indica um horário porque ela contém texto que parece um segredo. Nenhum pedido de trabalho automático nela foi agendado; você pode repeti-lo sem o segredo.",
		sourceOversize: (maxChars: number) =>
			`A leitura de rotinas não leu uma mensagem sua que indica um horário porque ela passa dos ${maxChars.toLocaleString("pt-BR")} caracteres que a leitura aceita. Nenhum pedido de trabalho automático nela foi agendado; você pode repeti-lo numa mensagem mais curta.`,
		sourcesFailed:
			"A leitura de rotinas parou de ler as suas últimas mensagens após falhas repetidas. Nenhum pedido de trabalho automático nelas foi agendado; você pode repeti-lo.",
		sourcesSpent:
			"A verba da leitura de rotinas para as suas últimas mensagens acabou antes de elas serem lidas. Nenhum pedido de trabalho automático nelas foi agendado; você pode repeti-lo.",
	},
	awayService: {
		available:
			'Rotinas e canais atendidos enquanto nenhuma sessão está aberta só continuam rodando depois de reiniciar se você ativar o modo sempre ligado: defina `routines.away.autostart` como "on" nas suas configurações globais, ou rode `/bot daemon service install`.',
		unavailable: (why: string) =>
			`Rotinas de sessões fechadas e canais atendidos enquanto nenhuma sessão está aberta param ao reiniciar, e o modo sempre ligado não pode ser ativado aqui: ${why}`,
	},
	objectiveLimit: {
		hold: (hold: RetentionHold): string => HOLD_WORDS[hold],
		keep: (keep: ExternalKeep): string => EXTERNAL_KEEP_WORDS[keep],
		summary: (
			counts: {
				readonly kept: number;
				readonly open: number;
				readonly session: number;
				readonly held: number;
				readonly free: number;
			},
			heldParts: readonly string[],
		) =>
			`${counts.kept} objetivos são mantidos no armazenamento desta sessão: ${counts.open} abertos, ${counts.session} de trabalho da sessão (que nunca fecha; as tarefas terminadas dele são liberadas uma a uma, ou com o plano fechado que as nomeia), ${counts.held} fechados e retidos${heldParts.length === 0 ? "" : ` (${heldParts.join(", ")})`} e ${counts.free} fechados sem retenção.`,
		release:
			"Trabalho fechado que nada neste armazenamento retém é liberado no próximo momento ocioso: depois de orchestration.retention.closedObjectiveDays (14 dias por padrão), ou na hora enquanto o armazenamento está quase cheio (0 o mantém por toda a vida da sessão).",
		keptOutside: (total: number, parts: readonly string[]) =>
			`Dos objetivos fechados contados acima sem retenção, ${total} ${total === 1 ? "é mantido" : "são mantidos"} por estado de delegação fora do armazenamento (${parts.join(", ")}); ${total === 1 ? "ele não é liberado" : "eles não são liberados"} no ócio até esse estado terminar.`,
		oldestClosed: (date: string) => `O objetivo fechado mais antigo está fechado desde ${date}.`,
		heldReleased: "Trabalho retido é liberado quando a retenção termina; senão, comece uma nova sessão.",
	},
	ciConnection: {
		commandMissing:
			"Os resultados de CI não são acompanhados: o comando gh não está instalado. Eles começam sozinhos quando o gh estiver instalado e com login.",
		repositoryUnavailable: (error: string) =>
			`Os resultados de CI esperam o GitHub: o repositório não pôde ser resolvido (${error}). Eles voltam sozinhos quando ele responder.`,
		reconcileFailing: (failures: number, error: string) =>
			`Os resultados de CI estão suspensos após ${failures} verificações com falha seguidas (${error}). Eles tentam de novo sozinhos pelo menos a cada 30 minutos.`,
		whileClosed: (since: string, text: string) => `Desde ${since}, enquanto esta sessão estava fechada: ${text}`,
	},

	widgetTruncated: "... (widget truncado)",
	/** O aviso de cobrança de uma sessão autenticada com uma chave de assinatura. */
	anthropicSubscriptionAuth:
		"A autenticação por assinatura da Anthropic está ativa. O uso por harnesses de terceiros é descontado do uso extra e cobrado por token, fora dos limites do seu plano Claude. Gerencie o uso extra em https://claude.ai/settings/usage.",
	/** Uma sessão cujos comandos rodam como os de um worker fechou com alguns deles ainda rodando: foram encerrados. */
	sessionProcessesStopped: (count: number, detail: string) =>
		`Esta sessão fechou com ${count} processo(s) iniciado(s) pelos comandos dela ainda em execução; eles foram encerrados (${detail}). Os comandos dela não deixam nada rodando depois que ela fecha.`,
	billingFailover: {
		continuing: (failed: string, model: string) => `${failed} atingiu a cota — seguindo em ${model}`,
		halted: (model: string) =>
			`O provedor atingiu a cota/limite de ${model}: troque de modelo (/model), espere a janela do limite ou reenvie para tentar de novo`,
		haltedPinned: (model: string) =>
			`O provedor atingiu a cota/limite de ${model}: esta sessão fica no modelo dela; espere a janela do limite ou reenvie para tentar de novo`,
	},
	usageReset: {
		workerWaits: (laneId: string, at: string) =>
			`Worker ${laneId}: o uso da assinatura dele acabou; ele retoma sozinho quando o uso for renovado (${at}).`,
	},
	/** O que a extensão de colaboração relata quando os próprios passos falham: o texto do erro vem em seguida. */
	collaboration: {
		controlHandoffFailed: (error: string) => `Falha no handoff de controle da colaboração: ${error}`,
		cleanupExhausted: (jobId: string, agentId: string, error: string) =>
			`A limpeza da colaboração se esgotou para ${jobId}/${agentId}; o trabalho em andamento segue isolado: ${error}`,
		peerDeliveryFailed: (error: string) => `Falha na entrega a um peer da colaboração: ${error}`,
		handoffFailed: (error: string) => `Falha no handoff da colaboração: ${error}`,
		signalFailed: (error: string) => `Falha no sinal da colaboração: ${error}`,
		restorationFailed: (error: string) => `Falha na restauração da colaboração: ${error}`,
		paneUnverified: (paneId: string, reason: string) =>
			`O painel Herdr ${paneId} não pôde ser verificado (${reason}); o posicionamento volta para managed-workspace.`,
	},
} satisfies InterfaceText["notices"];
