import type {
	Asset,
	ConsistencyCheck,
	ConsistencyResult,
	CreateTurnInput,
	GalleryItem,
	ModelSpec,
	ProviderStatus,
	Ranking,
	RankingQuery,
	Session,
	Settings,
	TurnView,
} from "@hatchlight/core/types";

export type SessionDetail = Session & { turns: TurnView[] };

/**
 * What the tools need from Hatchlight. An agent outside reaches it over HTTP;
 * the assistant inside the app reaches it in the same process.
 */
export interface Reel {
	models(): Promise<ModelSpec[]>;
	providers(): Promise<ProviderStatus[]>;
	session(id: string): Promise<SessionDetail>;
	createTurn(
		input: CreateTurnInput,
	): Promise<{ session: Session; turn: TurnView }>;
	upload(data: Uint8Array): Promise<Asset>;
	gallery(options: { query?: string; limit?: number }): Promise<GalleryItem[]>;
	/** An asset's bytes and type. */
	asset(id: string): Promise<{ data: Uint8Array; mime: string }>;
	/** Where a person can see a session in the app. */
	sessionUrl(id: string): string;
	/** How the person's picks rank the models they compared, where known. */
	ranking?(query: RankingQuery): Promise<Ranking>;
	/** The person's choices, such as hiding model names until a pick. */
	settings?(): Promise<Settings>;
	/** Whether a picture shows the same character as pictures of it. */
	checkConsistency?(
		check: ConsistencyCheck,
		signal?: AbortSignal,
	): Promise<ConsistencyResult>;
}
