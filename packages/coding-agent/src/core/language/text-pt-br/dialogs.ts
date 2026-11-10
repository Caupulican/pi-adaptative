/**
 * The Brazilian Portuguese words of the connection dialogs: the login and OAuth dialogs, the controller that runs the
 * login and logout flows, the frame around a human question, the session-start readiness prompt and the yes/no prompts.
 * Actions are infinitives and a failed call names what failed before it repeats the provider's own sentence.
 */

import type { InterfaceText } from "../interface-text.ts";

export const DIALOGS = {
	login: {
		title: (provider: string) => `Entrar em ${provider}`,
		openClickMac: "Cmd+clique para abrir",
		openClickOther: "Ctrl+clique para abrir",
		enterCode: (code: string) => `Digite o código: ${code}`,
		examplePlaceholder: (placeholder: string) => `ex.: ${placeholder}`,
		toCancel: "para cancelar",
		toSubmit: "para enviar",
		toClose: "para fechar",
	},
	oauth: {
		titleLogin: "Selecione o provedor para configurar:",
		titleLogout: "Selecione o provedor para desconectar:",
		configured: " ✓ configurado",
		subscriptionConfigured: "assinatura configurada",
		apiKeyConfigured: "chave de API configurada",
		environmentKey: (label: string) => ` ✓ env: ${label}`,
		environmentKeyDefault: "chave de API",
		runtimeKey: " ✓ chave de API do runtime",
		customKey: " ✓ chave de API própria",
		modelsJsonKey: " ✓ chave no models.json",
		modelsJsonCommand: " ✓ comando no models.json",
		unconfigured: "não configurado",
		noProviders: "Nenhum provedor disponível",
		noLoggedIn: "Nenhum provedor conectado. Use /login primeiro.",
		noMatching: "Nenhum provedor corresponde",
	},
	authDialogs: {
		loggedOut: (provider: string) => `Desconectado de ${provider}`,
		apiKeyRemoved: (provider: string) =>
			`Chave de API de ${provider} removida. Variáveis de ambiente e a configuração do models.json não mudam.`,
		logoutFailed: (message: string) => `Falha ao desconectar: ${message}`,
		methodTitle: "Selecione o método de autenticação:",
		methodSubscription: "Usar uma assinatura",
		methodApiKey: "Usar uma chave de API",
		noSubscriptionProviders: "Nenhum provedor por assinatura disponível.",
		noApiKeyProviders: "Nenhum provedor por chave de API disponível.",
		unknownLoginProvider: (reference: string) =>
			`Provedor de login desconhecido: "${reference}". Use /login para escolher entre os provedores disponíveis.`,
		noStoredCredentials:
			"Nenhuma credencial salva para remover. /logout remove apenas credenciais salvas por /login; variáveis de ambiente e a configuração do models.json não mudam.",
		noStoredCredentialsFor: (reference: string) =>
			`Nenhuma credencial salva para "${reference}". Use /logout para escolher um provedor salvo.`,
		typesafeStatus:
			"O System One está disponível pelo systemone; a autenticação do TypeSafe é verificada no primeiro uso.",
		loggedIn: (provider: string) => `Conectado a ${provider}`,
		apiKeySaved: (provider: string) => `Chave de API de ${provider} salva`,
		noDefaultModel: (action: string, provider: string) =>
			`${action}, mas não há modelo padrão configurado para o provedor "${provider}". Use /model para escolher um modelo.`,
		noModels: (action: string) =>
			`${action}, mas não há modelos disponíveis para esse provedor. Use /model para escolher um modelo.`,
		defaultModelUnavailable: (action: string, modelId: string) =>
			`${action}, mas o modelo padrão "${modelId}" não está disponível. Use /model para escolher um modelo.`,
		selectModelFailed: (action: string, message: string) =>
			`${action}, mas a seleção do modelo padrão falhou: ${message}. Use /model para escolher um modelo.`,
		statusSelected: (action: string, modelId: string, authPath: string) =>
			`${action}. Modelo selecionado: ${modelId}. Credenciais salvas em ${authPath}`,
		statusSaved: (action: string, authPath: string) => `${action}. Credenciais salvas em ${authPath}`,
		bedrockTitle: "Configurar o Amazon Bedrock:",
		bedrockSsoProfile: (profile: string) => `Entrar com o perfil SSO "${profile}"`,
		bedrockSso: "Entrar com um perfil SSO da AWS",
		bedrockOther: "Usar credenciais IAM, bearer ou de role",
		bedrockCredentialInfoTitle: "Configuração do Amazon Bedrock",
		bedrockCredentialUses: "O Amazon Bedrock usa credenciais da AWS em vez de uma única chave de API.",
		bedrockCredentialConfigure:
			"Configure chaves IAM, um token bearer ou credenciais de role e então verifique a região exata delas.",
		see: "Veja:",
		bedrockVerified: (message: string, count: number, region: string) =>
			`${message} ${count} ${count === 1 ? "modelo verificado" : "modelos verificados"} em ${region}.`,
		bedrockReady: "As credenciais do Amazon Bedrock estão prontas.",
		bedrockSignedIn: (profile: string) => `Conectado com o perfil da AWS "${profile}".`,
		bedrockSsoTitle: "SSO do Amazon Bedrock",
		regionPrompt: "Região da AWS (obrigatória):",
		ssoProfilePrompt: "Nome do perfil SSO da AWS:",
		ssoProfileExample: "meu-perfil-de-trabalho",
		regionEmpty: "A região da AWS não pode ficar vazia.",
		profileEmpty: "O nome do perfil da AWS não pode ficar vazio.",
		apiKeyEmpty: "A chave de API não pode ficar vazia.",
		apiKeyNotSaved:
			"A chave de API não foi salva; ela vale só nesta sessão. Verifique as permissões de armazenamento de credenciais e tente de novo.",
		verifyingAws: "Verificando a identidade na AWS, os perfis do Bedrock e o acesso aos modelos...",
		waitingForSso: "Aguardando a autenticação SSO da AWS...",
		usingProfile: (profile: string) => `Usando o perfil da AWS: ${profile}`,
		bedrockRegion: (region: string) => `Região do Bedrock: ${region}`,
		finishSignIn: "Conclua o login no IAM Identity Center no navegador.",
		apiKeyPrompt: "Informe a chave de API:",
		manualCodePrompt: "Cole a URL de redirecionamento abaixo, ou conclua o login no navegador:",
		waitingForAuth: "Aguardando a autenticação...",
		configureFailed: (provider: string) => `Falha ao configurar ${provider}: `,
		signInFailed: (provider: string) => `Falha ao entrar em ${provider}: `,
		saveApiKeyFailed: (provider: string) => `Falha ao salvar a chave de API de ${provider}: `,
		loginFailed: (provider: string) => `Falha ao entrar em ${provider}: `,
	},
	question: {
		assistant: "Assistente",
		you: "Você",
		waiting: "Aguardando a sua resposta",
		status: "Estado da pergunta",
		clipboardLimit: "A conversa passa do limite da área de transferência; use /export para a sessão completa.",
	},
	readiness: {
		delegationOff: "A delegação está desligada, então o orquestrador não consegue iniciar workers.",
		delegationFix: "Ligar a delegação",
		workersNoModel: "Os workers não têm modelo permitido, então o trabalho delegado falharia.",
		workersFix: "Deixar os workers usarem o modelo desta sessão",
		skip: "Agora não",
		auto: "Configurar para mim (assinaturas primeiro; chaves de API ficam sem uso a menos que você peça)",
		sessionModel: (modelRef: string) => `Modelo desta sessão (${modelRef})`,
		choosePrompt: (problem: string) =>
			`${problem} Escolha como os workers recebem o modelo, ou escolha um perfil de worker: um modelo que todo worker usa (uma tarefa pesada só eleva o raciocínio dele).`,
		delegationOn: "A delegação está ligada.",
		workersSubscriptions: (providers: string) =>
			`Os workers vão usar as suas assinaturas (${providers}). As chaves de API ficam sem uso.`,
		workersModel: (modelRef: string) =>
			`Os workers vão usar ${modelRef}. Altere quando quiser em workerDelegation.modelPins nas configurações.`,
	},
	selectionPrompts: {
		yes: "Sim",
		no: "Não",
	},
} satisfies InterfaceText["dialogs"];
