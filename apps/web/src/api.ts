import type {
	HubChoice,
	HubFile,
	HubTarget,
} from "@hatchlight/core/hugging-face";
import type {
	AccountView,
	ApiTokenView,
	Asset,
	AssistantView,
	AuthSessionView,
	CheckpointInfo,
	CreateTurnInput,
	GalleryItem,
	InviteView,
	LocalModelsView,
	LoraInfo,
	ModelFolder,
	ModelFolderSuggestion,
	ModelSpec,
	ProviderStatus,
	Session,
	Settings,
	TokenExpiryDays,
	TokenScope,
	TrainerStatus,
	TrainingView,
	TurnView,
	UserRole,
} from "@hatchlight/core/types";
import { useQuery } from "@tanstack/react-query";

/** What the assistant thinks with: this computer, a service, or nothing. */
export type AssistantBrain =
	| "local"
	| "openai"
	| "google"
	| "openrouter"
	| null;

export type SessionDetail = Session & { turns: TurnView[] };

/** What an agent may spend, as the person chose it. */
export interface AgentPolicy {
	allowPaid: boolean;
	spendLimitUsd: number | null;
}

/** How AI agents connect to this installation. */
export interface AgentsStatus {
	/** `claude mcp add …`, without the options of a policy. */
	claudeCode: string[];
	/** The same from Linux in WSL, for a Windows installation. */
	claudeCodeWsl: string[] | null;
	/** The shell those words are for, to quote them. */
	shell: "posix" | "powershell";
	claudeDesktop: {
		available: boolean;
		connected: boolean;
		/** The entry starts this installation as it is now. */
		current: boolean;
		policy: AgentPolicy | null;
		/** Why its settings could not be read, when they could not. */
		problem: string | null;
	};
}

/** An error from the server, with the code that lets the interface translate it. */
export class ApiError extends Error {
	constructor(
		message: string,
		readonly code?: string,
		readonly params?: Record<string, string | number>,
	) {
		super(message);
	}
}

/** True when Hatchlight runs as a server, where machine settings are left out. */
export function useServerMode(): boolean {
	const server = useQuery({
		queryKey: ["server"],
		queryFn: api.server,
		staleTime: Number.POSITIVE_INFINITY,
	});
	return server.data?.mode === "server";
}

/** What the person may grant: a role and what it may do. */
export interface InviteTerms {
	role: UserRole;
	canUsePaid: boolean;
	canTrain: boolean;
	monthlyLimitUsd: number | null;
}

/** How Hatchlight runs, and whether it is reached over https. */
export interface ServerInfo {
	mode: "personal" | "server";
	secure: boolean;
}

let signedOut: (() => void) | null = null;
let roomChanged: (() => void) | null = null;

/** Calls `handler` when the server says a person's room is full. */
export function whenRoomFull(handler: () => void): () => void {
	roomChanged = handler;
	return () => {
		if (roomChanged === handler) roomChanged = null;
	};
}

/** Calls `handler` when the server says the session is gone. */
export function whenSignedOut(handler: () => void): () => void {
	signedOut = handler;
	return () => {
		if (signedOut === handler) signedOut = null;
	};
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
	const response = await fetch(path, init);
	if (!response.ok) {
		const body = await response.json().catch(() => null);
		// Signed out elsewhere, or a temporary password: back to the gate.
		if (
			body?.code === "signInRequired" ||
			body?.code === "passwordChangeRequired"
		) {
			signedOut?.();
		}
		// The room is full: the account's usage is out of date.
		if (body?.code === "storageFull") roomChanged?.();
		throw new ApiError(
			body?.error ?? `Request failed (HTTP ${response.status})`,
			typeof body?.code === "string" ? body.code : undefined,
			body?.params ?? undefined,
		);
	}
	// 202 and 204 carry no body.
	return response.status === 200 || response.status === 201
		? response.json()
		: (undefined as T);
}

const send = (method: string, body: unknown): RequestInit => ({
	method,
	headers: { "content-type": "application/json" },
	body: JSON.stringify(body),
});

