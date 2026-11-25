import type { TokenScope } from "@hatchlight/core";

/**
 * Who may call a route on a server:
 *
 * - `public`: anyone who reaches it, signed in or not;
 * - `account`: a signed-in person in a browser, about their own account,
 *   even before they changed a temporary password;
 * - `member`: any signed-in person or API token, on their own sessions,
 *   pictures and assistant, and making pictures with what is installed;
 * - `train`: a member allowed to train LoRAs and add them;
 * - `admin`: admins and owners: installing models, and people;
 * - `owner`: owners only: the server's own settings and software, such as
 *   its keys and the trainer.
 *
 * A personal install has one person, who may do everything.
 */
export type Access =
	| "public"
	| "account"
	| "member"
	| "train"
	| "admin"
	| "owner";

/** Every API route, as `METHOD /path` with Hono's route pattern. */
export const ROUTE_ACCESS: Readonly<Record<string, Access>> = {
	"GET /api/health": "public",
	"GET /api/server": "public",
	"GET /api/setup": "public",
	"POST /api/setup": "public",
	"POST /api/login": "public",
	"GET /api/invites/:token": "public",
	"POST /api/invites/:token/accept": "public",
	"GET /api/password-resets/:token": "public",
	"POST /api/password-resets/:token": "public",

	// One's own account.
	"POST /api/logout": "account",
	"GET /api/account": "account",
	"DELETE /api/account/reset-notice": "account",
	"PUT /api/account/keys/:id": "account",
	"GET /api/keys/lost": "account",
	"DELETE /api/keys/lost": "account",
	"DELETE /api/account/keys/:id": "account",
	"PUT /api/account/password": "account",
	"GET /api/account/sessions": "account",
	"DELETE /api/account/sessions": "account",
	"DELETE /api/account/sessions/:id": "account",
	"POST /api/account/totp": "account",
	"PUT /api/account/totp": "account",
	"DELETE /api/account/totp": "account",
	"GET /api/account/tokens": "account",
	"POST /api/account/tokens": "account",
	"DELETE /api/account/tokens/:id": "account",

	// Making pictures, and a person's own sessions, gallery and assistant.
	"GET /api/models": "member",
	"GET /api/providers": "member",
	"GET /api/sessions": "member",
	"GET /api/sessions/:id": "member",
	"DELETE /api/sessions/:id": "member",
	"POST /api/turns": "member",
	"GET /api/jobs/:id/preview": "member",
	"POST /api/jobs/:id/cancel": "member",
	"POST /api/jobs/:id/retry": "member",
	"POST /api/assets": "member",
	"GET /api/assets/:id": "member",
	"DELETE /api/assets/:id": "member",
	"GET /api/gallery": "member",
	"POST /api/prompts/improve": "member",
	"GET /api/assistant": "member",
	"POST /api/assistant/messages": "member",
	"GET /api/sessions/:id/assistant": "member",
	"POST /api/sessions/:id/assistant/stop": "member",
	"POST /api/sessions/:id/assistant/answers": "member",
	"GET /api/events": "member",
	// A person's own choices, such as how to translate.
	"GET /api/settings": "member",
	"PUT /api/settings": "member",
	// Seeing what is installed, to choose from it.
	"GET /api/local-models": "member",
	"GET /api/local-models/:id/demos/:index": "member",
	"GET /api/loras": "member",
	"GET /api/checkpoints": "member",
	"GET /api/model-folders": "member",
	"GET /api/trainer": "member",
	"GET /api/captioner": "member",

	// Training holds the GPU for long and adds a LoRA everyone sees.
	"POST /api/loras": "train",
	"POST /api/trainings": "train",
	"POST /api/trainings/cancel": "train",
	"POST /api/trainings/finish": "train",
	"GET /api/trainings/:id/samples/:step": "train",
	"POST /api/captions": "train",

	// What is installed is shared by everyone.
	"POST /api/local-models/:id/install": "admin",
	"POST /api/local-models/:id/cancel": "admin",
	"DELETE /api/local-models/:id": "admin",
	"DELETE /api/loras/:id": "admin",
	"POST /api/checkpoints": "admin",
	"PATCH /api/checkpoints/:id": "admin",
	"DELETE /api/checkpoints/:id": "admin",
	// Looking a repository up and downloading from it, for what it installs.
	"GET /api/hugging-face": "admin",
	"POST /api/hugging-face/downloads": "admin",
	// Other apps' folders on the machine: where to look is the admins' call.
	"GET /api/model-folders/suggestions": "admin",
	"POST /api/model-folders": "admin",
	"POST /api/model-folders/rescan": "admin",
	"DELETE /api/model-folders/:id": "admin",
	// The people of the server.
	"GET /api/users": "admin",
	"PATCH /api/users/:id": "admin",
	"POST /api/users/:id/password": "admin",
	"GET /api/users/:id/tokens": "admin",
	"DELETE /api/users/:id/tokens/:token": "admin",
	"GET /api/invites": "admin",
	"POST /api/invites": "admin",
	"DELETE /api/invites/:id": "admin",

	// The server's own settings. Keys spend the owner's money.
	"PUT /api/providers/:id/key": "owner",
	"DELETE /api/providers/:id/key": "owner",
	// Agents are set up on the machine that runs the server.
	"GET /api/agents": "owner",
	"PUT /api/agents/claude-desktop": "owner",
	"DELETE /api/agents/claude-desktop": "owner",
	"POST /api/local-models/location": "owner",
	// The trainer is software installed on the machine.
	"POST /api/trainer/install": "owner",
	"POST /api/trainer/install/cancel": "owner",
	"DELETE /api/trainer": "owner",
};

