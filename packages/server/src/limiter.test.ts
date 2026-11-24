import { expect, test } from "bun:test";
import { addressGroup } from "./accounts-routes";
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
	expect(limit.wait("ip:1")).toBe(1000);
	tick(1000);
	limit.fail("ip:1");
	expect(limit.wait("ip:1")).toBe(2000);
	tick(2000);
	limit.fail("ip:1");
	expect(limit.wait("ip:1")).toBe(4000);
	tick(4000);
	limit.fail("ip:1");
	expect(limit.wait("ip:1")).toBe(8000);
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

test("a failure counted before the try is given back when it was right", () => {
	const { limit } = limiter();
	for (let i = 0; i < 2; i++) limit.fail("ip:1");
	// Counted before a try that then succeeded.
	limit.fail("ip:1");
	expect(limit.wait("ip:1")).toBeGreaterThan(0);
	limit.refund("ip:1");
	expect(limit.wait("ip:1")).toBe(0);
	limit.refund("ip:2");
	expect(limit.wait("ip:2")).toBe(0);
});

test("only so many keys are kept, the oldest going first", () => {
	const limit = new Limiter({ freeTries: 0, maxKeys: 2 });
	limit.fail("a");
	limit.fail("b");
	limit.fail("c");
	expect(limit.wait("a")).toBe(0);
	expect(limit.wait("b")).toBeGreaterThan(0);
	expect(limit.wait("c")).toBeGreaterThan(0);
});

test("an IPv6 network counts as one address", () => {
	expect(addressGroup("2001:db8:1:2:3:4:5:6")).toBe(
		addressGroup("2001:db8:1:2:ffff::1"),
	);
	expect(addressGroup("2001:db8:1:3::1")).not.toBe(
		addressGroup("2001:db8:1:2::1"),
	);
	expect(addressGroup("::ffff:192.0.2.1")).toBe("192.0.2.1");
	expect(addressGroup("192.0.2.1")).toBe("192.0.2.1");
	expect(addressGroup(null)).toBe("unknown");
});
