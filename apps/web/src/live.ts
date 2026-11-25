import type {
	EngineEvent,
	JobView,
	LocalModelEvent,
	TrainerEvent,
} from "@hatchlight/core/types";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useEffect, useSyncExternalStore } from "react";
import { type SessionDetail, visitorHeaders, withVisitor } from "./api";

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

/** A stream of the server's events, as useLiveJobs reads it. */
interface EventStream {
	addEventListener(
		type: string,
		listener: (message: { data: string }) => void,
	): void;
	close(): void;
}

/**
 * The browser's EventSource; for a demo's visitor, the same stream read
 * with fetch, which can name the visitor in a header where the browser
 * keeps no cookie (a frame on another site).
 */
function openEvents(path: string): EventStream {
	if (Object.keys(visitorHeaders()).length > 0) return new FetchEvents(path);
	const source = new EventSource(path);
	return {
		addEventListener: (type, listener) =>
			source.addEventListener(type, (event) =>
				listener(event as MessageEvent<string>),
			),
		close: () => source.close(),
	};
}

/** How long a dropped stream waits before it is opened again. */
const RECONNECT_MS = 3000;

/** Server-sent events over fetch, opened again when they drop. */
class FetchEvents implements EventStream {
	private listeners = new Map<
		string,
		Set<(message: { data: string }) => void>
	>();
	private controller = new AbortController();

	constructor(private path: string) {
		void this.run();
	}

	addEventListener(
		type: string,
		listener: (message: { data: string }) => void,
	) {
		const set = this.listeners.get(type) ?? new Set();
		set.add(listener);
		this.listeners.set(type, set);
	}

	close() {
		this.controller.abort();
	}

	private async run() {
		const { signal } = this.controller;
		while (!signal.aborted) {
			try {
				const response = await withVisitor(this.path, {
					signal,
					headers: { accept: "text/event-stream" },
				});
				if (response.ok && response.body) await this.read(response.body);
			} catch {
				// Dropped or refused: tried again below, unless closed.
			}
			if (signal.aborted) return;
			await new Promise((resolve) => setTimeout(resolve, RECONNECT_MS));
		}
	}

	private async read(body: ReadableStream<Uint8Array>) {
		const reader = body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		for (;;) {
			const { value, done } = await reader.read();
			if (done) return;
			const { events, rest } = parseEvents(
				buffer + decoder.decode(value, { stream: true }),
			);
			buffer = rest;
			for (const event of events) {
				for (const listener of this.listeners.get(event.type) ?? []) {
					listener({ data: event.data });
				}
			}
		}
	}
}

/**
 * The whole events in `text`, server-sent as `event:` and `data:` lines
 * with a blank line after each, and what is left of one still arriving.
 */
export function parseEvents(text: string): {
	events: { type: string; data: string }[];
	rest: string;
} {
	const blocks = text.replace(/\r\n?/g, "\n").split("\n\n");
	const rest = blocks.pop() ?? "";
	const events: { type: string; data: string }[] = [];
	for (const block of blocks) {
		let type = "message";
		const data: string[] = [];
		for (const line of block.split("\n")) {
			if (line.startsWith("event:")) type = line.slice(6).trim();
			else if (line.startsWith("data:")) {
				data.push(line.slice(5).replace(/^ /, ""));
			}
		}
		if (data.length > 0) events.push({ type, data: data.join("\n") });
	}
	return { events, rest };
}

/** Keeps cached sessions in step with the server's job events. */
export function useLiveJobs(): void {
	const client = useQueryClient();
	useEffect(() => {
		const source = openEvents("/api/events");
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
			// What it made now takes room: the account says how much.
			if (event.job.status === "succeeded") {
				void client.invalidateQueries({ queryKey: ["account"] });
			}
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
