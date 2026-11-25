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
