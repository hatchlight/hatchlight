import type { ErrorCode, ErrorParams, Retry } from "./errors";
import type { GenerationParams, ModelSpec, ProgressStage } from "./types";

export interface ReferenceImage {
	data: Uint8Array;
	mime: string;
}

export interface ProviderRequest {
	model: ModelSpec;
	params: GenerationParams;
	references: ReferenceImage[];
	/** What of the first reference to redraw, when the person marked it. */
	mask?: ReferenceImage;
	/** The picture `params.guide` names, for a model that follows a guide. */
	guide?: ReferenceImage;
}

export interface ProviderContext {
	apiKey: string | undefined;
	signal: AbortSignal;
}

export type ProviderOutput =
	/** `headers` are sent when downloading, for results that need the API key. */
	| { url: string; mime?: string; headers?: Record<string, string> }
	| { data: Uint8Array; mime: string };

export type ProviderEvent =
	| {
			type: "progress";
			fraction?: number;
			/** English text; `stage` says the same for the interface to translate. */
			message?: string;
			stage?: ProgressStage;
			/** Place in the provider's queue, when `stage` is "queued". */
			position?: number;
			/** Sampling steps done and in all, when the model reports them. */
			step?: number;
			steps?: number;
			/**
			 * Graphics memory other programs hold, when it leaves too little for
			 * the model: the job still runs, but slowly.
			 */
			busyBytes?: number;
			/** The picture as it stands at this step, when the model shows it. */
			preview?: { data: Uint8Array; mime: string };
	  }
	| { type: "completed"; outputs: ProviderOutput[]; costUsd?: number }
	| {
			type: "failed";
			/** English text, shown when the code is unknown to the interface. */
			error: string;
			/** Set when the provider can say why in a way the interface translates. */
			code?: ErrorCode;
			params?: ErrorParams;
			/** Set when trying the job again may work. */
			retry?: Retry;
	  };

/**
 * One provider of generation models, remote or local.
 *
 * `submit` starts the work and returns a JSON-serializable handle; `events`
 * follows that handle until a `completed` or `failed` event. Providers with no
 * server-side queue return the request itself as the handle and do the work in
 * `events`; they must set `resumable` to false.
 */
export interface ProviderAdapter<Handle = unknown> {
	id: string;
	name: string;
	/** Environment variable read when no key is stored. */
	keyEnv?: string;
	requiresKey: boolean;
	/** Whether `events` can re-attach to a handle after a process restart. */
	resumable: boolean;
	/**
	 * How many of its jobs may run at once, when fewer than the engine's
	 * default. Local models share one GPU, so they run one at a time per line.
	 */
	maxConcurrency?: number;
	/**
	 * Splits the provider's jobs into lines that each run up to
	 * `maxConcurrency` jobs, so a job of one kind does not wait behind jobs of
	 * another. Local pictures and videos are separate lines: each fits beside
	 * the other when the GPU's memory allows.
	 */
	lineOf?(modelId: string): string;
	/** Overrides `resumable` for providers where it depends on the request. */
	isResumable?(handle: Handle): boolean;
	listModels(): ModelSpec[];
	submit(request: ProviderRequest, ctx: ProviderContext): Promise<Handle>;
	events(handle: Handle, ctx: ProviderContext): AsyncIterable<ProviderEvent>;
	cancel?(handle: Handle, ctx: ProviderContext): Promise<void>;
}

export class ProviderRegistry {
	private adapters = new Map<string, ProviderAdapter>();
	private models = new Map<string, ModelSpec>();

	register(adapter: ProviderAdapter): this {
		if (this.adapters.has(adapter.id)) {
			throw new Error(`Provider already registered: ${adapter.id}`);
		}
		this.adapters.set(adapter.id, adapter);
		for (const model of adapter.listModels()) {
			this.models.set(model.id, model);
		}
		return this;
	}

	/** Reads an adapter's models again, for providers whose list changes. */
	refresh(providerId: string): void {
		const adapter = this.adapters.get(providerId);
		if (!adapter) return;
		for (const [id, model] of this.models) {
			if (model.providerId === providerId) this.models.delete(id);
		}
		for (const model of adapter.listModels()) this.models.set(model.id, model);
	}

	adapter(providerId: string): ProviderAdapter | undefined {
		return this.adapters.get(providerId);
	}

	listAdapters(): ProviderAdapter[] {
		return [...this.adapters.values()];
	}

	model(modelId: string): ModelSpec | undefined {
		return this.models.get(modelId);
	}

	listModels(): ModelSpec[] {
		return [...this.models.values()];
	}
}
