import { afterAll, expect, test } from "bun:test";
import { config } from "zod";

// Tests share one process: the other packages keep zod as it was.
const before = config().jitless;
afterAll(() => {
	config({ jitless: before });
});

test("the browser's zod parses without compiling code", async () => {
	await import("./zod");
	expect(config().jitless).toBe(true);
});