/**
 * What an API token needs in its scopes to call a route, for the routes a
 * token may call at all (`member` and `train`). A route left out, such as
 * a person's own choices, is for browsers only. `paid` is not a route's: it
 * is checked where money is spent.
 */
export const ROUTE_SCOPE: Readonly<Record<string, TokenScope>> = {
	"GET /api/models": "read",
	"GET /api/providers": "read",
	"GET /api/sessions": "read",
	"GET /api/sessions/:id": "read",
	"GET /api/jobs/:id/preview": "read",
	"GET /api/assets/:id": "read",
	"GET /api/gallery": "read",
	"GET /api/assistant": "read",
	"GET /api/sessions/:id/assistant": "read",
	"GET /api/events": "read",
	"GET /api/settings": "read",
	"GET /api/local-models": "read",
	"GET /api/local-models/:id/demos/:index": "read",
	"GET /api/loras": "read",
	"GET /api/checkpoints": "read",
	"GET /api/model-folders": "read",
	"GET /api/trainer": "read",
	"GET /api/captioner": "read",

	"DELETE /api/sessions/:id": "generate",
	"POST /api/turns": "generate",
	"POST /api/jobs/:id/cancel": "generate",
	"POST /api/jobs/:id/retry": "generate",
	"POST /api/assets": "generate",
	"DELETE /api/assets/:id": "generate",
	"POST /api/prompts/improve": "generate",
	"POST /api/assistant/messages": "generate",
	"POST /api/sessions/:id/assistant/stop": "generate",
	"POST /api/sessions/:id/assistant/answers": "generate",

	"POST /api/loras": "train",
	"POST /api/trainings": "train",
	"POST /api/trainings/cancel": "train",
	"POST /api/trainings/finish": "train",
	"GET /api/trainings/:id/samples/:step": "train",
	"POST /api/captions": "train",
};

/** The scope a token needs for a route, or null when no token may call it. */
export function routeScope(
	method: string,
	routePath: string,
): TokenScope | null {
	return ROUTE_SCOPE[`${method.toUpperCase()} ${routePath}`] ?? null;
}

/**
 * The access a route needs, by its method and Hono route pattern
 * (`c.req.routePath`). Undeclared routes are for the owner only.
 */
export function routeAccess(method: string, routePath: string): Access {
	return ROUTE_ACCESS[`${method.toUpperCase()} ${routePath}`] ?? "owner";
}

/**
 * What a public demo lets in, by route:
 *
 * - `public`: anyone, as no visitor;
 * - `visitor`: a visitor made by POST /api/visitor, named by their token, on
 *   their own sessions and pictures, and making pictures with the model
 *   installed for the demo;
 * - `refused`: nobody. Accounts, installing, training, keys, agents,
 *   uploads, and anything that uses a language model.
 *
 * Every route of ROUTE_ACCESS is named here, with the one route only a
 * demo has, so a new one is decided on, not let in by accident; one
 * missing, or not a route at all, is refused.
 */
export type DemoAccess = "public" | "visitor" | "refused";

