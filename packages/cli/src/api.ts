import type {
	HubChoice,
	HubFile,
	HubTarget,
} from "@hatchlight/core/hugging-face";
import type {
	AssistantView,
	CheckpointInfo,
	LocalModelsView,
	LoraInfo,
	ModelFolder,
	TrainerStatus,
	TrainingView,
} from "@hatchlight/core/types";
import { HatchlightClient } from "@hatchlight/mcp";

/** A picture to train on, by id, and the words that describe it. */
export interface TrainingPicture {
	assetId: string;
	caption?: string;
}

export interface TrainingInput {
	name: string;
	trigger: string;
	steps: number;
	pictures: TrainingPicture[];
	/** The person said the pictures are theirs to use, and anyone in them agreed. */
	consent: true;
}

/**
 * Everything a person at a terminal can do with Hatchlight: what agents
 * can, and what only the person may, such as installing models and setting
 * keys.
 */
export class Api extends HatchlightClient {
	private send = <T = void>(method: string, path: string, body?: unknown) =>
		this.request<T>(path, {
			method,
			...(body !== undefined && {
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			}),
		});

	setKey = (provider: string, key: string) =>
		this.send("PUT", `/api/providers/${encodeURIComponent(provider)}/key`, {
			key,
		});
	removeKey = (provider: string) =>
		this.send("DELETE", `/api/providers/${encodeURIComponent(provider)}/key`);

	localModels = () => this.request<LocalModelsView>("/api/local-models");
	install = (id: string, variant?: string) =>
		this.send(
			"POST",
			`/api/local-models/${encodeURIComponent(id)}/install`,
			variant ? { variant } : {},
		);
	cancelInstall = (id: string) =>
		this.send("POST", `/api/local-models/${encodeURIComponent(id)}/cancel`);
	uninstall = (id: string) =>
		this.send("DELETE", `/api/local-models/${encodeURIComponent(id)}`);

	loras = () => this.request<LoraInfo[]>("/api/loras");
	addLora = (name: string, data: Uint8Array) =>
		this.request<LoraInfo>(`/api/loras?${new URLSearchParams({ name })}`, {
			method: "POST",
			body: data,
		});
	removeLora = (id: string) =>
		this.send("DELETE", `/api/loras/${encodeURIComponent(id)}`);
	checkpoints = () => this.request<CheckpointInfo[]>("/api/checkpoints");

	/** What Hatchlight does with a repository on Hugging Face. */
	openFromHub = (target: HubTarget) =>
		this.request<HubChoice>(
			`/api/hugging-face?${new URLSearchParams({
				repo: target.repo,
				...(target.file && { file: target.file }),
			})}`,
		);
	/** Downloads a file found on Hugging Face; stopping `signal` stops it. */
	addFromHub = (file: HubFile, signal?: AbortSignal) =>
		this.request<
			| { kind: "checkpoint"; item: CheckpointInfo }
			| { kind: "lora"; item: LoraInfo }
		>("/api/hugging-face/downloads", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				repo: file.repo,
				file: file.file,
				revision: file.revision,
			}),
			signal,
		});

	modelFolders = () => this.request<ModelFolder[]>("/api/model-folders");
	addModelFolder = (path: string) =>
		this.send<ModelFolder>("POST", "/api/model-folders", { path });
	removeModelFolder = (id: string) =>
		this.send("DELETE", `/api/model-folders/${encodeURIComponent(id)}`);
	rescanModelFolders = () =>
		this.send<ModelFolder[]>("POST", "/api/model-folders/rescan");

	trainer = () => this.request<TrainerStatus>("/api/trainer");
	installTrainer = () => this.send("POST", "/api/trainer/install");
	cancelTrainerInstall = () => this.send("POST", "/api/trainer/install/cancel");
	removeTrainer = () => this.send("DELETE", "/api/trainer");
	train = (input: TrainingInput) =>
		this.send<TrainingView>("POST", "/api/trainings", input);
	stopTraining = () => this.send("POST", "/api/trainings/cancel");
	finishTraining = () => this.send("POST", "/api/trainings/finish");
	/** A picture a training made at a step, to see whether it is learning. */
	async trainingSample(id: string, step: number): Promise<Uint8Array> {
		const response = await this.fetch(
			`${this.baseUrl}/api/trainings/${encodeURIComponent(id)}/samples/${step}`,
		);
		if (!response.ok) throw new Error(`No sample at step ${step}`);
		return new Uint8Array(await response.arrayBuffer());
	}

	captionerReady = async () =>
		(await this.request<{ ready: boolean }>("/api/captioner")).ready;
	caption = async (assetId: string) =>
		(
			await this.send<{ caption: string }>("POST", "/api/captions", {
				assetId,
			})
		).caption;

	/** What the assistant thinks with, or null when nothing can. */
	assistantBrain = async () =>
		(await this.request<{ brain: string | null }>("/api/assistant")).brain;
	tellAssistant = (text: string, sessionId?: string) =>
		this.send<{ sessionId: string }>("POST", "/api/assistant/messages", {
			text,
			...(sessionId && { sessionId }),
		});
	conversation = (sessionId: string) =>
		this.request<AssistantView>(
			`/api/sessions/${encodeURIComponent(sessionId)}/assistant`,
		);
	answerAssistant = (sessionId: string, entryId: string, approve: boolean) =>
		this.send(
			"POST",
			`/api/sessions/${encodeURIComponent(sessionId)}/assistant/answers`,
			{ entryId, approve },
		);
	stopAssistant = (sessionId: string) =>
		this.send(
			"POST",
			`/api/sessions/${encodeURIComponent(sessionId)}/assistant/stop`,
		);
}
