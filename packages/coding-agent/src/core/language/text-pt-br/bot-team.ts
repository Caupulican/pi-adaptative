/**
 * As palavras de `/bot` e `/team`: as linhas de uso, o que cada comando fez, o editor de soul, as listas, a caixa de
 * entrada e as confirmações, as rotinas agendadas e `/bot daemon` com o serviço sempre ativo. O comando e os argumentos
 * nunca mudam; a prosa em volta muda. Os fatos que um comando lê do núcleo são argumentos aqui, então cada língua os
 * posiciona do seu jeito.
 */

import type { ChannelServedBy } from "../../channels/away-channels.ts";
import type { InterfaceText } from "../interface-text.ts";

/** Quem atende um canal agora, pelo identificador que o registro do canal guarda. */
const CHANNEL_HOLDER: Readonly<Record<ChannelServedBy, string>> = {
	"this session": "esta sessão",
	"the daemon": "o daemon",
	"another session": "outra sessão",
	nobody: "ninguém",
};

export const BOT_TEAM = {
	remoteUnavailable: "Máquinas remotas não estão disponíveis nesta sessão.",
	/** Uma linha de uso: o comando e os argumentos vêm de quem chama, a palavra antes deles vem daqui. */
	usage: (line: string) => `Uso: ${line}`,
	/** Um rename cujo nome ficou longo ou curto demais. */
	usageLength: (line: string) => `Uso: ${line} (um nome de 1 a 60 caracteres).`,
	botUsage:
		"Uso: /bot [list] | /bot new <id> [--write] [model] [soul...] | /bot soul <id> | /bot rename <id> <name...> | /bot lead|unlead <id> (um líder permanente; os objetivos dele ficam em /lead) | /bot spawner | /bot open <id> | /bot msg|send|steer|queue <id> <text...> | /bot inbox [id] | /bot ack [id|all] | /bot schedule [list|add|rm|run] ... | /bot daemon [status|start|stop|tick|service] | /bot stop <id> | /bot retire <id>",
	teamUsage:
		"Uso: /team [list] | /team create <teamId> <bot1,bot2,...> [description...] | /team members <teamId> <bot1,bot2,...> | /team open <teamId> | /team msg <teamId> <text...> | /team inbox [teamId] | /team ack [teamId|all] | /team schedule [list|add|rm] ... | /team delete <teamId>",
	botMessageUsage: "Uso: /bot msg|send|steer|queue <id> <text...>",
	teamMessageUsage: "Uso: /team msg <teamId> <text...>",
	renameUsage: "/bot rename <id> <name...>",
	scheduleUsage: (kind: "bot" | "team", idKind: "bot" | "team") =>
		`Uso: /${kind} schedule add <routineId> <${idKind}Id> <interval> <prompt...>`,
	daemonUsage: "Uso: /bot daemon [status | start | stop | tick | service [status | install | uninstall]]",
	daemonServiceUsage: "Uso: /bot daemon service [status | install | uninstall]",

	/** Um bot ou uma equipe que uma confirmação citou e o armazenamento não tem. */
	notFound: (kind: "bot" | "team", id: string) =>
		kind === "bot" ? `Bot não encontrado: ${id}.` : `Equipe não encontrada: ${id}.`,

	botCreated: (agentId: string, provider: string, modelId: string) =>
		`Bot ${agentId} criado em ${provider}/${modelId}; a conversa ativa agora é a dele.`,
	botNotFound: (agentId: string) => `Nenhum bot chamado ${agentId}. Crie com /bot new ${agentId} <model>.`,
	botNotFoundSoul: (agentId: string) =>
		`Nenhum bot chamado ${agentId}. Crie com /bot new ${agentId} <model> [soul...].`,
	botExists: (agentId: string) => `${agentId} já existe.`,
	spawnerReady: (agentId: string) =>
		`${agentId} está pronto. O orquestrador pode entregar a ele a criação de muitos bots de uma vez; ele cria cada um e passa o brief.`,
	leaderOn: (agentId: string) =>
		`${agentId} agora é líder permanente: pode criar bots, e os outros bots pedem um bot a ele ou ao orquestrador. Vale a partir do próximo início de worker do bot. Os objetivos que o orquestrador entrega a ele aparecem e são alterados em /lead, não aqui.`,
	leaderOff: (agentId: string) =>
		`${agentId} não é mais líder permanente. Vale a partir do próximo início de worker do bot. Um objetivo que ele já lidera continua: /lead mostra o objetivo e /lead cancel ${agentId} o interrompe.`,
	botRenamed: (agentId: string, name: string) =>
		`${agentId} agora aparece como ${name}. O endereço continua @${agentId}.`,
	botRetired: (agentId: string) => `Bot ${agentId} retirado.`,
	botMissing: (agentId: string) => `O bot ${agentId} não existe.`,
	notABotWorker: (agentId: string) =>
		`${agentId} é um worker de delegação, não um bot, então não pode ser retirado aqui; cancele-o com a ferramenta delegate (cancel ${agentId}).`,
	botLeadsOpenGoal: (agentId: string) =>
		`O bot ${agentId} lidera um objetivo aberto; cancele antes (/lead cancel ${agentId}).`,
	botHasActiveWork: (agentId: string) =>
		`O bot ${agentId} ainda está em atendimento direto ou em equipe; pare antes com /bot stop ${agentId}.`,
	botModelUnavailable: (agentId: string, modelRef: string) =>
		`O bot ${agentId} roda em ${modelRef}, que não está disponível ou não tem credenciais. Entre nesse provedor ou troque o modelo do bot e envie a mensagem de novo.`,
	botProfileRefused: (agentId: string, profileId: string, reason: string) =>
		`O bot ${agentId} não foi iniciado: o perfil ${profileId} não o admite agora (${reason}). Corrija o perfil ou a política de workers e envie a mensagem de novo.`,
	botModelMoved: (agentId: string, running: string, defined: string) =>
		`Bot ${agentId}: a sessão dele está em ${running}, não em ${defined}, o modelo em que o bot é definido, então esta execução não foi iniciada.`,
	botModelUnusable: (modelRef: string, cause: string) =>
		`${modelRef} não pode rodar agora (${cause}); o bot roda só no próprio modelo, então envie a mensagem de novo quando esse modelo puder ser usado ou troque o modelo do bot`,
	botSessionOutdated: (agentId: string) =>
		`Bot ${agentId}: o que define a sessão dele mudou desde que ela foi criada (o registro, o perfil, um modelo fixado ou a política de workers), então esta execução não foi iniciada na sessão antiga. A sessão é refeita quando ficar ociosa; envie a mensagem de novo.`,
	botRunsAsWorker: (agentId: string) =>
		`O bot ${agentId} roda como worker (um líder, um bot que um líder criou ou um perfil que só a execução de um worker comporta), não numa sessão própria.`,
	botSettingsNotReread: (reason: string) =>
		`Uma mudança nas configurações não chegou às sessões dos bots (${reason}); elas mantêm as configurações que tinham até a próxima mudança.`,
	botTurnAbortReasons: {
		sessionClosing: "sessão do bot fechando",
		ownerStopped: "bot parado pelo dono",
		systemOneStopped: "o System One parou o turno",
		systemOneRedirected: "o System One redirecionou o turno",
	},
	botSoulRefused: (agentId: string, reason: string) =>
		`O bot ${agentId} não foi iniciado: ${reason}. Edite o soul com /bot soul ${agentId}.`,
	botSessionHeld: (agentId: string, pid: number, sessionId?: string) =>
		`O bot ${agentId} está aberto em outra sessão (${sessionId ? `${sessionId.slice(0, 8)}, ` : ""}processo ${pid}).`,
	botInboxFull: (agentId: string, max: number) =>
		`Bot ${agentId}: ${max} mensagens já esperam pela sessão que o hospeda; envie de novo quando ela as tiver recebido.`,
	botInboxUnreadable: (agentId: string, file: string, reason: string) =>
		`Bot ${agentId}: uma mensagem da caixa de entrada não pôde ser lida e foi separada como ${file}.unreadable (${reason}).`,
	botInboxRefused: (agentId: string, reason: string) =>
		`Bot ${agentId}: uma mensagem enviada de outra sessão não foi recebida (${reason}).`,
	botInboxNotTaken: (agentId: string, reason: string) =>
		`Bot ${agentId}: as mensagens enviadas de outras sessões não puderam ser recebidas (${reason}).`,
	botInboxReleased: (agentId: string) =>
		`o bot ${agentId} não roda mais como sessão própria (aposentado, ou suas mensagens agora vão para um worker); envie de novo`,
	botInboxWaitingLine: (text: string) => `Esperando a sessão que hospeda o bot: ${text}`,
	botInboxRefusedLine: (reason: string, text: string) => `Não entregue (${reason}): ${text}`,
	botRunsElsewhere: (agentId: string, pid: number, sessionId?: string) =>
		`O bot ${agentId} está trabalhando em outra sessão (${sessionId ? `${sessionId.slice(0, 8)}, ` : ""}processo ${pid}). Pare por lá.`,
	botHomesNotWatched: (reason: string) =>
		`Os bots de outras sessões não são mais observados (${reason}); as mudanças deles aparecem quando esta sessão os lê.`,
	botHomesRemoved: (dir: string) => `${dir} foi removido`,
	botMessageRefused: (agentId: string, reason: string) => `O bot ${agentId} não recebeu a mensagem: ${reason}.`,
	botMessageNotTaken: (agentId: string) => `O bot ${agentId} não recebeu a mensagem.`,
	botWarning: (agentId: string, message: string) => `Bot ${agentId}: ${message}`,
	botHistoryRunNotRecorded: (agentId: string, reason: string) =>
		`Bot ${agentId}: a execução não pôde entrar no histórico dele (${reason}).`,
	botStateNotPublished: (agentId: string, reason: string) =>
		`Bot ${agentId}: o estado dele não pôde ser publicado para as outras sessões (${reason}).`,
	botTurnSpendNotRecorded: (agentId: string, reason: string) =>
		`Bot ${agentId}: o gasto do turno não pôde ser registrado (${reason}).`,
	botTurnOutcomeNotRecorded: (agentId: string, reason: string) =>
		`Bot ${agentId}: o resultado do turno não pôde ser registrado (${reason}).`,
	botHistoryFileUnreadable: (reason: string) =>
		`Histórico dos bots: um arquivo de sessão não pôde ser lido (${reason}).`,
	botHistoryIndexUnreadable: (agentId: string) =>
		`Bot ${agentId}: o índice do histórico não pode ser lido, então os pacotes de sessão antigos não são limpos até ele ser gravado de novo.`,
	botHistoryNotIndexed: (reason: string) => `O histórico dos bots não pôde ser indexado (${reason}).`,
	botHistoryRunUnreadable: (reason: string) =>
		`Histórico dos bots: uma conversa anterior não pôde ser lida (${reason}).`,
	botModelNotAllowed: (modelRef: string) => `sua política de modelos não permite ${modelRef}`,
	botModelMetered: (modelRef: string, alternatives: readonly string[], provider: string) =>
		`${modelRef} é cobrado por chave de API e você não o escolheu para workers enquanto há modelos de assinatura disponíveis; use um modelo de assinatura como ${alternatives.join(", ")}, ou adicione ${provider} a workerDelegation.routeProviders`,
	botSessionsClosing: (agentId: string) =>
		`O bot ${agentId} não foi iniciado: esta sessão está fechando, e os bots dela fecham junto. Envie a mensagem de novo na próxima sessão.`,
	botSessionStillClosing: (agentId: string) =>
		`O bot ${agentId} não foi iniciado: uma sessão anterior dele, ou as sessões de bots de uma sessão que fechou neste processo, não terminaram de fechar. Envie a mensagem de novo daqui a pouco; se isso se repetir, reinicie o pi.`,
	botTurnFailed: (agentId: string, reason: string) => `Bot ${agentId}: o turno falhou (${reason}).`,
	botModelRefused: (agentId: string, reason: string) =>
		`O bot ${agentId} não recebeu a mensagem: o modelo dele foi recusado (${reason}).`,
	botTurnOverBudget: (agentId: string, spentUsd: string, limitUsd: string, bound: "worker" | "session" | "profile") =>
		`Bot ${agentId}: o turno foi interrompido no limite de gasto ($${spentUsd} gastos; ${bound === "worker" ? "workerDelegation.maxUsd" : bound === "profile" ? "o orçamento de custo do perfil dele" : "o limite de gasto da autonomia desta sessão"} é $${limitUsd}).`,
	botSessionCloseFailed: (agentId: string, reason: string) =>
		`Bot ${agentId}: a sessão não fechou corretamente (${reason}).`,
	botSessionNotClosed: "A sessão do bot não fechou corretamente.",
	botSessionsNotClosed: "As sessões dos bots não fecharam corretamente.",
	botWatchesNotResumed: (agentId: string, reason: string) =>
		`Bot ${agentId}: a sessão dele tem esperas ativas mas não pôde ser aberta, então elas não são verificadas até que seja (${reason}).`,
	botWatchesCancelled: (agentId: string, count: number) =>
		`Bot ${agentId}: ${count} ${count === 1 ? "espera armada numa conversa anterior dele foi cancelada" : "esperas armadas numa conversa anterior dele foram canceladas"}; ele continua a conversa mais recente, e uma espera só é verificada pela conversa que a armou.`,
	botChangeWhileRunning: (agentId: string) =>
		`O bot ${agentId} está trabalhando: modelo, permissões e soul valem para a sessão no início dela, então pare antes (/bot stop ${agentId}).`,
	botStopped: (agentId: string, bots: readonly string[], mode: string) =>
		`${agentId} parado${bots.length === 0 ? "" : `, junto com ${bots.length === 1 ? "o bot" : "os bots"} ${bots.join(", ")}`} (${mode}).`,
	botStoppedOwn: (agentId: string, bots: readonly string[]) =>
		`${bots.length === 1 ? `Bot ${bots.join(", ")} de ${agentId} parado` : `Bots ${bots.join(", ")} de ${agentId} parados`}; ${agentId} não estava em execução.`,
	botIdle: (agentId: string) => `${agentId} não está em execução.`,
	/** Como uma interrupção parou um bot: o código guarda a identidade, o dono lê a palavra. */
	stopMode: (mode: "halt" | "suspend"): string => (mode === "halt" ? "parada imediata" : "suspensão"),

	soulEditorTitle: (agentId: string) => `Editar o soul do bot ${agentId}`,
	soulCancelled: "Edição do soul cancelada.",
	soulUnchanged: (agentId: string) => `Soul de ${agentId} sem alteração.`,
	soulSaved: (agentId: string, characters: number) =>
		`Soul de ${agentId} salvo (${characters} caracteres). Ele abre o prompt de sistema do bot no próximo início de worker.`,
	soulCleared: (agentId: string) => `Soul de ${agentId} apagado.`,

	teamCreated: (teamId: string, members: string) =>
		`Equipe ${teamId} criada [${members}]; a conversa ativa agora é a dela.`,
	teamDeleted: (teamId: string) => `Equipe ${teamId} excluída.`,
	teamNotFound: (teamId: string) => `Equipe não encontrada: ${teamId}.`,
	teamNotFoundCreate: (teamId: string) =>
		`Nenhuma equipe chamada ${teamId}. Crie com /team create ${teamId} <bot1,bot2>.`,
	teamNotFoundSchedule: (teamId: string) => `Equipe não encontrada: ${teamId}. Crie antes com /team create.`,
	teamMembers: (teamId: string, members: string | undefined) => `Membros da equipe ${teamId}: ${members ?? "nenhum"}.`,
	noTeams: "Nenhuma equipe. Crie com /team create <teamId> <bot1,bot2,...>.",

	noBots: "Nenhum bot. Crie com /bot new <id> [--write] [model] [soul...].",
	botStoreUnavailable: "O armazenamento de bots não está disponível nesta sessão.",
	teamStoreUnavailable: "O armazenamento de equipes não está disponível nesta sessão.",
	storeUnavailable: "O armazenamento não está disponível nesta sessão.",
	/** Depois de uma linha de bot: as mensagens que ele não leu e os papéis que ele tem. */
	unread: (count: number) => ` · ${count} ${count === 1 ? "não lida" : "não lidas"}`,
	leaderMark: " · líder",
	remoteMark: (mark: string) => ` · ${mark} remoto`,

	inboxEmptyBot: (agentId: string) => `A caixa de entrada do bot ${agentId} está vazia.`,
	inboxEmptyTeam: (teamId: string) => `A caixa de entrada da equipe ${teamId} está vazia.`,
	inboxBot: (agentId: string, lines: string) => `Caixa de entrada do bot ${agentId}:\n${lines}`,
	inboxTeam: (teamId: string, lines: string) => `Caixa de entrada da equipe ${teamId}:\n${lines}`,
	inboxOverview: (rows: string) => `Caixas de entrada de bots e equipes:\n${rows}`,
	inboxesCaughtUp: "Todas as caixas de entrada de bots e equipes estão em dia.",
	inboxBotRow: (agentId: string, unread: number, summary: string) =>
		`bot:${agentId} (${unread} ${unread === 1 ? "não lida" : "não lidas"}): ${summary}`,
	inboxTeamRow: (teamId: string, unread: number) =>
		`equipe:${teamId} (${unread} ${unread === 1 ? "não lida" : "não lidas"})`,
	noSummary: "sem resumo",
	inboxAcknowledged: (kind: "bot" | "team", id: string) =>
		`Caixa de entrada ${kind === "bot" ? "do bot" : "da equipe"} ${id} marcada como lida.`,
	inboxAcknowledgedAll: (count: number) =>
		`${count} ${count === 1 ? "caixa de entrada marcada como lida" : "caixas de entrada marcadas como lidas"}.`,

	routinesEmpty: "Nenhuma rotina agendada. Adicione com /bot schedule add <routineId> <botId> <interval> <prompt...>.",
	targetBot: (agentId: string) => `bot:${agentId}`,
	targetTeam: (teamId: string) => `equipe:${teamId}`,
	mainSession: "sessão principal",
	nextOnEvent: "por evento",
	nextComplete: "concluída",
	nextRun: (when: string) => `próxima=${when}`,
	lastRun: (status: string) => ` · última=${status}`,
	stood: (progress: string) => ` · onde parou: ${progress}`,
	routineDeleted: (routineId: string) => `Rotina agendada ${routineId} excluída.`,
	routineNotFound: (routineId: string) => `Rotina não encontrada: ${routineId}.`,
	routinesDispatched: (dispatched: string, failures: string) => `Rotinas disparadas: ${dispatched}${failures}.`,
	routinesDispatchedFailures: (failed: string) => ` · falharam: ${failed}`,
	none: "nenhuma",
	routineTickUnavailable: "O tick do agendador de rotinas não está disponível.",
	routineScheduledBot: (routineId: string, agentId: string, schedule: string) =>
		`Rotina ${routineId} agendada para o bot ${agentId} ${schedule}.`,
	routineScheduledTeam: (routineId: string, teamId: string, schedule: string) =>
		`Rotina ${routineId} agendada para a equipe ${teamId} ${schedule}.`,

	daemonStatusUnavailable: "O status do daemon não está disponível.",
	/** As duas contagens que a linha de status do daemon carrega, e as notas que vêm depois dela. */
	daemonCounts: (active: number, due: number) =>
		`${active} ${active === 1 ? "rotina ativa" : "rotinas ativas"}, ${due} ${due === 1 ? "vencida" : "vencidas"}`,
	daemonRunning: (pid: number | undefined, build: string, counts: string) =>
		`Daemon de ausência em execução (${pid === undefined ? "" : `pid ${pid}, `}${build}, ${counts}).`,
	daemonStopped: (counts: string) => `Daemon de ausência parado (${counts}).`,
	daemonLegacy: (pid: number | undefined) =>
		` O daemon de um build anterior${pid === undefined ? "" : ` (pid ${pid})`} ainda está em execução; ele não pode mais gravar no armazenamento.`,
	daemonEnd: (reason: "released" | "signal" | "failed", detail: string | undefined) =>
		` Da última vez, terminou ${
			reason === "released"
				? "quando uma sessão o parou"
				: reason === "signal"
					? "quando o processo dele foi interrompido"
					: `com erro${detail ? `: ${detail}` : ""}`
		}.`,
	daemonRefused: (routineId: string, reason: string) => `A rotina ${routineId} não rodou na ausência: ${reason}`,
	channelServed: (name: string, cwd: string, servedBy: ChannelServedBy, drafts: number) =>
		`O canal ${name} é atendido pelo daemon em ${cwd} enquanto nenhuma sessão está aberta (agora: ${CHANNEL_HOLDER[servedBy]}); ${drafts} ${drafts === 1 ? "rascunho de resposta gravado espera" : "rascunhos de resposta gravados esperam"} a próxima sessão (channel_reply).`,
	awayServiceUnavailable: "O serviço sempre ativo não está disponível nesta sessão.",
	daemonStartUnavailable: "Iniciar o daemon de ausência não está disponível.",
	daemonStopUnavailable: "Parar o daemon de ausência não está disponível.",
	/** O que um lançamento do daemon de ausência fez: um relatório, um diagnóstico e a tela tiram as palavras daqui. */
	daemonLaunchUnavailable:
		"O daemon de ausência não está disponível: este host não tem uma forma estável de iniciar o pi.",
	daemonLaunchStarting: (pid: number | undefined, build: string) =>
		`O daemon de ausência já está iniciando (${pid === undefined ? "" : `pid ${pid}, `}${build}).`,
	daemonLaunchRunning: (pid: number | undefined, build: string, activeRoutines: number) =>
		`O daemon de ausência já está em execução (pid ${pid ?? "desconhecido"}, ${build}, ${activeRoutines} ${activeRoutines === 1 ? "rotina ativa" : "rotinas ativas"}).`,
	daemonLaunchSpawnFailed: "Não foi possível iniciar o processo do daemon de ausência.",
	daemonLaunchStarted: (pid: number, storeFilePath: string) =>
		`Daemon de ausência iniciado (pid ${pid}); ele observa ${storeFilePath} mesmo quando a TUI reinicia.`,
	/** O daemon de quem um build mais novo tomou o lease. */
	daemonReplacement: (build: string | undefined, pid: number | undefined, own: string | undefined) =>
		`O daemon ${build === undefined ? "de um build anterior" : `do build ${build}`}${pid === undefined ? "" : ` (pid ${pid})`} foi substituído pelo build ${own ?? "desconhecido"}; ele encerra ao observar o novo lease.`,
	/** O que uma parada do daemon de ausência fez. */
	daemonStopReleased: (pid: number | undefined) =>
		`Lease do daemon de ausência liberado${pid === undefined ? "" : ` (pid ${pid})`}; ele encerra assim que observar a liberação.`,
	daemonStopNotRunning: (staleReleased: boolean) =>
		`O daemon de ausência não está em execução${staleReleased ? "; o lease antigo foi liberado" : ""}.`,
	/** O daemon de um build anterior: o que este lançamento retirou, ou não conseguiu retirar. */
	daemonLegacyLeaseReleased: (pid: number | undefined) =>
		`O lease do daemon de um build anterior${pid === undefined ? "" : ` (pid ${pid})`} foi liberado; ele encerra ao observar a liberação.`,
	daemonLegacyDaemonStopped: (pids: string) =>
		`O daemon de script inline de um build anterior (pid ${pids}) foi encerrado.`,
	daemonLegacyDaemonUnsignalled: (pids: string) =>
		`Não foi possível enviar um sinal ao daemon de script inline de um build anterior (pid ${pids}); ele não pode mais gravar no armazenamento.`,
	daemonLegacyDaemonSealedOut: (pid: number, provable: boolean) =>
		`O daemon de script inline de um build anterior (pid ${pid}) ainda está em execução; a identidade dele não foi confirmada${provable ? "" : " (este host não tem como verificar a identidade de um processo)"}, então nenhum sinal foi enviado. Ele não pode mais gravar no armazenamento e fica ocioso até ser encerrado, o usuário sair ou o host reiniciar.`,
	tickDispatched: (dispatched: string) => `Tick do daemon e das rotinas disparou: ${dispatched}.`,
	tickUnavailable: "O tick das rotinas não está disponível.",
	/** O que um lançamento fez, nas palavras do dono: o lançamento informa os fatos, nunca a frase. */
	serviceLeaseHeld: (pid: number | undefined, renewed: string | undefined) =>
		`Lease de rotinas: retido${pid === undefined ? "" : ` pelo pid ${pid}`}${renewed === undefined ? ", começando" : `, renovado há ${renewed}`}.`,
	serviceLeaseFree: "Lease de rotinas: nenhum daemon o retém.",
	serviceSystemd: (unitFileState: string, activeState: string, subState: string) =>
		`systemd: ${unitFileState}, ${activeState} (${subState}).`,
	serviceSystemdFailed: (result: string, exitStatus: string, unit: string) =>
		`o serviço falhou (${result}, código de saída ${exitStatus}); \`journalctl --user -u ${unit}\` mostra a saída.`,
	serviceSystemdInactive:
		"o daemon do serviço terminou normalmente: outro daemon reteve o lease, uma sessão de um build mais novo o substituiu, ou `/bot daemon stop` o liberou. Ele começa de novo no próximo login ou no próximo início do serviço.",
	serviceSystemdSilent: (answer: string) => `o systemd não respondeu: ${answer}.`,
	serviceLaunchd: (state: string, lastExit: string | undefined) =>
		`launchd: carregado, ${state}${lastExit === undefined ? "" : `, última saída ${lastExit}`}.`,
	serviceLaunchdUnloaded: "launchd: o agente não está carregado; ele carrega no próximo login.",
	serviceLaunchdIdle:
		"o daemon do agente não está em execução: outro daemon reteve o lease, uma sessão de um build mais novo o substituiu, `/bot daemon stop` o liberou, ou ele falhou (o código da última saída diz qual).",
	serviceTaskRegistered: "Agendador de tarefas: a tarefa está registrada; ela inicia o daemon no logon e termina.",
	serviceTaskMissing: (answer: string) => `Agendador de tarefas: a tarefa não está registrada (${answer}).`,
	serviceTaskIdle: "a tarefa inicia o daemon só no logon; um início de sessão ou `/bot daemon start` o inicia agora.",
	serviceWhyNoDaemon: (why: string) => `Por que nenhum daemon roda: ${why}`,
	serviceShellCredentials: (names: string) =>
		`Um daemon iniciado pelo serviço não recebe estas variáveis deste shell: ${names}. Mantenha essas credenciais em auth.json para as rotinas de ausência depois de reiniciar a máquina.`,
	serviceGhSignIn:
		"gh: um daemon iniciado pelo serviço usa o login que o próprio gh guarda; sem ele, rotinas por evento que precisam do GitHub esperam pela sessão.",
	serviceRefused: (reason: string) => `As rotinas de ausência não podem iniciar no login: ${reason}`,
	serviceClosing: "As rotinas de ausência não podem iniciar no login: esta sessão está fechando.",
	serviceNoServiceHere: (reason: string) => `Nenhum serviço sempre ativo se aplica aqui: ${reason}`,
	serviceRestartFailed: (reason: string) => `O serviço sempre ativo não foi reiniciado: ${reason}`,
	serviceRestartNoLease: (build: string | undefined, seconds: number) =>
		`O serviço sempre ativo reiniciou, mas nenhum daemon do build ${build ?? "desconhecido"} ou mais novo reteve o lease de rotinas em ${seconds} s.`,
	serviceRestarted: (build: string | undefined) =>
		`O serviço sempre ativo reiniciou; o daemon dele retém o lease de rotinas (build ${build ?? "sem identificação"}).`,
	serviceNoLease: (path: string, seconds: number) =>
		`As rotinas de ausência não podem iniciar no login: o serviço está instalado em ${path}, mas nenhum daemon reteve o lease de rotinas em ${seconds} s; \`/bot daemon service status\` mostra o motivo.`,
	serviceInstalled: (path: string, pid: number | undefined) =>
		`Rotinas sempre ativas instaladas em ${path}; o daemon retém o lease de rotinas${pid === undefined ? "" : ` (pid ${pid})`}.`,
	serviceRemoveFailed: (reason: string) => `O serviço sempre ativo não foi removido: ${reason}`,
	serviceRemoved: (path: string, running: string, problems: string) =>
		`Rotinas sempre ativas removidas (${path}). ${running}${problems === "" ? "" : ` Relatado: ${problems}`}`,
	serviceRemovedRunningTask: "Um daemon iniciado pela tarefa continua até `/bot daemon stop`.",
	serviceRemovedRunningService:
		"Um daemon iniciado pelo serviço termina junto; um iniciado por uma sessão continua até `/bot daemon stop`.",
} satisfies InterfaceText["botTeam"];
