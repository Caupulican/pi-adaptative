/**
 * As palavras de `/bot` e `/team`: as linhas de uso, o que cada comando fez, o editor de soul, as listas, a caixa de
 * entrada e as confirmações, as rotinas agendadas e `/bot daemon` com o serviço sempre ativo. O comando e os argumentos
 * nunca mudam; a prosa em volta muda. Os fatos que um comando lê do núcleo são argumentos aqui, então cada língua os
 * posiciona do seu jeito.
 */

import type { InterfaceText } from "../interface-text.ts";

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
	channelServed: (name: string, cwd: string, servedBy: string, drafts: number) =>
		`O canal ${name} é atendido pelo daemon em ${cwd} enquanto nenhuma sessão está aberta (agora: ${servedBy}); ${drafts} ${drafts === 1 ? "rascunho de resposta gravado espera" : "rascunhos de resposta gravados esperam"} a próxima sessão (channel_reply).`,
	awayServiceUnavailable: "O serviço sempre ativo não está disponível nesta sessão.",
	daemonStartUnavailable: "Iniciar o daemon de ausência não está disponível.",
	daemonStopUnavailable: "Parar o daemon de ausência não está disponível.",
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