export const api = {
	models: () => request<ModelSpec[]>("/api/models"),
	providers: () => request<ProviderStatus[]>("/api/providers"),
	setKey: (id: string, key: string) =>
		request<void>(`/api/providers/${id}/key`, send("PUT", { key })),
	/** A key of one's own on a server, used before the server's. */
	setOwnKey: (id: string, key: string) =>
		request<void>(`/api/account/keys/${id}`, send("PUT", { key })),
	deleteOwnKey: (id: string) =>
		request<void>(`/api/account/keys/${id}`, { method: "DELETE" }),
	deleteKey: (id: string) =>
		request<void>(`/api/providers/${id}/key`, { method: "DELETE" }),
	sessions: () => request<Session[]>("/api/sessions"),
	session: (id: string) => request<SessionDetail>(`/api/sessions/${id}`),
	deleteSession: (id: string) =>
		request<void>(`/api/sessions/${id}`, { method: "DELETE" }),
	createTurn: (input: CreateTurnInput) =>
		request<{ session: Session; turn: TurnView }>(
			"/api/turns",
			send("POST", input),
		),
	improvePrompt: (
		input: {
			prompt: string;
			modelIds: string[];
			editing: boolean;
			language: string;
		},
		signal: AbortSignal,
	) =>
		request<{ prompt: string }>("/api/prompts/improve", {
			...send("POST", input),
			signal,
		}),
	assistant: () => request<{ brain: AssistantBrain }>("/api/assistant"),
	assistantView: (sessionId: string) =>
		request<AssistantView>(`/api/sessions/${sessionId}/assistant`),
	sendToAssistant: (input: {
		sessionId?: string;
		text: string;
		language: string;
	}) =>
		request<{ sessionId: string }>(
			"/api/assistant/messages",
			send("POST", input),
		),
	stopAssistant: (sessionId: string) =>
		request<void>(
			`/api/sessions/${sessionId}/assistant/stop`,
			send("POST", {}),
		),
	answerAssistant: (
		sessionId: string,
		input: { entryId: string; approve: boolean; language: string },
	) =>
		request<void>(
			`/api/sessions/${sessionId}/assistant/answers`,
			send("POST", input),
		),
	cancelJob: (id: string) =>
		request<void>(`/api/jobs/${id}/cancel`, { method: "POST" }),
	/** Whether this is a personal install or a server reached over the network. */
	server: () => request<ServerInfo>("/api/server"),
	setupNeeded: () => request<{ needed: boolean }>("/api/setup"),
	setup: (input: { code: string; username: string; password: string }) =>
		request<AccountView>("/api/setup", send("POST", input)),
	login: (input: { username: string; password: string; totp?: string }) =>
		request<AccountView>("/api/login", send("POST", input)),
	logout: () => request<void>("/api/logout", { method: "POST" }),
	account: () => request<AccountView>("/api/account"),
	dismissResetNotice: () =>
		request<void>("/api/account/reset-notice", { method: "DELETE" }),
	changePassword: (input: { current: string; next: string }) =>
		request<void>("/api/account/password", send("PUT", input)),
	accountSessions: () => request<AuthSessionView[]>("/api/account/sessions"),
	revokeSession: (id: string) =>
		request<void>(`/api/account/sessions/${id}`, { method: "DELETE" }),
	/** Signs out every other browser; with `tokens`, ends API tokens too. */
	revokeOtherSessions: (tokens: boolean) =>
		request<void>(`/api/account/sessions${tokens ? "?tokens=true" : ""}`, {
			method: "DELETE",
		}),
	/** The person's API tokens, for agents and programs. */
	tokens: () => request<ApiTokenView[]>("/api/account/tokens"),
	/** A new token: the answer is the only time it is shown. */
	createToken: (input: {
		/** Shows it is the person: a stolen session alone cannot make one. */
		password: string;
		code?: string;
		name: string;
		scopes: TokenScope[];
		spendLimitUsd: number | null;
		expiresInDays: TokenExpiryDays;
	}) =>
		request<ApiTokenView & { token: string }>(
			"/api/account/tokens",
			send("POST", input),
		),
	revokeToken: (id: string) =>
		request<void>(`/api/account/tokens/${id}`, { method: "DELETE" }),
	/** Another person's tokens, for those who manage them. */
	userTokens: (userId: string) =>
		request<ApiTokenView[]>(`/api/users/${userId}/tokens`),
	revokeUserToken: (userId: string, id: string) =>
		request<void>(`/api/users/${userId}/tokens/${id}`, { method: "DELETE" }),
	startTotp: () =>
		request<{ secret: string; uri: string }>("/api/account/totp", {
			method: "POST",
		}),
	enableTotp: (input: {
		secret: string;
		code: string;
		password: string;
		current?: string;
	}) => request<void>("/api/account/totp", send("PUT", input)),
	disableTotp: (input: { password: string; code?: string }) =>
		request<void>("/api/account/totp", send("DELETE", input)),
	invite: (token: string) =>
		request<{ role: UserRole; expiresAt: number }>(`/api/invites/${token}`),
	acceptInvite: (
		token: string,
		input: { username: string; password: string },
	) =>
		request<AccountView>(`/api/invites/${token}/accept`, send("POST", input)),
	invites: () => request<InviteView[]>("/api/invites"),
	createInvite: (terms: InviteTerms) =>
		request<{ token: string; invite: InviteView }>(
			"/api/invites",
			send("POST", terms),
		),
	deleteInvite: (id: string) =>
		request<void>(`/api/invites/${id}`, { method: "DELETE" }),
	users: () => request<AccountView[]>("/api/users"),
	updateUser: (
		id: string,
		change: Partial<InviteTerms> & { disabled?: boolean },
	) => request<AccountView>(`/api/users/${id}`, send("PATCH", change)),
	/** A link for the person to choose a new password. */
	resetPassword: (id: string) =>
		request<{ token: string; expiresAt: number }>(`/api/users/${id}/password`, {
			method: "POST",
		}),
	passwordReset: (token: string) =>
		request<{ username: string }>(`/api/password-resets/${token}`),
	setPasswordFromLink: (token: string, password: string) =>
		request<void>(`/api/password-resets/${token}`, send("POST", { password })),
	agents: () => request<AgentsStatus>("/api/agents"),
	connectClaudeDesktop: (policy: AgentPolicy) =>
		request<void>("/api/agents/claude-desktop", send("PUT", policy)),
	disconnectClaudeDesktop: () =>
		request<void>("/api/agents/claude-desktop", { method: "DELETE" }),
	retryJob: (id: string) =>
		request<void>(`/api/jobs/${id}/retry`, { method: "POST" }),
	upload: (file: File) =>
		request<Asset>("/api/assets", {
			method: "POST",
			headers: { "content-type": file.type },
			body: file,
		}),
	/** Whether keys this person relied on could not be read at start. */
	keysLost: () => request<{ lost: boolean }>("/api/keys/lost"),
	dismissKeysLost: () => request<void>("/api/keys/lost", { method: "DELETE" }),
	deleteAsset: (id: string) =>
		request<void>(`/api/assets/${id}`, { method: "DELETE" }),
	localModels: () => request<LocalModelsView>("/api/local-models"),
	installModel: (id: string, variant?: string) =>
		request<void>(
			`/api/local-models/${id}/install`,
			send("POST", variant ? { variant } : {}),
		),
	cancelModel: (id: string) =>
		request<void>(`/api/local-models/${id}/cancel`, { method: "POST" }),
	deleteModel: (id: string) =>
		request<void>(`/api/local-models/${id}`, { method: "DELETE" }),
	checkpoints: () => request<CheckpointInfo[]>("/api/checkpoints"),
	/** What Hatchlight does with a repository on Hugging Face. */
	openFromHub: (target: HubTarget, signal?: AbortSignal) =>
		request<HubChoice>(
			`/api/hugging-face?${new URLSearchParams({
				repo: target.repo,
				...(target.file && { file: target.file }),
			})}`,
			{ signal },
		),
	/** Downloads a file found on Hugging Face; stopping `signal` stops it. */
	addFromHub: (file: HubFile, signal?: AbortSignal) =>
		request<
			| { kind: "checkpoint"; item: CheckpointInfo }
			| { kind: "lora"; item: LoraInfo }
		>("/api/hugging-face/downloads", {
			...send("POST", {
				repo: file.repo,
				file: file.file,
				revision: file.revision,
			}),
			signal,
		}),
	addCheckpoint: (file: File) =>
		request<CheckpointInfo>(
			`/api/checkpoints?${new URLSearchParams({ name: file.name })}`,
			{
				method: "POST",
				headers: { "content-type": "application/octet-stream" },
				body: file,
			},
		),
	updateCheckpoint: (
		id: string,
		change: Partial<
			Pick<CheckpointInfo, "name" | "steps" | "cfgScale" | "clipSkip">
		>,
	) => request<CheckpointInfo>(`/api/checkpoints/${id}`, send("PATCH", change)),
	deleteCheckpoint: (id: string) =>
		request<void>(`/api/checkpoints/${id}`, { method: "DELETE" }),
	trainer: () => request<TrainerStatus>("/api/trainer"),
	installTrainer: () =>
		request<void>("/api/trainer/install", { method: "POST" }),
	removeTrainer: () => request<void>("/api/trainer", { method: "DELETE" }),
	cancelTrainerInstall: () =>
		request<void>("/api/trainer/install/cancel", { method: "POST" }),
	train: (input: {
		name: string;
		trigger: string;
		steps: number;
		pictures: { assetId: string; caption: string }[];
		consent: boolean;
	}) => request<TrainingView>("/api/trainings", send("POST", input)),
	cancelTraining: () =>
		request<void>("/api/trainings/cancel", { method: "POST" }),
	finishTraining: () =>
		request<void>("/api/trainings/finish", { method: "POST" }),
	captioner: () => request<{ ready: boolean }>("/api/captioner"),
	caption: (assetId: string, signal: AbortSignal) =>
		request<{ caption: string }>("/api/captions", {
			...send("POST", { assetId }),
			signal,
		}),
	loras: () => request<LoraInfo[]>("/api/loras"),
	addLora: (file: File) =>
		request<LoraInfo>(
			`/api/loras?${new URLSearchParams({ name: file.name })}`,
			{
				method: "POST",
				headers: { "content-type": "application/octet-stream" },
				body: file,
			},
		),
	deleteLora: (id: string) =>
		request<void>(`/api/loras/${id}`, { method: "DELETE" }),
	modelFolders: () => request<ModelFolder[]>("/api/model-folders"),
	modelFolderSuggestions: () =>
		request<ModelFolderSuggestion[]>("/api/model-folders/suggestions"),
	addModelFolder: (path: string) =>
		request<ModelFolder>("/api/model-folders", send("POST", { path })),
	rescanModelFolders: () =>
		request<ModelFolder[]>("/api/model-folders/rescan", { method: "POST" }),
	removeModelFolder: (id: string) =>
		request<void>(`/api/model-folders/${id}`, { method: "DELETE" }),
	settings: () => request<Settings>("/api/settings"),
	saveSettings: (change: Partial<Settings>) =>
		request<Settings>("/api/settings", send("PUT", change)),
	moveModels: (path: string) =>
		request<void>("/api/local-models/location", send("POST", { path })),
	gallery: (query: string, before?: GalleryItem) => {
		const search = new URLSearchParams({ limit: String(GALLERY_PAGE) });
		if (query) search.set("query", query);
		if (before) {
			search.set("before", String(before.createdAt));
			search.set("beforeId", before.id);
		}
		return request<GalleryItem[]>(`/api/gallery?${search}`);
	},
};

export const GALLERY_PAGE = 60;
export const assetUrl = (id: string) => `/api/assets/${id}`;
/** A picture a training made along the way, at a step. */
export const sampleUrl = (trainingId: string, step: number) =>
	`/api/trainings/${trainingId}/samples/${step}`;
/** A running job's latest picture; `version` changes the address per picture. */
export const previewUrl = (jobId: string, version: number) =>
	`/api/jobs/${jobId}/preview?v=${version}`;
/**
 * A model's demo. Pictures come smaller than their authors made them: a card
 * asks for "card", an enlarged view for "large". Videos ignore the size.
 */
export const demoUrl = (
	modelId: string,
	index: number,
	size: "card" | "large" = "card",
) => `/api/local-models/${modelId}/demos/${index}?size=${size}`;
