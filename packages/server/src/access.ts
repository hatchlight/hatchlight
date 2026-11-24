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
	"DELETE /api/account/keys/:id": "account",
	"PUT /api/account/password": "account",
	"GET /api/account/sessions": "account",
	"DELETE /api/account/sessions": "account",
	"DELETE /api/account/sessions/:id": "account",
	"POST /api/account/totp": "account",
	"PUT /api/account/totp": "account",
	"DELETE /api/account/totp": "account",

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
	// The people of the server.
	"GET /api/users": "admin",
	"PATCH /api/users/:id": "admin",
	"POST /api/users/:id/password": "admin",
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
 * The access a route needs, by its method and Hono route pattern
 * (`c.req.routePath`). Undeclared routes are for the owner only.
 */
export function routeAccess(method: string, routePath: string): Access {
	return ROUTE_ACCESS[`${method.toUpperCase()} ${routePath}`] ?? "owner";
}
