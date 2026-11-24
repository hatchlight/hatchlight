import type {
	EngineEvent,
	JobView,
	LocalModelEvent,
	TrainerEvent,
} from "@hatchlight/core/types";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useEffect, useSyncExternalStore } from "react";
import type { SessionDetail } from "./api";

// Latest progress message per running job. Kept outside the query cache
// because it changes often and is never fetched.
export type JobProgress = Omit<
	Extract<EngineEvent, { type: "job.progress" }>,
	"type" | "jobId"
>;
const progress = new Map<string, JobProgress>();
const watchers = new Set<() => void>();
const notify = () => {
	for (const watcher of watchers) watcher();
};

export function useProgress(jobId: string): JobProgress | undefined {
	return useSyncExternalStore(
		(watcher) => {
			watchers.add(watcher);
			return () => watchers.delete(watcher);
		},
		() => progress.get(jobId),
	);
}

type ModelProgress = Extract<LocalModelEvent, { type: "model.progress" }>;
// Latest progress per model being installed, for the same reason.
const modelProgress = new Map<string, ModelProgress>();

export function useModelProgress(modelId: string): ModelProgress | undefined {
	return useSyncExternalStore(
		(watcher) => {
			watchers.add(watcher);
			return () => watchers.delete(watcher);
		},
		() => modelProgress.get(modelId),
	);
}

type FolderMove = Omit<
	Extract<LocalModelEvent, { type: "models.moving" }>,
	"type"
>;
// How far the models are in moving to another folder, while they move.
let folderMove: FolderMove | null = null;

export function useFolderMove(): FolderMove | null {
	return useSyncExternalStore(
		(watcher) => {
			watchers.add(watcher);
			return () => watchers.delete(watcher);
		},
		() => folderMove,
	);
}

async function applyJob(client: QueryClient, job: JobView): Promise<void> {
	// A fetch already in flight may carry an older state of this job and would
	// overwrite the update when it lands.
	await client.cancelQueries({ queryKey: ["session"] });
	let found = false;
	client.setQueriesData<SessionDetail>({ queryKey: ["session"] }, (session) => {
		if (!session?.turns.some((t) => t.jobs.some((j) => j.id === job.id))) {
			return session;
		}
		found = true;
		return {
			...session,
			turns: session.turns.map((turn) => ({
				...turn,
				jobs: turn.jobs.map((j) => (j.id === job.id ? job : j)),
			})),
		};
	});
	// The turn may not be in the cache yet (its request is still in flight).
	if (!found) void client.invalidateQueries({ queryKey: ["session"] });
	if (job.status === "succeeded") {
		void client.invalidateQueries({ queryKey: ["gallery"] });
	}
}

/** Keeps cached sessions in step with the server's job events. */
export function useLiveJobs(): void {
	const client = useQueryClient();
	useEffect(() => {
		const source = new EventSource("/api/events");
		let order: Promise<void> = Promise.resolve();
		let connectedBefore = false;
		source.addEventListener("ready", () => {
			// After a reconnect, events may have been missed.
			if (connectedBefore) {
				void client.invalidateQueries({ queryKey: ["session"] });
				void client.invalidateQueries({ queryKey: ["assistant"] });
				void client.invalidateQueries({ queryKey: ["local-models"] });
				void client.invalidateQueries({ queryKey: ["loras"] });
				void client.invalidateQueries({ queryKey: ["trainer"] });
			}
			connectedBefore = true;
		});
		source.addEventListener("models.moving", (message) => {
			const event = JSON.parse(message.data) as LocalModelEvent;
			if (event.type !== "models.moving") return;
			const { type: _, ...move } = event;
			folderMove = move;
			notify();
		});
		source.addEventListener("models.changed", () => {
			// An install started or ended, or a move to another folder did;
			// what was known about it is stale.
			modelProgress.clear();
			folderMove = null;
			notify();
			void client.invalidateQueries({ queryKey: ["local-models"] });
			// Installed models can be picked in the composer.
			void client.invalidateQueries({ queryKey: ["models"] });
			void client.invalidateQueries({ queryKey: ["checkpoints"] });
			// The model that captions training pictures may have come or gone.
			void client.invalidateQueries({ queryKey: ["captioner"] });
		});
		source.addEventListener("trainer.changed", (message) => {
			const event = JSON.parse(message.data) as TrainerEvent;
			client.setQueryData(["trainer"], event.trainer);
			// A finished training put a LoRA on the shelf.
			if (event.trainer.training?.state === "done") {
				void client.invalidateQueries({ queryKey: ["loras"] });
			}
		});
		source.addEventListener("loras.changed", () => {
			void client.invalidateQueries({ queryKey: ["loras"] });
		});
		source.addEventListener("model.progress", (message) => {
			const event = JSON.parse(message.data) as LocalModelEvent;
			if (event.type !== "model.progress") return;
			modelProgress.set(event.id, event);
			notify();
		});
		source.addEventListener("job.updated", (message) => {
			const event = JSON.parse(message.data) as EngineEvent;
			if (event.type !== "job.updated") return;
			// A job that starts leaves its place in the line behind.
			if (
				event.job.status !== "running" ||
				progress.get(event.job.id)?.stage === "queued"
			)
				progress.delete(event.job.id);
			order = order.then(() => applyJob(client, event.job));
			notify();
		});
		source.addEventListener("assistant.changed", (message) => {
			const { sessionId } = JSON.parse(message.data) as { sessionId: string };
			void client.invalidateQueries({ queryKey: ["assistant", sessionId] });
			// A turn the assistant made shows up in the session.
			void client.invalidateQueries({ queryKey: ["session", sessionId] });
		});
		source.addEventListener("job.progress", (message) => {
			const event = JSON.parse(message.data) as EngineEvent;
			if (event.type !== "job.progress") return;
			const { type: _, jobId, ...update } = event;
			// Keep what an update leaves out, e.g. the stage when only the fraction moves.
			progress.set(jobId, { ...progress.get(jobId), ...update });
			notify();
		});
		return () => source.close();
	}, [client]);
}
