import type {
	Asset,
	CreateTurnInput,
	EngineEvent,
	GalleryItem,
	ModelSpec,
	ProviderStatus,
	Session,
	TurnView,
} from "@hatchlight/core/types";
import type { Reel, SessionDetail } from "@hatchlight/tools";

/** An error the Hatchlight server answered with. */
export class ServerError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly code: string | null,
	) {
		super(message);
	}
}

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** Talks to a running Hatchlight server, over its HTTP API. */
export class HatchlightClient implements Reel {
	constructor(
		readonly baseUrl: string,
		// The global one: inside these parameters, `fetch` names this one.
		private fetch: Fetch = (url, init) => globalThis.fetch(url, init),
	) {}

	private async request<T>(path: string, init?: RequestInit): Promise<T> {
		const response = await this.fetch(`${this.baseUrl}${path}`, init);
		if (!response.ok) {
			const body = (await response.json().catch(() => null)) as {
				error?: string;
				code?: string;
			} | null;
			throw new ServerError(
				body?.error ?? `Hatchlight answered ${response.status}`,
				response.status,
				body?.code ?? null,
			);
		}
		if (response.status === 204) return undefined as T;
		return (await response.json()) as T;
	}

	private post = (path: string) => this.request<void>(path, { method: "POST" });

	models = () => this.request<ModelSpec[]>("/api/models");
	providers = () => this.request<ProviderStatus[]>("/api/providers");
	session = (id: string) =>
		this.request<SessionDetail>(`/api/sessions/${encodeURIComponent(id)}`);

	createTurn = (input: CreateTurnInput) =>
		this.request<{ session: Session; turn: TurnView }>("/api/turns", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(input),
		});

	upload = (data: Uint8Array) =>
		this.request<Asset>("/api/assets", { method: "POST", body: data });

	gallery = (options: { query?: string; limit?: number }) => {
		const search = new URLSearchParams();
		if (options.query) search.set("query", options.query);
		search.set("limit", String(options.limit ?? 20));
		return this.request<GalleryItem[]>(`/api/gallery?${search}`);
	};

	/** An asset's bytes and type. */
	async asset(id: string): Promise<{ data: Uint8Array; mime: string }> {
		const response = await this.fetch(
			`${this.baseUrl}/api/assets/${encodeURIComponent(id)}`,
		);
		if (!response.ok) {
			throw new ServerError(
				`No picture or video with id ${id}`,
				response.status,
				"assetNotFound",
			);
		}
		return {
			data: new Uint8Array(await response.arrayBuffer()),
			mime: response.headers.get("content-type") ?? "application/octet-stream",
		};
	}

	cancelJob = (id: string) =>
		this.post(`/api/jobs/${encodeURIComponent(id)}/cancel`);
	retryJob = (id: string) =>
		this.post(`/api/jobs/${encodeURIComponent(id)}/retry`);

	/** How jobs move, as the server tells it, until `signal` stops it. */
	async *events(signal: AbortSignal): AsyncGenerator<EngineEvent> {
		const response = await this.fetch(`${this.baseUrl}/api/events`, {
			signal,
		});
		if (!response.ok || !response.body) return;
		let buffer = "";
		try {
			for await (const chunk of response.body.pipeThrough(
				new TextDecoderStream(),
			)) {
				// Over the whole buffer: a "\r\n" may come cut in two.
				buffer = (buffer + chunk).replaceAll("\r\n", "\n");
				for (;;) {
					const end = buffer.indexOf("\n\n");
					if (end < 0) break;
					const block = buffer.slice(0, end);
					buffer = buffer.slice(end + 2);
					const data = block
						.split("\n")
						.filter((line) => line.startsWith("data:"))
						.map((line) => line.slice(5).trimStart())
						.join("\n");
					if (!data) continue;
					const event = JSON.parse(data) as { type?: string };
					if (event.type?.startsWith("job.")) yield event as EngineEvent;
				}
			}
		} catch (error) {
			if (!signal.aborted) throw error;
		}
	}

	/** Where a person can see a session in the app. */
	sessionUrl = (id: string) => `${this.baseUrl}/#/s/${encodeURIComponent(id)}`;
}
