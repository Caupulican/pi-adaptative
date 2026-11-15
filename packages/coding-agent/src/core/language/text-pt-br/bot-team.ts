/**
 * As palavras de `/bot` e `/team`: as linhas de uso, o que cada comando fez, o editor de soul, as listas, a caixa de
 * entrada e as confirmações, as rotinas agendadas e `/bot daemon` com o serviço sempre ativo. O comando e os argumentos
 * nunca mudam; a prosa em volta muda. Os fatos que um comando lê do núcleo são argumentos aqui, então cada língua os
 * posiciona do seu jeito.
 */

import type { BotPointerSetAsideReason } from "../../bots/bot-session-pointer.ts";
import type { ChannelServedBy } from "../../channels/away-channels.ts";
import type { InterfaceText } from "../interface-text.ts";
import type { HolderPlace } from "../text-en/sessions.ts";

/** Por que o ponteiro de sessão de um bot não contou, como a frase que diz que ele foi separado o diz. */
const POINTER_SET_ASIDE: {
	readonly [K in BotPointerSetAsideReason["kind"]]: (reason: Extract<BotPointerSetAsideReason, { kind: K }>) => string;
} = {
	"not-a-pointer": () => "não é um registro de sessão",
	"not-a-session": (reason) => `aponta ${reason.file}, que não guarda uma sessão`,
	"other-session": (reason) => `aponta ${reason.file}, que guarda a sessão ${reason.holds}, não ${reason.sessionId}`,
	deleted: (reason) => `aponta a sessão ${reason.sessionId}, que foi apagada`,
};

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
		"Uso: /bot [list] | /bot new <id> [--write] [model] [soul...] | /bot soul <id> | /bot rename <id> <name...> | /bot lead|unlead <id> (um líder permanente; os objetivos dele ficam em /lead) | /bot open <id> | /bot msg|send|steer|queue <id> <text...> | /bot inbox [id] | /bot ack [id|all] | /bot schedule [list|add|rm|run] ... | /bot daemon [status|start|stop|tick|service] | /bot stop <id> | /bot retire <id>",
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
	leaderOn: (agentId: string) =>
		`${agentId} agora é líder permanente: recebe bots próprios do orquestrador, e os outros bots pedem um bot a ele ou ao orquestrador. Vale a partir do próximo início de worker do bot. Os objetivos que o orquestrador entrega a ele aparecem e são alterados em /lead, não aqui.`,
	leaderOff: (agentId: string) =>
		`${agentId} não é mais líder permanente. Vale a partir do próximo início de worker do bot. Um objetivo que ele já lidera continua: /lead mostra o objetivo e /lead cancel ${agentId} o interrompe.`,
	botRenamed: (agentId: string, name: string) =>
		`${agentId} agora aparece como ${name}. O endereço continua @${agentId}.`,
	botRetired: (agentId: string) => `Bot ${agentId} retirado.`,
	botMissing: (agentId: string) => `O bot ${agentId} não existe.`,
	notABotWorker: (agentId: string) =>
		`${agentId} é um worker de delegação, não um bot, então não pode ser retirado aqui; cancele-o com a ferramenta delegate (cancel ${agentId}).`,
	botLeadsOpenGoal: (agentId: string) =>
		`O bot ${agentId} lidera um objetivo aberto; pode ser retirado quando esse objetivo terminar (o dono o encerra antes com /lead cancel ${agentId}).`,
	botHasActiveWork: (agentId: string) =>
		`O bot ${agentId} ainda está em atendimento direto ou em equipe; pode ser retirado quando esse trabalho terminar (o dono o encerra antes com /bot stop ${agentId}).`,
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
	botSessionOpenElsewhere: (agentId: string, holders: string) =>
		`a conversa do bot ${agentId} está aberta em ${holders}; o hospedeiro dele a abre quando isso a fechar`,
	botSessionHolderSession: (pid: number) => `uma sessão sua (processo ${pid})`,
	botSessionHolderPhone: (pid: number) => `o daemon da sessão do telefone (processo ${pid})`,
	botSessionHolderBotHost: (pid: number) => `outro hospedeiro de bot (processo ${pid})`,
	botSessionHolderElsewhere: (holder: string, place: HolderPlace) =>
		`${holder} ${place.at}, liberada quando esse processo a fechar ou, se ele terminou sem liberá-la, quando o pi ${place.there} a abrir`,
	botSessionFileLinked: (path: string) =>
		`o arquivo de sessão de bot ${path} é um link simbólico, que as sessões de bot não seguem (uma escrita trocaria o link por uma cópia); troque o link pelo próprio arquivo`,
	botSessionHomeChanged: (agentId: string) =>
		`a sessão do bot ${agentId} foi movida para a casa dele enquanto era aberta; ela abre lá na próxima mensagem ou mudança`,
	botSessionLeasesUnreadable: (agentId: string, file: string) =>
		`o registro de leases da sessão do bot ${agentId} (${file}) não pôde ser lido como tal e precisa de inspeção antes de a sessão abrir`,
	botSessionStateSplit: (agentId: string, inBot: string, inOwner: string) =>
		`o estado da sessão do bot ${agentId} foi movido só em parte (na casa dele: ${inBot}; na casa da sessão principal: ${inOwner || "nada"}); reúna as partes em uma casa antes de ela abrir de novo`,
	botFilesLocked: (agentId: string) =>
		`os arquivos do bot ${agentId} ficaram travados por outro processo por mais tempo que a espera`,
	botWatchChangedMeanwhile: (agentId: string) =>
		`uma espera do bot ${agentId} foi mudada por outro processo nesse meio-tempo`,
	botFailureUnworded: (agentId: string) =>
		`o bot ${agentId} encontrou uma falha inesperada; os detalhes estão no log do harness`,
	botSessionStoreBusy: (agentId: string) =>
		`os arquivos da sessão do bot ${agentId} estavam ocupados ou mudando durante a leitura; o hospedeiro dele a abre de novo em instantes`,
	botSessionStoreFailing: (agentId: string) =>
		`os arquivos da sessão do bot ${agentId} falharam na leitura (um erro de disco); o hospedeiro dele tenta de novo por um minuto, depois quando uma mensagem ou uma mudança do bot pedir`,
	botSessionStorePermission: (agentId: string) =>
		`este processo não tem permissão para ler os arquivos da sessão do bot ${agentId}; o hospedeiro dele tenta de novo por um minuto, depois quando uma mensagem ou uma mudança do bot pedir`,
	botInboxFull: (agentId: string, max: number) =>
		`Bot ${agentId}: ${max} mensagens já esperam pela sessão que o hospeda; envie de novo quando ela as tiver recebido.`,
	homeRecordKinds: {
		inboxMessage: "uma mensagem da caixa de entrada",
		notice: "um aviso do chat dele",
	},
	botHomeRecordSetAside: (agentId: string, record: string, file: string, reason: string) =>
		`Bot ${agentId}: não foi possível ler ${record} (${reason}); o arquivo foi separado como ${file}.unreadable.`,
	botHomeRecordNotSetAside: (agentId: string, record: string, file: string, reason: string, maxMinutes: number) =>
		`Bot ${agentId}: não foi possível ler ${record} (${reason}) nem separar o arquivo ${file}; ele continua no lugar, não conta como esperando e é lido de novo, com no máximo ${maxMinutes} minutos de intervalo, até ser lido; este aviso é dado só uma vez.`,
	botStopNotRecorded: (agentId: string, reason: string) =>
		`Bot ${agentId}: a parada do dono não pôde ser registrada (${reason}); este processo a mantém e tenta registrá-la de novo até conseguir, aplicando-a ele mesmo enquanto nenhum processo hospeda o bot, e se este processo for encerrado antes você é avisado se ela foi registrada. Onde quer que seja aplicada, ela encerra só o trabalho que existia quando você parou o bot.`,
	botStopRecordedLate: (agentId: string) =>
		`Bot ${agentId}: a parada do dono que antes não pôde ser registrada agora está registrada; ela encerra só o trabalho que existia quando você parou o bot.`,
	botStopLostAtQuit: (agentId: string, reason: string) =>
		`Bot ${agentId}: a parada do dono que não pôde ser registrada se perdeu quando este processo foi encerrado (${reason}); envie-a de novo se ainda a quiser.`,
	botStopNotRecordedHere: (agentId: string, reason: string) =>
		`Bot ${agentId}: a parada do dono não pôde ser registrada (${reason}); ela não chega a nenhum outro processo e se aplica só ao trabalho do bot neste processo.`,
	botInboxStopUnreadable: (agentId: string, file: string, reason: string) =>
		`Bot ${agentId}: uma parada do dono na caixa de entrada não pôde ser lida (${reason}) e foi separada como ${file}.unreadable; ela não para nada, então envie a parada de novo se ainda a quiser.`,
	botInboxStopNotSetAside: (agentId: string, file: string, reason: string, maxMinutes: number) =>
		`Bot ${agentId}: uma parada do dono na caixa de entrada não pôde ser lida (${reason}) nem separada (${file}); ela não para nada, continua no lugar, não conta como esperando e é lida de novo com no máximo ${maxMinutes} minutos de intervalo; este aviso é dado só uma vez.`,
	botStopOlderLeft: (agentId: string, reason: string) =>
		`Bot ${agentId}: a parada do dono foi registrada, mas as paradas anteriores que ela substitui não puderam ser listadas ou removidas (${reason}); elas são tomadas junto com ela.`,
	botSweepFailed: (agentId: string, reason: string) =>
		`Bot ${agentId}: a caixa de entrada e o trabalho devido dele não puderam ser verificados (${reason}); eles são verificados de novo a cada minuto.`,
	botStopLinkedSessionLeft: (agentId: string, path: string) =>
		`Bot ${agentId}: a parada do dono foi aplicada, mas os workers, o objetivo e a espera pelo limite de uso da sessão salva dele foram deixados: ${path} é um link simbólico, e nenhum trabalho é encerrado por meio de um.`,
	botPlacedJobsNotEnded: (agentId: string, reason: string) =>
		`Bot ${agentId}: o trabalho próprio dele foi encerrado, mas os jobs que as sessões da casa dele colocaram em outras máquinas não puderam ser encerrados (${reason}).`,
	botLinkedSessionsJobsLeft: (agentId: string, paths: readonly string[]) =>
		`Bot ${agentId}: os jobs colocados em outras máquinas por ${paths.join(", ")} não foram encerrados: ${paths.length === 1 ? "é um link simbólico" : "são links simbólicos"}, e nenhum trabalho é encerrado por meio de um.`,
	botWordsWaitForOpen: (agentId: string, reason: string) =>
		`Deixado na caixa de entrada de ${agentId}: a sessão dele abre assim que puder (${reason}).`,
	botWordsWaitBehindStop: (agentId: string) =>
		`Deixado na caixa de entrada de ${agentId} atrás da parada dele, que ainda não pôde ser aplicada: suas palavras chegam ao bot quando a parada for aplicada.`,
	botStopWorkersNotEnded: (agentId: string, reason: string) =>
		`Bot ${agentId}: a parada do dono não pôde encerrar os workers dele (${reason}); eles continuam rodando até que uma parada dele seja aplicada.`,
	botStopGoalNotHeld: (agentId: string, reason: string) =>
		`Bot ${agentId}: a parada do dono, aplicada aqui sem o registro dela, não pôde reter o objetivo dele nem recusar a espera pelo limite de uso (${reason}); o objetivo pode seguir sozinho até você pausá-lo.`,
	botStopMessagesNotRefused: (agentId: string, reason: string) =>
		`Bot ${agentId}: a parada do dono, aplicada aqui sem o registro dela, não pôde recusar as mensagens enviadas a ele antes da parada (${reason}); elas ainda podem chegar a ele.`,
	botStopNotApplied: (agentId: string, reason: string) =>
		`Bot ${agentId}: a parada pedida pelo dono não pôde ser aplicada e continua aguardando; o trabalho que ela para fica retido até ser aplicada (${reason}).`,
	botStopDropped: (agentId: string, why: string) =>
		`Bot ${agentId}: a parada do dono que não pôde ser registrada foi descartada: ${why}; envie-a outra vez.`,
	botStopDropReasons: {
		workUnread: (reason: string) => `não foi possível ler onde está o trabalho do bot (${reason})`,
	},
	botStopHostUnread: (agentId: string, reason: string) =>
		`Bot ${agentId}: a parada do dono foi registrada e o processo que hospeda o bot a toma, ou este enquanto nenhum o hospeda; não foi possível ler qual processo o hospeda (${reason}).`,
	botStopSessionFileForeign: (agentId: string, file: string, sessionId: string) =>
		`Bot ${agentId}: a parada do dono encerrou os workers dele e os jobs que ele colocou em outras máquinas, mas deixou o objetivo e a espera pelo limite de uso como estavam: ${file} não contém a sessão ${sessionId}.`,
	botStopWatchesEnded: (agentId: string, watches: number, results: number) =>
		`Bot ${agentId}: a parada do dono encerrou ${[
			watches > 0
				? `${watches} ${watches === 1 ? "espera que ele tinha armado" : "esperas que ele tinha armado"}`
				: "",
			results > 0
				? `${results} ${results === 1 ? "resultado de espera que ele ainda não tinha lido" : "resultados de espera que ele ainda não tinha lido"}`
				: "",
		]
			.filter((part) => part !== "")
			.join(" e ")}; uma espera que ele armar depois da parada é mantida.`,
	botStopWatchesNotEnded: (agentId: string, reason: string) =>
		`Bot ${agentId}: a parada do dono não conseguiu encerrar as esperas que ele tinha armado (${reason}).`,
	botStopLeftLanes: (agentId: string, failed: number, managed: number) =>
		`Bot ${agentId}: a parada do dono não encerrou ${[
			failed > 0
				? `${failed} ${failed === 1 ? "lane de worker cujo cancelamento falhou" : "lanes de worker cujo cancelamento falhou"}`
				: "",
			managed > 0
				? `${managed} ${managed === 1 ? "lane gerenciada, que a extensão que a executa encerra" : "lanes gerenciadas, que a extensão que as executa encerra"}`
				: "",
		]
			.filter((part) => part !== "")
			.join(" e ")}.`,
	botInboxRefused: (agentId: string, reason: string) =>
		`Bot ${agentId}: uma mensagem enviada de outra sessão não foi recebida (${reason}).`,
	botInboxNotTaken: (agentId: string, reason: string) =>
		`Bot ${agentId}: as mensagens enviadas de outras sessões não puderam ser recebidas (${reason}).`,
	botInboxReleased: (agentId: string) =>
		`o bot ${agentId} não roda mais como sessão própria (aposentado, ou suas mensagens agora vão para um worker); envie de novo`,
	botMailReplyNotSent: (agentId: string, to: string, reason: string) =>
		`Bot ${agentId}: a resposta ao correio de ${to} não foi enviada (${reason}).`,
	botInboxWaitingLine: (text: string) => `Esperando a sessão que hospeda o bot: ${text}`,
	botInboxRefusedLine: (reason: string, text: string) => `Não entregue (${reason}): ${text}`,
	botStopSentElsewhere: (agentId: string, pid: number, sessionId?: string) =>
		`O bot ${agentId} está trabalhando em outra sessão (${sessionId ? `${sessionId.slice(0, 8)}, ` : ""}processo ${pid}); a parada foi enviada para lá e encerra o trabalho dele quando essa sessão a receber.`,
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
	botChargeFilesUnread: (
		agentId: string,
		named: readonly { readonly path: string; readonly reason: string }[],
		more: number,
	) =>
		`Bot ${agentId}: ${named.map(({ path, reason }) => `${path} (${reason})`).join("; ")}${more > 0 ? ` e mais ${more}` : ""} não ${named.length + more === 1 ? "pôde ser lido" : "puderam ser lidos"} para conferir as cobranças de gasto dele, então o que ${named.length + more === 1 ? "ele guarda" : "eles guardam"} pode ser cobrado de novo à sessão principal.`,
	botChargeMarkNotKept: (agentId: string, reason: string) =>
		`Bot ${agentId}: até onde a sessão principal guarda o gasto dele não pôde ser marcado na transcrição dele (${reason}); se o registro de gasto se perder, isso é relido só dos arquivos da sessão principal.`,
	botTurnOutcomeNotRecorded: (agentId: string, reason: string) =>
		`Bot ${agentId}: o resultado do turno não pôde ser registrado (${reason}).`,
	botNoticeNotRecorded: (agentId: string, text: string, reason: string) =>
		`Bot ${agentId}: um aviso não pôde ser guardado no chat dele (${reason}): ${text}`,
	botNoticeNotMarked: (agentId: string, reason: string) =>
		`Bot ${agentId}: há um aviso no chat dele, mas a lista não pôde marcá-lo como não lido (${reason}).`,
	botSpendLedgerHeld: (agentId: string, reason: string, setAsideError: string | undefined) =>
		`Bot ${agentId}: o registro de gasto dele ${setAsideError === undefined ? `não pôde ser lido (${reason})` : `não é legível (${reason}) e não pôde ser separado (${setAsideError})`}; ele fica como está e é tentado de novo no próximo gasto. Até lá, o gasto dos pedidos conta a partir de agora e o gasto é cobrado à sessão principal quando ele ${setAsideError === undefined ? "for lido" : "for separado"}.`,
	botSpendLedgerSetAside: (agentId: string, file: string, reason: string, chargesKept: boolean) =>
		`Bot ${agentId}: o registro de gasto dele não foi lido por inteiro (${reason}) e foi separado como ${file}; os pedidos cujo gasto não foi lido contam a partir de agora, e as cobranças à sessão principal continuam ${chargesKept ? "do registro dele" : "do que a sessão principal registrou delas"}.`,
	botSessionPointerSetAside: (agentId: string, file: string, reason: BotPointerSetAsideReason) =>
		`Bot ${agentId}: o registro de qual sessão ele continua ${POINTER_SET_ASIDE[reason.kind](reason as never)} e foi separado como ${file}; ele continua o arquivo de sessão mais recente, ou uma sessão nova quando não há nenhum, registrado de novo.`,
	botWatchesNotCounted: (agentId: string, reason: string) =>
		`Bot ${agentId}: a sessão salva dele não foi lida (${reason}); as esperas dele não são contadas até ela ser lida.`,
	botSessionStateInBothHomes: (agentId: string, ownerBundle: string) =>
		`Bot ${agentId}: o estado de orquestração da sessão dele está tanto na casa dele quanto na da sessão principal; ele usa o da casa dele, e a cópia da sessão principal fica sem uso em ${ownerBundle}.`,
	botSessionStateKeptForWorkers: (agentId: string) =>
		`Bot ${agentId}: o estado de orquestração da sessão dele fica na casa da sessão principal, cujas outras sessões compartilham as conversas dos workers dele; ele continua usando-o lá.`,
	botSessionStateKeptForOpenWorkers: (agentId: string) =>
		`Bot ${agentId}: o estado de orquestração da sessão dele fica na casa da sessão principal enquanto os workers dele lá seguem abertos (não aposentados, ou com mensagens ainda a entregar); ele continua usando-o lá, e um carregamento depois que eles se resolverem o move.`,
	botSessionStateMoveUndecided: (agentId: string, reason: string) =>
		`Bot ${agentId}: o estado de orquestração da sessão dele fica na casa da sessão principal por enquanto: os registros dos workers dele não puderam ser lidos para decidir a mudança (${reason}); ele continua usando-o lá, e o próximo carregamento decide de novo.`,
	botSessionStateStillHeld: (agentId: string, pids: string) =>
		`Bot ${agentId}: o estado de orquestração da sessão dele fica na casa da sessão principal, que o processo ${pids} ainda mantém sem impedir o bot (o hospedeiro de uma execução ausente); o bot roda a sessão dele lá.`,
	botSessionStateNotMoved: (agentId: string) =>
		`Bot ${agentId}: o estado de orquestração da sessão dele não pôde ser movido da casa da sessão principal para a dele, que fica em outro dispositivo; ele continua usando-o na casa da sessão principal.`,
	botSpendLedgerNotWritten: (agentId: string, reason: string) =>
		`Bot ${agentId}: o registro de gasto dele não pôde ser gravado (${reason}); ele é gravado de novo no próximo gasto, e o gasto é cobrado quando for.`,
	botNoticeDeliveriesNotKept: (agentId: string, reason: string) =>
		`Bot ${agentId}: o registro dos avisos que a sessão dele já deu não pôde ser lido ou gravado (${reason}); algum pode ser dado de novo.`,
	botHistoryFileUnreadable: (reason: string) =>
		`Histórico dos bots: um arquivo de sessão não pôde ser lido (${reason}).`,
	botHistoryIndexUnreadable: (agentId: string) =>
		`Bot ${agentId}: o índice do histórico não pode ser lido, então os pacotes de sessão antigos das suas sessões não são limpos até ele ser gravado de novo.`,
	botHistoryNotIndexed: (reason: string) => `O histórico dos bots não pôde ser indexado (${reason}).`,
	botHomeHostStateUnreadable: (botName: string) =>
		`Bot ${botName}: o estado do processo que o hospeda não pode ser lido, então os pacotes de sessão antigos dele não são limpos até poder.`,
	botHomeCurrentSessionUnknown: (botName: string) =>
		`Bot ${botName}: não dá para saber agora qual sessão ele mantém, então os pacotes de sessão antigos dele não são limpos até dar.`,
	botHomeHostSessionUnnamed: (botName: string) =>
		`Bot ${botName}: o processo que o hospeda ainda não informou a sessão que mantém, então os pacotes de sessão antigos dele não são limpos até informar.`,
	botHomeLinkUnresolved: (botName: string) =>
		`Bot ${botName}: o diretório dele é um link simbólico que não resolve, então nenhum pacote de sessão antigo das suas sessões é limpo até que resolva.`,
	botHomeRetentionFailed: (botName: string) =>
		`Bot ${botName}: os arquivos de sessão ou os pacotes de sessão antigos dele não puderam ser lidos, então os pacotes de sessão antigos dele não são limpos até poderem.`,
	botDeletionRecordsUnreadable: (botName: string, count: number) =>
		count === 1
			? `Bot ${botName}: 1 registro de exclusão dos pacotes de sessão antigos dele não pôde ser lido; o pacote dele fica até poder ser lido.`
			: `Bot ${botName}: ${count} registros de exclusão dos pacotes de sessão antigos dele não puderam ser lidos; os pacotes deles ficam até poderem ser lidos.`,
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
	botTurnOverBudget: (
		agentId: string,
		spentUsd: string,
		limitUsd: string,
		bound: "worker" | "session" | "profile",
		metered: boolean,
	) =>
		`Bot ${agentId}: o turno foi interrompido no limite de gasto ($${spentUsd} gastos${metered ? " com cobrança por uso" : ""} neste pedido, com os workers dele; ${bound === "worker" ? "workerDelegation.maxUsd" : bound === "profile" ? "o orçamento de custo do perfil dele" : "o limite de gasto da autonomia desta sessão"}${metered ? " sobre o gasto cobrado por uso" : ""} é $${limitUsd}).`,
	botTurnOverTime: (agentId: string, limitSeconds: string) =>
		`Bot ${agentId}: o turno foi interrompido no limite de tempo (workerDelegation.maxWallClockMs é ${limitSeconds} s).`,
	botRecordChangeNotApplied: (agentId: string, reason: string) =>
		`Bot ${agentId}: uma mudança da definição dele ainda não foi aplicada à sessão (${reason}); ela se aplica na próxima mudança ou mensagem.`,
	botSessionCloseFailed: (agentId: string, reason: string) =>
		`Bot ${agentId}: a sessão não fechou corretamente (${reason}).`,
	botSessionNotClosed: "A sessão do bot não fechou corretamente.",
	botSessionsNotClosed: "As sessões dos bots não fecharam corretamente.",
	botOwedReleasesUnread: (reason: string) =>
		`As liberações pendentes das sessões dos bots não puderam ser lidas (${reason}); elas são lidas de novo quando uma sessão abrir os bots outra vez.`,
	botReleaseOwed: (agentId: string, reason: string) =>
		`Bot ${agentId}: os workers, as esperas e as mensagens aguardando da sessão dele ainda não foram todos encerrados (${reason}); o hospedeiro dele tenta de novo até que sejam.`,
	botReleaseHeldBy: (pid: number) => `o processo ${pid} mantém a sessão dele`,
	botReleaseWorkersLeft: (agentId: string, path: string) =>
		`O bot ${agentId} foi liberado, mas os workers da sessão salva dele e os jobs que essa sessão colocou em outras máquinas foram deixados: ${path} é um link simbólico, e nenhum trabalho é encerrado por meio de um.`,
	botWatchesNotResumed: (agentId: string, reason: string) =>
		`Bot ${agentId}: a sessão dele tem trabalho pendente (esperas, mensagens aguardando, os workers dele ou um turno que um limite de uso parou) mas não pôde ser aberta, então o trabalho aguarda até que seja (${reason}).`,
	botOwedWorkNoRoot: (agentId: string, directories: string) =>
		`Bot ${agentId}: a sessão dele tem trabalho pendente (esperas, mensagens aguardando, os workers dele ou um turno que um limite de uso parou), mas nenhuma sessão aberta trabalha em ${directories}, onde ele trabalha; o trabalho aguarda até uma sessão abrir ali.`,
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
