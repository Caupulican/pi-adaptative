/**
 * As palavras em português do Brasil do fluxo de sessão e dos comandos de entrada e saída de sessão: os seletores de
 * modelo, de raciocínio e de árvore, o seletor de sessões, os comandos de objetivo e de etapas, o bloco de informações da
 * sessão e `/export`, `/import`, `/share`, `/copy` e `/name`. As folhas que levam um valor, uma contagem ou um plural são
 * funções. Um prompt cuja resposta o código compara mantém a resposta como identificador e tira o rótulo daqui.
 */

import type { InterfaceText } from "../interface-text.ts";

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
	model: {
		chosen: (modelId: string) => `Modelo: ${modelId}`,
		defaultChosen: (modelId: string) => `Modelo padrão: ${modelId}`,
		noneAvailable: "Nenhum modelo disponível",
		selectionSaved: "Seleção de modelos salva nas configurações",
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
