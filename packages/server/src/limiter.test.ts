import { expect, test } from "bun:test";
import { Limiter } from "./limiter";

function limiter() {
	let now = 0;
	const limit = new Limiter({ now: () => now, freeTries: 3 });
	return {
		limit,
		tick: (ms: number) => {
			now += ms;
		},
	};
}

test("a few failures are free, then each try waits twice as long", () => {
	const { limit, tick } = limiter();
	for (let i = 0; i < 3; i++) {
		expect(limit.wait("ip:1")).toBe(0);
		limit.fail("ip:1");
	}
	expect(limit.wait("ip:1")).toBe(0);
	limit.fail("ip:1");
	expect(limit.wait("ip:1")).toBe(1000);
	tick(1000);
	limit.fail("ip:1");
	expect(limit.wait("ip:1")).toBe(2000);
	tick(2000);
	limit.fail("ip:1");
	expect(limit.wait("ip:1")).toBe(4000);
	// Other keys are not slowed.
	expect(limit.wait("ip:2")).toBe(0);
});

test("the wait stops growing at its limit", () => {
	const { limit } = limiter();
	for (let i = 0; i < 40; i++) limit.fail("user:ana");
	expect(limit.wait("user:ana")).toBe(15 * 60 * 1000);
});

test("success and time forgive", () => {
	const { limit, tick } = limiter();
	for (let i = 0; i < 6; i++) limit.fail("user:ana");
	expect(limit.wait("user:ana")).toBeGreaterThan(0);
	limit.succeed("user:ana");
	expect(limit.wait("user:ana")).toBe(0);

	for (let i = 0; i < 6; i++) limit.fail("user:bia");
	tick(60 * 60 * 1000 + 1);
	expect(limit.wait("user:bia")).toBe(0);
	limit.fail("user:bia");
	expect(limit.wait("user:bia")).toBe(0);
});
