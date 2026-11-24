import { expect, test } from "bun:test";
import type { EngineEvent } from "@hatchlight/core/types";
import { HatchlightClient } from "./client";

/** A server that sends these pieces of an event stream, as they come. */
function streaming(pieces: string[]) {
	return new HatchlightClient("http://127.0.0.1:1", async () => {
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				for (const piece of pieces) {
					controller.enqueue(new TextEncoder().encode(piece));
				}
				controller.close();
			},
		});
		return new Response(body, {
			headers: { "content-type": "text/event-stream" },
		});
	});
}

test("job events are read from the stream, however it is cut", async () => {
	const progress = {
		type: "job.progress",
		jobId: "job_1",
		stage: "generating",
		step: 3,
		steps: 8,
	};
	const updated = { type: "job.updated", job: { id: "job_1" } };
	const text = [
		"event: ready\r\ndata: {}\r\n\r\n",
		`event: job.progress\ndata: ${JSON.stringify(progress)}\n\n`,
		'event: model.installed\ndata: {"type":"model.installed"}\n\n',
		`event: job.updated\ndata: ${JSON.stringify(updated)}\n\n`,
	].join("");
	// Cut in small pieces, through lines and characters.
	const pieces = text.match(/[\s\S]{1,7}/g) ?? [];
	const seen: EngineEvent[] = [];
	for await (const event of streaming(pieces).events(
		new AbortController().signal,
	)) {
		seen.push(event);
	}
	expect(seen).toEqual([progress, updated] as EngineEvent[]);

	// A line end cut between its two characters.
	const cut: EngineEvent[] = [];
	for await (const event of streaming([
		`data: ${JSON.stringify(progress)}\r\n\r`,
		"\n",
	]).events(new AbortController().signal)) {
		cut.push(event);
	}
	expect(cut).toEqual([progress] as EngineEvent[]);
});

test("stopping the stream ends it quietly", async () => {
	const stop = new AbortController();
	const client = new HatchlightClient("http://127.0.0.1:1", (_, init) => {
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				init?.signal?.addEventListener("abort", () =>
					controller.error(new DOMException("aborted", "AbortError")),
				);
			},
		});
		return Promise.resolve(new Response(body));
	});
	const reading = (async () => {
		for await (const _ of client.events(stop.signal)) {
			// Nothing comes.
		}
	})();
	stop.abort();
	await expect(reading).resolves.toBeUndefined();
});
