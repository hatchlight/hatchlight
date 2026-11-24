import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeviceCookies, deviceKey } from "./devices";

const dirs: string[] = [];
afterEach(async () => {
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true });
});

test("a device cookie vouches for its person only, and only from this server", () => {
	const key = crypto.getRandomValues(new Uint8Array(32));
	const devices = new DeviceCookies(key);
	const owner = { id: "usr_owner", username: "owner" };
	const admin = { id: "usr_admin", username: "admin" };
	const cookie = devices.issue(owner);
	expect(devices.vouchesFor(cookie, owner)).toBe(true);
	expect(devices.vouchesFor(cookie, admin)).toBe(false);
	expect(devices.vouchesFor(cookie, null)).toBe(false);
	expect(devices.vouchesFor(undefined, owner)).toBe(false);
	expect(devices.vouchesFor("a.b", owner)).toBe(false);
	const other = new DeviceCookies(crypto.getRandomValues(new Uint8Array(32)));
	expect(other.vouchesFor(cookie, owner)).toBe(false);
	// The person cannot be swapped under the signature.
	const [, device, mac] = cookie.split(".");
	expect(devices.vouchesFor(`usr_admin.${device}.${mac}`, admin)).toBe(false);
	// A name given to another account later does not inherit the cookie.
	expect(
		devices.vouchesFor(cookie, { id: "usr_owner", username: "renamed" }),
	).toBe(false);
});

test("the device key is made once, readable only by the server's user", async () => {
	const dir = await mkdtemp(join(tmpdir(), "hatchlight-device-"));
	dirs.push(dir);
	const path = join(dir, "device.key");
	const first = deviceKey(path);
	expect(first.byteLength).toBe(32);
	expect((await stat(path)).mode & 0o777).toBe(0o600);
	expect(deviceKey(path)).toEqual(first);
});
