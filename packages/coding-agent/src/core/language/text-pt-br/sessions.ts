/**
 * As palavras em português do Brasil do fluxo de sessão e dos comandos de entrada e saída de sessão: os seletores de
 * modelo, de raciocínio e de árvore, o seletor de sessões, os comandos de objetivo e de etapas, o bloco de informações da
 * sessão e `/export`, `/import`, `/share`, `/copy` e `/name`. As folhas que levam um valor, uma contagem ou um plural são
 * funções. Um prompt cuja resposta o código compara mantém a resposta como identificador e tira o rótulo daqui.
 */

import type { InterfaceText } from "../interface-text.ts";
import type { HolderPlace } from "../text-en/sessions.ts";

/** A palavra do dono para cada estado do objetivo, indexada pelo identificador que o registro do objetivo guarda. */
const GOAL_STATUS_WORDS = {
	active: "ativo",
	paused: "pausado",
	blocked: "bloqueado",
	usage_limited: "parado no limite de uso",
	budget_limited: "parado no limite de orçamento",
	completed: "concluído",
	cancelled: "cancelado",
};

/** O verbo de cada ação de objetivo, para uma recusa que diz qual ação não havia objetivo para fazer. */
const GOAL_ACTION_WORDS: Record<string, string> = {
	pause: "pausar",
	resume: "retomar",
	edit: "editar",
	cancel: "cancelar",
	stop: "parar",
	complete: "concluir",
};

/** A palavra de um estado, quando o texto recebe o identificador do estado no lugar da palavra. */
function goalStatusWord(status: string): string {
	return (GOAL_STATUS_WORDS as Record<string, string>)[status] ?? status;
}

