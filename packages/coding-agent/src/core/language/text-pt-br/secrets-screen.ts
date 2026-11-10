/**
 * O menu de segredos sobre o Bitwarden em português do Brasil: a lista de ações, os formatos de credencial,
 * os pedidos de cada fluxo e os avisos que ele mostra. Nada aqui é enviado a um modelo.
 */

export const SECRETS_SCREEN = {
	title: "Segredos · Bitwarden",
	actions: {
		add: "Adicionar ou atualizar credenciais",
		activate: "Ativar credenciais neste projeto",
		bind: "Usar um perfil existente neste projeto",
		remove: "Excluir um perfil de credenciais",
		reconnect: "Reconectar o Bitwarden",
		lock: "Bloquear as credenciais do Pi",
		close: "Fechar",
	},
	shapes: {
		userPassword: "Usuário e senha",
		key: "Token de API ou chave privada",
		dotenv: "Variáveis de ambiente (formato .env)",
	},
	variableCount: (count: number) => (count === 1 ? "1 variável" : `${count} variáveis`),
	notices: {
		machineSetup:
			"O Bitwarden não está conectado. Defina BWS_ACCESS_TOKEN ou BW_SESSION no seu ambiente você mesmo; o Pi nunca pede isso.",
		failedSafely: "A operação de credencial falhou com segurança, sem expor dados privados.",
		keyFileMissing: "o arquivo de chave arrastado não foi encontrado ou não é um arquivo comum",
		keyFileTooLarge: "o arquivo de chave arrastado passa do limite de 64 KiB",
		reconnected: "Bitwarden reconectado com as credenciais da máquina.",
		locked: "O acesso às credenciais do Pi está bloqueado nesta sessão.",
		profileRequired: "O nome do perfil de credenciais é obrigatório.",
		noGitRemote: "Este projeto não tem um remoto Git portátil, então a ligação fica local nesta máquina.",
	},
	prompts: {
		profile: "Perfil de credenciais",
		profilePlaceholder: "Exemplo: deploy-prod",
		updateTitle: "Atualizar perfil de credenciais",
		updateBody: (profile: string) =>
			`Substituir os valores gravados de ${profile} e manter as ligações aos projetos?`,
		description: "Descrição",
		descriptionPlaceholder: "Descrição opcional, sem segredo",
		shape: "Formato da credencial",
		stored: (profile: string, variables: string) =>
			`Credenciais de ${profile} gravadas e ativadas no Bitwarden (${variables}).`,
		usernameVariable: "Variável do usuário",
		username: "Usuário",
		usernamePlaceholder: "Digite o usuário da conta",
		passwordVariable: "Variável da senha",
		password: "Senha",
		passwordPlaceholder: "Digite a senha da conta",
		keyVariable: "Variável da chave",
		privateValueTitle: (variable: string) => `Valor privado · ${variable}`,
		privateValueNotice:
			"Cole um token ou chave, ou arraste o caminho absoluto de um arquivo de chave · nunca enviado ao modelo",
		environmentTitle: "Credenciais de ambiente",
		environmentNotice: "Editor .env privado · cole uma ou mais entradas NAME=value · nunca enviado ao modelo",
		activateTitle: "Ativar credenciais",
		activated: (profile: string, project: string, variables: string) =>
			`${profile} ativado em ${project} (${variables}).`,
		bindTitle: "Usar perfil neste projeto",
		bound: (profile: string, project: string) => `${profile} ligado a ${project}.`,
		removeTitle: "Excluir perfil de credenciais",
		removeBody: (profile: string) => `Mover ${profile} para a lixeira do Bitwarden e limpar seu ambiente ativo?`,
		removed: (profile: string, variables: string) => `${profile} excluído (${variables}).`,
	},
};
