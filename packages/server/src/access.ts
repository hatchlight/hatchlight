/**
 * Who may call a route once a server has accounts:
 *
 * - `public`: anyone who reaches the server, signed in or not;
 * - `member`: any signed-in person, on their own sessions and pictures;
 * - `owner`: whoever runs the server. Installing, keys, folders and anything
 *   that changes the machine or what everyone shares.
 *
 * A personal install has one person, who is all three.
 */
export type Access = "public" | "member" | "owner";

/** Every API route, as `METHOD /path` with Hono's route pattern. */
export const ROUTE_ACCESS: Readonly<Record<string, Access>> = {
	"GET /api/health": "public",
	"GET /api/server": "public",

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

	// Keys spend the owner's money.
	"PUT /api/providers/:id/key": "owner",
	"DELETE /api/providers/:id/key": "owner",
	// Agents are set up on the machine that runs the server.
	"GET /api/agents": "owner",
	"PUT /api/agents/claude-desktop": "owner",
	"DELETE /api/agents/claude-desktop": "owner",
	// What is installed, and where, is shared by everyone.
	"POST /api/local-models/:id/install": "owner",
	"POST /api/local-models/:id/cancel": "owner",
	"DELETE /api/local-models/:id": "owner",
	"POST /api/local-models/location": "owner",
	"POST /api/loras": "owner",
	"DELETE /api/loras/:id": "owner",
	"POST /api/checkpoints": "owner",
	"PATCH /api/checkpoints/:id": "owner",
	"DELETE /api/checkpoints/:id": "owner",
	// Training installs a trainer, holds the GPU for long, and adds a LoRA
	// everyone sees.
	"POST /api/trainer/install": "owner",
	"POST /api/trainer/install/cancel": "owner",
	"DELETE /api/trainer": "owner",
	"POST /api/trainings": "owner",
	"POST /api/trainings/cancel": "owner",
	"POST /api/trainings/finish": "owner",
	"GET /api/trainings/:id/samples/:step": "owner",
	"POST /api/captions": "owner",
};

/**
 * The access a route needs, by its method and Hono route pattern
 * (`c.req.routePath`). Undeclared routes are for the owner only.
 */
export function routeAccess(method: string, routePath: string): Access {
	return ROUTE_ACCESS[`${method.toUpperCase()} ${routePath}`] ?? "owner";
}
