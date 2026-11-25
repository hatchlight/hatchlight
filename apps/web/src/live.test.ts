import { expect, test } from "bun:test";
import { parseEvents } from "./live";

test("server-sent events are read whole, with what is still arriving kept", () => {
	const first = parseEvents(
		'event: ready\ndata: {}\n\nevent: job.updated\ndata: {"a":1}\n\nevent: pi',
	);
	expect(first.events).toEqual([
		{ type: "ready", data: "{}" },
		{ type: "job.updated", data: '{"a":1}' },
	]);
	expect(first.rest).toBe("event: pi");
	// The rest of the cut one comes with the next piece.
	const second = parseEvents(`${first.rest}ng\ndata: {}\n\n`);
	expect(second.events).toEqual([{ type: "ping", data: "{}" }]);
	expect(second.rest).toBe("");
	// Lines of data join; Windows line ends count; a comment alone is nothing.
	expect(
		parseEvents("data: one\r\ndata:two\r\n\r\n: keep-alive\n\n").events,
	).toEqual([{ type: "message", data: "one\ntwo" }]);
});