export const DEMO_ACCESS: Readonly<Record<string, DemoAccess>> = {
	"GET /api/health": "public",
	"GET /api/server": "public",
	// The only way a visitor is made: on purpose, once, by the page.
	"POST /api/visitor": "public",

	"GET /api/models": "visitor",
	"GET /api/providers": "visitor",
	"GET /api/sessions": "visitor",
	"GET /api/sessions/:id": "visitor",
	"DELETE /api/sessions/:id": "visitor",
	"POST /api/turns": "visitor",
	"GET /api/jobs/:id/preview": "visitor",
	"POST /api/jobs/:id/cancel": "visitor",
	"POST /api/jobs/:id/retry": "visitor",
	"GET /api/assets/:id": "visitor",
	"DELETE /api/assets/:id": "visitor",
	"GET /api/gallery": "visitor",
	"GET /api/events": "visitor",
	// Read only: a visitor's choices would be kept for good, and they have none.
	"GET /api/settings": "visitor",
	"GET /api/local-models": "visitor",
	"GET /api/local-models/:id/demos/:index": "visitor",

	// Anything a stranger could upload would be kept and served from here.
	"POST /api/assets": "refused",
	// Language models: kept out to keep the demo small.
	"POST /api/prompts/improve": "refused",
	"GET /api/assistant": "refused",
	"POST /api/assistant/messages": "refused",
	"GET /api/sessions/:id/assistant": "refused",
	"POST /api/sessions/:id/assistant/stop": "refused",
	"POST /api/sessions/:id/assistant/answers": "refused",
	"PUT /api/settings": "refused",

	// No accounts: nobody signs in, sets up or is invited.
	"GET /api/setup": "refused",
	"POST /api/setup": "refused",
	"POST /api/login": "refused",
	"GET /api/invites/:token": "refused",
	"POST /api/invites/:token/accept": "refused",
	"GET /api/password-resets/:token": "refused",
	"POST /api/password-resets/:token": "refused",
	"POST /api/logout": "refused",
	"GET /api/account": "refused",
	"DELETE /api/account/reset-notice": "refused",
	"PUT /api/account/keys/:id": "refused",
	"GET /api/keys/lost": "refused",
	"DELETE /api/keys/lost": "refused",
	"DELETE /api/account/keys/:id": "refused",
	"PUT /api/account/password": "refused",
	"GET /api/account/sessions": "refused",
	"DELETE /api/account/sessions": "refused",
	"DELETE /api/account/sessions/:id": "refused",
	"POST /api/account/totp": "refused",
	"PUT /api/account/totp": "refused",
	"DELETE /api/account/totp": "refused",
	"GET /api/account/tokens": "refused",
	"POST /api/account/tokens": "refused",
	"DELETE /api/account/tokens/:id": "refused",
	"GET /api/users": "refused",
	"PATCH /api/users/:id": "refused",
	"POST /api/users/:id/password": "refused",
	"GET /api/users/:id/tokens": "refused",
	"DELETE /api/users/:id/tokens/:token": "refused",
	"GET /api/invites": "refused",
	"POST /api/invites": "refused",
	"DELETE /api/invites/:id": "refused",

	// What is installed is the demo's, set up at start.
	"GET /api/loras": "refused",
	"GET /api/checkpoints": "refused",
	"POST /api/loras": "refused",
	"DELETE /api/loras/:id": "refused",
	"POST /api/local-models/:id/install": "refused",
	"POST /api/local-models/:id/cancel": "refused",
	"DELETE /api/local-models/:id": "refused",
	"POST /api/local-models/location": "refused",
	"POST /api/checkpoints": "refused",
	"PATCH /api/checkpoints/:id": "refused",
	"DELETE /api/checkpoints/:id": "refused",
	"GET /api/hugging-face": "refused",
	"POST /api/hugging-face/downloads": "refused",

	// Training and captions hold the GPU for long.
	"GET /api/trainer": "refused",
	"GET /api/captioner": "refused",
	// Folders of other apps on the server's disk: their paths are its own.
	"GET /api/model-folders": "refused",
	"GET /api/model-folders/suggestions": "refused",
	"POST /api/model-folders": "refused",
	"POST /api/model-folders/rescan": "refused",
	"DELETE /api/model-folders/:id": "refused",
	"POST /api/trainings": "refused",
	"POST /api/trainings/cancel": "refused",
	"POST /api/trainings/finish": "refused",
	"GET /api/trainings/:id/samples/:step": "refused",
	"POST /api/captions": "refused",
	"POST /api/trainer/install": "refused",
	"POST /api/trainer/install/cancel": "refused",
	"DELETE /api/trainer": "refused",

	// Keys spend money; agents are set up on the machine.
	"PUT /api/providers/:id/key": "refused",
	"DELETE /api/providers/:id/key": "refused",
	"GET /api/agents": "refused",
	"PUT /api/agents/claude-desktop": "refused",
	"DELETE /api/agents/claude-desktop": "refused",
};

/** What a demo lets in for a route; anything not named is refused. */
export function demoAccess(method: string, routePath: string): DemoAccess {
	return DEMO_ACCESS[`${method.toUpperCase()} ${routePath}`] ?? "refused";
}
