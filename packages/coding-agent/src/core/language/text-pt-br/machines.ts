/**
 * As palavras em português do Brasil dos comandos de máquina: o link entre máquinas (`/remote` e os comandos de job),
 * os objetivos entregues aos líderes (`/lead`) e a carga da máquina com a parada de emergência (`/load`, `/estop`),
 * junto com a listagem de carga que `/load` imprime. Nomes de máquina, nomes de link, tokens e o que um modelo ou o dono
 * escreveu ficam como estão.
 */

import type { InterfaceText } from "../interface-text.ts";

export const MACHINES = {
	remote: {
		usage: (jobUsage: string) =>
			`Uso: /remote [status] | /remote listen [port] [host] | /remote stop | /remote add <name> | /remote revoke <name> | /remote join <host:port> <token> | /remote leave <host:port> | /remote name <name> | ${jobUsage}`,
		connected: "conectado",
		connectedUnsealed: "conectado, sem selo",
		status: {
			thisMachine: (name: string) => `Esta máquina é ${name}.`,
			listening: (host: string, port: number) => `Hub: escutando em ${host}:${port}.`,
			hostedBy: (where: string) => `Hub: hospedado por ${where}; esta sessão usa esse hub.`,
			notListening: "Hub: não está escutando (/remote listen [port] [host]).",
			machineRevoked: "revogada",
			machineConnectedSealed: "conectada",
			machineConnectedUnsealed: "conectada (sem selo)",
			machineOffline: "offline",
			machinesSome: (list: string) => `Máquinas: ${list}.`,
			machinesNone: "Máquinas: nenhuma ainda (/remote add <name>).",
			jobJoined: (args: { hubName: string; address: string; name: string; state: string }) =>
				`${args.hubName} em ${args.address} como ${args.name} (${args.state})`,
			joinedSome: (list: string) => `Conectado a: ${list}.`,
			joinedNone: "Conectado a: nenhum hub (/remote join <host:port> <token>).",
		},
		listen: {
			listening: (host: string, port: number) => `Escutando em ${host}:${port}.`,
			publicNote:
				"O link prova um segredo por máquina e sela (criptografa e autentica) cada mensagem com máquinas numa build atual; uma máquina numa build antiga se conecta sem selo. Prefira uma rede privada (Tailscale, WireGuard) ou um túnel SSH.",
			loopbackNote:
				"Escutando só nesta máquina; use um túnel SSH ou informe um host para alcançá-la de outra máquina.",
			stopped:
				"O hub parou de escutar. As máquinas conectadas continuam conhecidas e se reconectam quando ele voltar.",
		},
		add: {
			usage: (usage: string) => `Uso: /remote add <name> (letras minúsculas, dígitos, hífens). ${usage}`,
			added: (args: { name: string; address: string; token: string; listening: boolean }) =>
				`${args.name} já pode entrar, como um bot chamado ${args.name}. Naquela máquina rode:\n/remote join ${args.address} ${args.token}\nO token é mostrado uma vez; mantenha-o em segredo.${
					args.listening ? "" : "\nEste hub ainda não está escutando: rode /remote listen."
				}`,
			revoked: (name: string) => `${name} foi desconectada e o bot dela foi aposentado.`,
			unknown: (name: string) => `Nenhuma máquina chamada ${name}.`,
		},
		join: {
			usage: "Uso: /remote join <host:port> <token>",
			joined: (args: { hubName: string; address: string; name: string }) =>
				`Conectado a ${args.hubName} em ${args.address} como ${args.name}. As mensagens dele chegam a esta sessão como palavras de um peer, nunca como suas.`,
			left: "Saiu daquele hub.",
			notJoined: "Nenhum hub conectado naquele endereço.",
		},
		rename: (name: string) => `Esta máquina agora é ${name}.`,
		unknownCommand: (usage: string) => `Comando /remote desconhecido. ${usage}`,
		failed: "O comando do link falhou.",
	},
	jobs: {
		usage: "/remote jobs | /remote run <name> <task> | /remote cancel <name> | /remote hold <name> | /remote release <name> | /remote trust <name> answers|reads|changes | /remote accept <name> on|off | /remote rotate <name>",
		reporting: (status: string) => `${status}, relatando`,
		waitingFor: (executor: string) => `aguardando ${executor} pegar`,
		progress: (phase: string, line: string) => `${phase}: ${line}`,
		taken: "pego",
		unreadablePart: (machineName: string, count: number) => `${machineName}: ${count}`,
		unreadableUnnamedMachine: "uma máquina não mais conectada",
		unreadableUnnamed: (count: number) => `${count} sem máquina nomeada`,
		unreadableLine: (parts: string) =>
			`Registros de job que esta build não consegue ler, mantidos como estão e contados como abertos: ${parts}.`,
		row: (label: string, executor: string, words: string) => `- ${label} em ${executor}: ${words}`,
		placed: (count: number) => `Jobs colocados daqui (${count}):`,
		nonePlaced: "Nenhum job colocado daqui.",
		older: (count: number) => `e mais ${count} antigos.`,
		runningHere: (count: number) => `Rodando aqui para outras máquinas: ${count}.`,
		nothingRunningHere: "Nada rodando aqui para outras máquinas.",
		unavailable: "Jobs remotos não estão disponíveis nesta sessão.",
		refused: (machine: string, reason: string) => `${machine} não recebeu o job: ${reason}.`,
		accepted: (machine: string, detail: string) =>
			`${machine} está com o job, só leitura, ${detail}. O fim dele chega a esta sessão como relatório de worker.`,
		inCheckout: "no checkout dela deste projeto",
		noCheckout: "como uma pergunta sem checkout (ela não oferece este projeto)",
		rotateUnknown: (name: string) => `Nenhuma máquina chamada ${name} entrou neste hub.`,
		rotated: (name: string, token: string) =>
			`${name} tem um segredo novo e foi desconectada; os jobs dela são mantidos. Naquela máquina rode /remote leave e depois:\n/remote join <this-hub-address> ${token}\nO token é mostrado uma vez; mantenha-o em segredo.`,
		unknownMachine: (name: string, jobUsage: string) =>
			`Nenhuma máquina conectada chamada ${name} se conectou ainda. Uso: ${jobUsage}`,
		runUsage: "Uso: /remote run <name> <task>",
		noOpenJob: (machine: string) => `Nenhum job aberto em ${machine}.`,
		stopped: (count: number, machine: string) =>
			`${count} ${count === 1 ? "job parado" : "jobs parados"} em ${machine}.`,
		stopRecorded: (count: number, machine: string) =>
			`Parada registrada para ${count} ${count === 1 ? "registro" : "registros"} de job em ${machine} que esta build não consegue ler. Os registros ficam como estão; a sessão que colocou o job encerra a lane de cada um na próxima reconciliação, e a parada é enviada para ${machine} quando ela estiver conectada.`,
		held: (machine: string) => `Nenhum job novo vai para ${machine}; os que já estão lá continuam.`,
		released: (machine: string) => `${machine} pode receber jobs de novo.`,
		trustUsage: "Uso: /remote trust <name> answers|reads|changes",
		trustAnswers: (machine: string) => `${machine} pode pedir a esta máquina apenas respostas.`,
		trustReads: (machine: string) => `${machine} pode pedir a esta máquina respostas e leituras dos checkouts dela.`,
		trustChanges: (machine: string) => `${machine} pode pedir a esta máquina respostas, leituras e alterações.`,
		acceptUsage: "Uso: /remote accept <name> on|off",
		accepts: (machine: string) => `Esta máquina roda os jobs que ${machine} coloca aqui.`,
		refuses: (machine: string) => `Esta máquina não aceita jobs novos de ${machine}; os que já estão aqui terminam.`,
	},
	lead: {
		usage: "Uso: /lead [list|show <leader>|cancel <leader>|pause <leader>|resume <leader>]. Isto age nos objetivos entregues a líderes; para tornar um bot líder, use /bot lead <id>.",
		closeWords: {
			settled: "o líder terminou",
			cancelled: "cancelado",
			deadline: "o tempo acabou",
			budget: "o orçamento acabou",
			allowance: "uma assinatura em uso ficou sem cota na janela de uso",
			leader_unavailable: "o líder não estava disponível",
		},
		noSuchBot: (alias: string) => `Não existe bot chamado ${alias}. Os nomes de bot estão em /bot list.`,
		notALeader: (bot: string, alias: string) =>
			`${bot} não é líder, então não tem objetivos para mostrar nem para mudar. Para torná-lo líder, use /bot lead ${alias}.`,
		listEmpty:
			"Nenhum objetivo foi entregue a um líder. O orquestrador entrega um com bot lead; /bot lead <id> torna um bot líder permanente.",
		listHeader: "Objetivos entregues a líderes:",
		listRow: (args: { name: string; leader: string; goal: string; state: string }) =>
			`  ${args.name} (${args.leader}) · ${args.goal} · ${args.state}`,
		leads: (name: string, goal: string) => `${name} lidera: ${goal}`,
		state: (state: string, closeWord?: string) => `Estado: ${state}${closeWord ? ` (${closeWord})` : ""}`,
		appointed: "Nomeado pelo orquestrador para este objetivo; sai quando ele termina.",
		standing: "Um líder permanente criado pelo dono.",
		requirements: "Precisa ser verdade no fim:",
		rules: "Regras:",
		mayChange: (paths: string) => `Pode alterar: ${paths}`,
		readOnly: "Só leitura: nenhum arquivo é alterado.",
		budget: (amount: string) =>
			`Orçamento: $${amount} de gasto cobrado por uso. Turnos por assinatura não são cobrados por uso, então não entram nessa conta.`,
		stopsAt: (at: string) => `Para em: ${at}`,
		heldBack: "Retido:",
		updatesSent: (count: number) => `Atualizações enviadas: ${count}`,
		ledNothing: (name: string) => `${name} é líder e ainda não liderou nenhum objetivo.`,
		actionDone: (name: string, state: string) => `${name}: ${state}.`,
	},
	load: {
		usage: "/load",
		estopUsage: "/estop [status] · /estop on [reason] · /estop off",
		estopStatusOn: (args: { reason?: string; engagedAt?: string; usage: string }) =>
			`Parada de emergência: acionada${args.reason ? ` (${args.reason})` : ""}${args.engagedAt ? ` desde ${args.engagedAt}` : ""}; novas requisições de worker e de segundo plano ficam retidas nesta máquina. ${args.usage}`,
		estopStatusOff: (usage: string) => `Parada de emergência: desligada. ${usage}`,
		estopEngaged: (reason?: string) =>
			`Parada de emergência acionada${reason ? ` (${reason})` : ""}: todo pi nesta máquina retém novas requisições de worker e de segundo plano; turnos em primeiro plano continuam. /estop off desfaz.`,
		estopLifted: "Parada de emergência desfeita; o trabalho retido volta agora.",
		estopNotEngaged:
			"Nenhuma parada de emergência estava acionada; inícios pagos retidos e workers na fila voltam agora.",
		view: {
			header: (count: number) =>
				`Carga dos provedores: ${count} ${count === 1 ? "requisição" : "requisições"} em andamento na máquina`,
			provider: (args: {
				account: string;
				inFlight: number;
				foreground: number;
				worker: number;
				background: number;
				processes: number;
				limit?: number;
				oldest: string;
			}) =>
				`  ${args.account}: ${args.inFlight} em andamento (${args.foreground} primeiro plano, ${args.worker} worker, ${args.background} segundo plano) ` +
				`em ${args.processes} processo${args.processes === 1 ? "" : "s"}${args.limit ? `, limite ${args.limit}` : ""}, a mais antiga há ${args.oldest}`,
			limitedHeader: "Limitados:",
			limitedRow: (args: {
				account: string;
				reason: string;
				until: string;
				left: string;
				pid: number;
				detail?: string;
			}) =>
				`  ${args.account}: ${args.reason} até ${args.until} ` +
				`(faltam ${args.left}, registrado pelo pid ${args.pid}${args.detail ? `: ${args.detail}` : ""})`,
			limitedNone: "Limitados: nenhum registrado",
			windowsHeader: "Janelas dos provedores:",
			window: (args: { account: string; name: string; parts: string; seen: string }) =>
				`  ${args.account} ${args.name}: ${args.parts} (visto há ${args.seen})`,
			windowUsed: (args: { minutes: string; percent: number; resetsAt?: string }) =>
				`${args.minutes} ${args.percent}% usado${args.resetsAt ? `, renova em ${args.resetsAt}` : ""}`,
			windowMinutes: (minutes: number) => `${minutes}m`,
			windowFallbackName: "janela",
			creditsUnlimited: "ilimitados",
			creditsBalance: (balance: string) => `saldo ${balance}`,
			creditsNone: "nenhum",
			creditsUnknown: "desconhecido",
			credits: (args: { account: string; state: string; seen: string }) =>
				`  ${args.account} créditos: ${args.state} (visto há ${args.seen})`,
			stopEngaged: (args: { reason?: string; engagedAt?: string; path: string }) =>
				`Parada de emergência: ACIONADA${args.reason ? ` (${args.reason})` : ""}${args.engagedAt ? ` desde ${args.engagedAt}` : ""}; novas requisições de worker e de segundo plano ficam retidas (${args.path})`,
			stopOff:
				"Parada de emergência: desligada (/estop on [reason] pausa novos trabalhos de worker e de segundo plano nesta máquina)",
		},
	},
} satisfies InterfaceText["machines"];