export const SESSIONS = {
	hosted: {
		phone: (pid: number) =>
			`Esta é a sessão do telefone; o daemon em segundo plano (pid ${pid}) a hospeda. Pare o daemon para abri-la aqui (\`/bot daemon stop\`).`,
		bot: (pid: number) =>
			`Esta sessão é a conversa do próprio bot; o host dele (pid ${pid}) a executa. Fale com o bot no chat dele (\`/bot open <id>\`), ou pare esse processo para abrir a sessão aqui.`,
		phoneElsewhere: (pid: number, place: HolderPlace) =>
			`Esta é a sessão do telefone; o daemon em segundo plano ${place.at} (pid ${pid}) a hospeda. Pare-o ${place.there} para abrir a sessão aqui; um daemon que terminou lá sem liberá-la é liberado quando o pi ${place.there} abrir a sessão.`,
		botElsewhere: (pid: number, place: HolderPlace) =>
			`Esta sessão é a conversa do próprio bot; o host dele ${place.at} (pid ${pid}) a executa. Fale com o bot no chat dele (\`/bot open <id>\`), ou pare esse processo ${place.there} para abrir a sessão aqui; um host que terminou lá sem liberá-la é liberado quando o pi ${place.there} abrir a sessão.`,
		onMachine: (machine: string): HolderPlace => ({ at: `em ${machine}`, there: "naquela máquina" }),
		otherMachine: "outra máquina",
		otherSystem: { at: "em outro sistema deste computador", there: "naquele sistema" } satisfies HolderPlace,
	},
	awayFleetQueueSetAside: (path: string) =>
		`Um arquivo de fila deixado por uma sessão anterior foi separado, não adotado: ${path}.`,
	awayMeteredRuns: {
		unreadable: (path: string, cause: string) =>
			`O registro das execuções e dos turnos de canal ausentes reservados no limite de gasto ausente não pôde ser lido (${cause}): ${path}. Cada execução ausente e cada turno de canal ausente numa assinatura é cobrado pelo routines.away.maxUsdPerRun inteiro até ele ser lido de novo; ele é lido de novo na próxima passada.`,
		notWritten: (path: string, cause: string) =>
			`Uma execução ausente que passou para um modelo cobrado por uso não pôde ser reservada no limite de gasto ausente (${cause}): ${path}. As requisições cobradas dela são recusadas.`,
		turnNotWritten: (channel: string, path: string, cause: string) =>
			`Canal ${channel} ausente: um turno não pôde ser reservado no limite de gasto ausente para passar a um modelo cobrado por uso (${cause}): ${path}. Ele não passa para esse modelo.`,
		chargesUnread: (charges: string, path: string, cause: string) =>
			`Não foi possível ler ${charges} (${cause}): ${path}. Até essas cobranças serem lidas, routines.away.maxUsdPerDay não tem espaço: nenhuma execução, turno de canal ou turno de bot ausente cobrado por uso começa. Elas são lidas de novo a cada verificação.`,
		chargeRecords: {
			channelTurns: "os turnos de canal cobrados no limite de gasto ausente",
			botSpend: "o que os bots gastaram sem sessão aberta, cobrado no limite de gasto ausente",
		},
		journalReset: (path: string, until: string) =>
			`O diário de canal ${path} não pôde ser interpretado, então foi posto de lado (guardado ao lado dele para inspeção) e um novo começou. Quais turnos ausentes ele guardava é desconhecido, então eles são cobrados como o routines.away.maxUsdPerDay inteiro até ${until}: antes disso nenhuma execução ou turno de canal ausente cobrado por uso começa.`,
		turnsUnread: (channel: string, cause: string) =>
			`Canal ${channel} ausente: os turnos que uma passagem a um modelo cobrado por uso reserva no limite de gasto ausente não puderam ser lidos (${cause}). A sessão dele não passa para um modelo cobrado por uso até eles serem lidos.`,
	},
	retention: {
		ownerFilesUnlisted:
			"Seus arquivos de sessão não puderam ser listados, então os pacotes de sessão antigos das suas sessões não são limpos até poderem (uma remoção já começada ainda termina), e o trabalho de rotinas das sessões apagadas não é resolvido.",
		ownerStateUnreadable:
			"Os pacotes de sessão antigos das suas sessões ou os registros de exclusão deles não puderam ser lidos, então eles não são limpos até poderem.",
		ownerDeletionRecordsUnreadable: (count: number) =>
			count === 1
				? "1 registro de exclusão dos seus pacotes de sessão antigos não pôde ser lido; o pacote dele fica até poder ser lido."
				: `${count} registros de exclusão dos seus pacotes de sessão antigos não puderam ser lidos; os pacotes deles ficam até poderem ser lidos.`,
		interruptedRetentionReleased: (session: string, by: string) =>
			`Sessão ${session}: ${by} cancelou uma limpeza inacabada do estado guardado dela, que pode já ter removido parte ou todo o estado dos workers e do plano.`,
		releasedByOpen: "abri-la",
		releasedByWrite: "um trabalho gravado nela",
		releasedByStartup: "a limpeza de inicialização",
		keptElsewhere: (session: string, place: HolderPlace) =>
			`Sessão ${session}: o estado guardado antigo dela fica enquanto um processo ${place.at} mantém a sessão; essa retenção termina quando o pi ${place.there} abrir a sessão.`,
		removalAwaitsBotHistory: (session: string) =>
			`Sessão ${session}: a limpeza inacabada dela espera até o histórico de todos os bots poder ser lido; abrir a sessão a cancela.`,
		homeWarningsOmitted: (count: number) =>
			count === 1
				? "Mais 1 aviso sobre a limpeza de pacotes de sessão antigos está no log do harness."
				: `Mais ${count} avisos sobre a limpeza de pacotes de sessão antigos estão no log do harness.`,
	},
	model: {
		chosen: (modelId: string) => `Modelo: ${modelId}`,
		defaultChosen: (modelId: string) => `Modelo padrão: ${modelId}`,
		noneAvailable: "Nenhum modelo disponível",
		selectionSaved: "Seleção de modelos salva nas configurações",
		pinned: (current: string, requested: string) =>
			`Esta sessão roda só em ${current}; ela não muda para ${requested}.`,
	},
	thinking: {
		unsupported: "O modelo atual não aceita raciocínio",
		levelSet: (level: string) => `Nível de raciocínio definido em ${level}`,
		defaultLevelSet: (level: string) => `Nível de raciocínio padrão definido em ${level}`,
		invalid: (value: string, levels: string) => `Nível de raciocínio inválido "${value}". Níveis válidos: ${levels}`,
	},
	tree: {
		noEntries: "Nenhuma entrada na sessão",
		alreadyHere: "Você já está neste ponto",
		summarizeTitle: "Resumir o branch?",
		noSummary: "Sem resumo",
		summarize: "Resumir",
		summarizeCustom: "Resumir com um prompt próprio",
		customInstructionsTitle: "Instruções próprias de resumo",
		loader: (interruptKey: string) => `Resumindo o branch... (${interruptKey} para cancelar)`,
		summarizationCancelled: "Resumo do branch cancelado",
		navigationCancelled: "Navegação cancelada",
		navigated: "Navegou até o ponto escolhido",
	},
	trust: {
		applied: (trusted: boolean) => `Projeto ${trusted ? "confiável" : "não confiável"}; aplicado.`,
		saved: (trusted: boolean) =>
			`Decisão de confiança salva: ${trusted ? "confiável" : "não confiável"}. Vale depois de /reload.`,
	},
	resume: {
		forkNoMessages: "Nenhuma mensagem para criar fork",
		forked: (name: string) => `Fork criado numa nova sessão: ${name}`,
		forkedUnnamed: "Fork criado numa nova sessão",
		resumeGoalTitle: "Retomar o objetivo parado?",
		resumeGoal: "Retomar objetivo",
		leaveStopped: "Deixar parado",
		goalResumeFailed: (error: string) => `A retomada do objetivo falhou: ${error}`,
		resumedWithGoal: "Sessão e objetivo retomados",
		resumedGoalPreserved: "Sessão retomada; estado do objetivo preservado",
		cancelled: "Retomada cancelada",
		resumedWithGoalHere: "Sessão e objetivo retomados na pasta atual",
		resumedGoalPreservedHere: "Sessão retomada na pasta atual; estado do objetivo preservado",
		failed: "Não foi possível retomar a sessão",
	},
	clone: {
		nothing: "Nada para duplicar ainda",
		cloned: (name: string) => `Sessão duplicada numa nova sessão: ${name}`,
		clonedUnnamed: "Sessão duplicada numa nova sessão",
	},
	goal: {
		none: "Objetivo: nenhum",
		verbStarted: "iniciado",
		verbOverridden: "substituído",
		head: (userGoal: string) => `Objetivo: ${userGoal}`,
		status: (word: string) => `Estado: ${word}`,
		intentOutage: (cause: string) =>
			`O System One não conseguiu avaliar se a sua mensagem define um objetivo (${cause}); nenhum objetivo foi iniciado.`,
		intentNotStarted: (cause: string) => `Um objetivo pedido pela sua mensagem não foi iniciado: ${cause}`,
		outsideWaitOutage: (cause: string) =>
			`O System One não conseguiu avaliar se os requisitos abertos do objetivo aguardam trabalho externo (${cause}); o objetivo segue apenas os monitoramentos vinculados a um requisito.`,
		intentNoteFailed: (cause: string) =>
			`Um objetivo foi iniciado a partir da sua mensagem, mas o aviso ao agente sobre ele não foi entregue: ${cause}`,
		statusWords: GOAL_STATUS_WORDS,
		/**
		 * Uma frase por ação de objetivo recusada. A ação recusada informa o fato (`goal-refusal.ts`) e tira as palavras
		 * daqui, então o comando do dono e o texto em inglês da mesma recusa nunca escrevem a frase duas vezes.
		 */
		refusal: {
			noGoal: (action: string) => `Não existe objetivo para ${GOAL_ACTION_WORDS[action] ?? action}.`,
			pauseNotActive: (status: string) => `O objetivo está ${status}; só objetivos ativos podem ser pausados.`,
			resumeNotResumable: (status: string) =>
				`O objetivo está ${status}; só é possível retomar um objetivo pausado, bloqueado ou parado no limite de uso.`,
			editGoalCancelled: "O objetivo está cancelado; inicie um novo objetivo.",
			editObjectiveEmpty: "O objetivo não pode ficar vazio.",
			editObjectiveTooLong: (limit: number) => `O objetivo pode ter no máximo ${limit} caracteres.`,
			editTokenBudgetInvalid: "O orçamento de tokens do objetivo precisa ser um inteiro positivo quando informado.",
			goalAlreadyEnded: (status: string) => `O objetivo já está ${status}.`,
			systemStopUnneeded: (status: string) => `O objetivo está ${status}; nenhuma parada do sistema é necessária.`,
			systemStopReasonEmpty: "A parada de um objetivo pelo sistema exige um motivo.",
			clearUnsupported: "Esta sessão não permite limpar objetivos.",
			startGoalIdEmpty: "Não é possível iniciar um objetivo sem um goalId.",
			startObjectiveEmpty: "Não é possível iniciar um objetivo sem um userGoal.",
			startGoalIdTooLong: (limit: number) => `O goalId de um objetivo novo pode ter no máximo ${limit} caracteres.`,
			startObjectiveTooLong: (limit: number) => `O userGoal pode ter no máximo ${limit} caracteres.`,
			startTokenBudgetInvalid: "O tokenBudget precisa ser um inteiro positivo quando informado.",
			/** O estado chega como o identificador que o registro guarda, e a frase em português mostra a palavra dele. */
			unfinishedGoal: (goalId: string, status: string, newGoalId: string) =>
				`Já existe um objetivo inacabado '${goalId}' (${goalStatusWord(status)}). Conclua, limpe ou substitua esse objetivo explicitamente antes de iniciar '${newGoalId}'.`,
			reopenRequirementIdEmpty: "Não é possível reabrir um requisito sem um requirementId.",
			goalAlreadyCompleted: (goalId: string) => `O objetivo '${goalId}' já está concluído.`,
			goalAlreadyCancelled: (goalId: string) =>
				`O objetivo '${goalId}' está cancelado; inicie um novo objetivo ou substitua por ele.`,
		},
		blockedReason: (reason: string) => `Motivo do bloqueio: ${reason}`,
		tokens: (used: number, budget?: number) =>
			budget === undefined ? `Tokens: ${used}` : `Tokens: ${used}/${budget}`,
		requirement: (args: { id: string; status: string; blockedReason?: string }) => {
			const blocked = args.blockedReason ? ` (${args.blockedReason})` : "";
			return `- ${args.id}: ${args.status}${blocked}`;
		},
		counts: (args: { open: number; blocked: number; satisfied: number }) =>
			`Requisitos: abertos ${args.open}, bloqueados ${args.blocked}, satisfeitos ${args.satisfied}`,
		controls:
			"Controles: /goal edit | /goal pause | /goal resume | /goal reopen <requirement-id> | /goal complete | /goal clear | /goal override <text>",
		failed: (error: string) => `O comando de objetivo falhou: ${error}`,
		resumed: "Objetivo retomado.",
		paused: "Objetivo pausado.",
		updated: "Objetivo atualizado.",
		completed: "Objetivo concluído manualmente.",
		cleared: "Objetivo limpo.",
		nothingToClear: "Não existe objetivo para limpar.",
		closed: "Objetivo encerrado.",
		editUsage: "Uso: /goal edit <objective>",
		nothingToEdit: "Não existe objetivo para editar.",
		reopenUsage: "Uso: /goal reopen <requirement-id>",
		nothingToUpdate: "Não existe objetivo para atualizar.",
		requirementNotBlocked: (id: string, status: string) =>
			`O requisito '${id}' está ${status}; só requisitos bloqueados podem ser reabertos.`,
		requirementUnknown: (id: string) => `Requisito desconhecido: '${id}'.`,
		requirementReopened: (id: string, resumed: boolean) =>
			`Requisito '${id}' reaberto${resumed ? " e objetivo retomado" : ""}.`,
		overrideUsage: "Uso: /goal override <text>",
		overrideHint: " Use /goal override <text> para substituí-lo explicitamente.",
		alreadyContinuing: (verb: string) => `Objetivo ${verb}: o ciclo de autonomia já continua este objetivo.`,
		disposedBeforeContinuation: (verb: string) =>
			`Objetivo ${verb}, mas a sessão foi descartada antes de a continuação rodar.`,
		started: (args: { verb: string; action: string; reason: string }) =>
			`Objetivo ${args.verb}: ${args.action}, ${args.reason}.`,
		continuationFailed: (error: string) => `A continuação do objetivo falhou: ${error}`,
		continueStarted: (args: { turns: string; stallTurns: number; wallClock: string }) =>
			`Continuação do objetivo iniciada: ${args.turns}, limite de recuperação ${args.stallTurns}, limite de tempo em minutos: ${args.wallClock}.`,
		unboundedTurns: "turnos sem limite",
		upToTurns: (turns: number) => `até ${turns} ${turns === 1 ? "turno" : "turnos"}`,
		disabled: "desativado",
		continueStopped: (args: { stopReason: string; turns: number; action: string; reason: string }) =>
			`Continuação do objetivo parada: ${args.stopReason}; ${args.turns} ${args.turns === 1 ? "turno enviado" : "turnos enviados"}; última decisão: ${args.action}, ${args.reason}.`,
	},
	task: {
		retired: (operation: string) =>
			`/task ${operation} não existe mais. Peça ao Pi para delegar o trabalho; os workers relatam quando terminam.`,
	},
	closing: {
		runUnsettled: (seconds: number) =>
			`Uma execução não terminou em ${seconds}s após o encerramento; a mensagem final dela pode não ter sido gravada.`,
		reflectionUnsettled: (seconds: number) =>
			`Um turno de reflexão não terminou em ${seconds}s após o encerramento; o trabalho dele pode não ter sido gravado.`,
		compactionUnsettled: (seconds: number) =>
			`Uma compactação não terminou em ${seconds}s após o encerramento; o resultado dela foi descartado.`,
		ownerGoalJudgmentUnsettled: (seconds: number) =>
			`Uma avaliação de objetivo do dono não terminou em ${seconds}s após o encerramento; o uso dela pode ser registrado mais tarde.`,
		routineIntakeUnsettled: (seconds: number) =>
			`Uma passada da entrada de rotinas não terminou em ${seconds}s após o encerramento; o uso dela pode ser registrado mais tarde.`,
	},
	info: {
		title: "Informações da sessão",
		name: "Nome:",
		file: "Arquivo:",
		inMemory: "Em memória",
		id: "ID:",
		messages: "Mensagens",
		user: "Usuário:",
		assistant: "Assistente:",
		toolCalls: "Chamadas de ferramenta:",
		toolResults: "Resultados de ferramenta:",
		total: "Total:",
		tokens: "Tokens",
		input: "Entrada:",
		output: "Saída:",
		cacheRead: "Leitura de cache:",
		cacheWrite: "Escrita de cache:",
		cost: "Custo",
		modelRouter: "Roteador de modelos",
	},
	io: {
		exported: (path: string) => `Sessão exportada para: ${path}`,
		exportFailed: (error: string) => `Falha ao exportar a sessão: ${error}`,
		importUsage: "Uso: /import <path.jsonl>",
		importTitle: "Importar sessão",
		importQuestion: (path: string) => `Substituir a sessão atual por ${path}?`,
		importCancelled: "Importação cancelada",
		imported: (path: string) => `Sessão importada de: ${path}`,
		importFailed: "Falha ao importar a sessão",
		ghMissing: "O GitHub CLI (gh) não está instalado. Instale de https://cli.github.com/",
		ghAuthCheckFailed: (error: string) => `Falha ao verificar a autenticação do GitHub CLI: ${error}`,
		ghNotLoggedIn: "O GitHub CLI não está autenticado. Rode 'gh auth login' primeiro.",
		creatingGist: "Criando o gist...",
		shareCancelled: "Compartilhamento cancelado",
		gistTimedOut: "Tempo esgotado ao criar o gist",
		gistFailed: (stderr: string) => `Falha ao criar o gist${stderr ? `: ${stderr}` : ""}`,
		gistIdUnparsed: "Falha ao ler o ID do gist na saída do gh",
		shareUrls: (args: { url: string; gistUrl: string }) =>
			`URL do compartilhamento: ${args.url}\nGist: ${args.gistUrl}`,
		gistCreateFailed: (error: string) => `Falha ao criar o gist: ${error}`,
		nothingToCopy: "Nenhuma mensagem do agente para copiar ainda.",
		unknownError: "Erro desconhecido",
		copiedSelection: "Seleção copiada para a área de transferência",
		copiedLast: "Última mensagem do agente copiada para a área de transferência",
		sessionName: (name: string) => `Nome da sessão: ${name}`,
		nameUsage: "Uso: /name <name>",
		sessionNameSet: (name: string) => `Nome da sessão definido: ${name}`,
	},
} satisfies InterfaceText["sessions"];
