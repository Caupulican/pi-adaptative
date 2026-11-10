/**
 * Os avisos em português do Brasil que o host escreve na tela: as linhas de erro e de aviso em volta de uma falha, o
 * que uma compactação e uma nova tentativa dizem ao começar, terminar e cair para a alternativa, e os avisos de uma
 * linha das checagens de início. Nada daqui chega a um modelo: uma mensagem que uma ferramenta ou um provedor escreveu
 * é entregue inteira e mantém as próprias palavras.
 */

import type { InterfaceText } from "../interface-text.ts";

export const NOTICES = {
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

	widgetTruncated: "... (widget truncado)",
} satisfies InterfaceText["notices"];
