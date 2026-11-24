import { expect, test } from "bun:test";
import {
	ConfigError,
	hostName,
	inBlocks,
	localUrl,
	parseIp,
	requestOrigin,
	serverConfig,
} from "./transport";

const server = (env: Record<string, string>) =>
	serverConfig({ mode: "server" }, env);

test("personal mode is the default and keeps to loopback", () => {
	expect(serverConfig({}, {})).toEqual({
		mode: "personal",
		host: "127.0.0.1",
		transport: null,
	});
	// The network settings mean nothing to a personal install.
	expect(
		serverConfig({}, { HATCHLIGHT_PUBLIC_URL: "not a url" }).transport,
	).toBeNull();
});

test("the mode and host come from flags first, then the environment", () => {
	const env = {
		HATCHLIGHT_MODE: "server",
		HATCHLIGHT_HOST: "10.0.0.2",
		HATCHLIGHT_PUBLIC_URL: "https://hatchlight.example.com",
	};
	expect(serverConfig({}, env)).toMatchObject({
		mode: "server",
		host: "10.0.0.2",
	});
	expect(serverConfig({ host: "::" }, env).host).toBe("::");
	expect(serverConfig({ mode: "personal" }, env).mode).toBe("personal");
	expect(() => serverConfig({ mode: "public" }, {})).toThrow(ConfigError);
});

test("server mode listens everywhere and needs its public address", () => {
	expect(() => server({})).toThrow(/HATCHLIGHT_PUBLIC_URL/);
	const config = server({
		HATCHLIGHT_PUBLIC_URL: "https://Hatchlight.Example.com/",
	});
	expect(config.host).toBe("0.0.0.0");
	expect(config.transport).toEqual({
		publicOrigin: "https://hatchlight.example.com",
		allowedHosts: ["hatchlight.example.com"],
		trustedProxies: [],
	});
	// A default port is dropped, another is kept.
	expect(
		server({ HATCHLIGHT_PUBLIC_URL: "https://nas.example:443" }).transport
			?.publicOrigin,
	).toBe("https://nas.example");
	expect(
		server({ HATCHLIGHT_PUBLIC_URL: "http://nas.local:4096" }).transport
			?.publicOrigin,
	).toBe("http://nas.local:4096");
});

test("a public address with more than a scheme and host is refused", () => {
	for (const url of [
		"nas.example",
		"ftp://nas.example",
		"https://nas.example/hatchlight",
		"https://nas.example/?a=1",
		"https://user:pass@nas.example",
		"javascript:alert(1)",
	]) {
		expect(() => server({ HATCHLIGHT_PUBLIC_URL: url })).toThrow(ConfigError);
	}
});

test("extra hosts and trusted proxies are read as lists", () => {
	const config = server({
		HATCHLIGHT_PUBLIC_URL: "https://nas.example",
		HATCHLIGHT_ALLOWED_HOSTS: " 192.168.1.20 , NAS.local:4096,[fd7a::1]",
		HATCHLIGHT_TRUSTED_PROXIES: "172.16.0.0/12, 10.0.0.1, fd00::/8",
	});
	expect(config.transport?.allowedHosts).toEqual([
		"nas.example",
		"192.168.1.20",
		"nas.local",
		"[fd7a::1]",
	]);
	expect(config.transport?.trustedProxies).toHaveLength(3);
	for (const proxies of [
		"10.0.0.0/33",
		"10.0.0/8",
		"fd00::/129",
		"x",
		"1/2/3",
	]) {
		expect(() =>
			server({
				HATCHLIGHT_PUBLIC_URL: "https://nas.example",
				HATCHLIGHT_TRUSTED_PROXIES: proxies,
			}),
		).toThrow(ConfigError);
	}
	expect(() =>
		server({
			HATCHLIGHT_PUBLIC_URL: "https://nas.example",
			HATCHLIGHT_ALLOWED_HOSTS: "nas.example/path",
		}),
	).toThrow(ConfigError);
});

test("addresses are matched against IPv4 and IPv6 blocks", () => {
	const blocks = server({
		HATCHLIGHT_PUBLIC_URL: "https://nas.example",
		HATCHLIGHT_TRUSTED_PROXIES: "172.16.0.0/12,fd00::/8,::1",
	}).transport?.trustedProxies as NonNullable<
		ReturnType<typeof server>["transport"]
	>["trustedProxies"];
	expect(inBlocks("172.17.0.3", blocks)).toBe(true);
	expect(inBlocks("172.32.0.1", blocks)).toBe(false);
	// Dual-stack sockets report IPv4 peers in their IPv6 form.
	expect(inBlocks("::ffff:172.17.0.3", blocks)).toBe(true);
	expect(inBlocks("fd12:3456::1", blocks)).toBe(true);
	expect(inBlocks("fe80::1", blocks)).toBe(false);
	expect(inBlocks("::1", blocks)).toBe(true);
	expect(inBlocks("not an address", blocks)).toBe(false);
	expect(inBlocks("10.0.0.1", [])).toBe(false);
});

test("IP addresses parse in their usual spellings", () => {
	expect(parseIp("::")).toEqual(new Uint8Array(16));
	expect(parseIp("1:2:3:4:5:6:7:8")?.[15]).toBe(8);
	expect(parseIp("[::1]")?.[15]).toBe(1);
	expect(parseIp("fe80::1%eth0")?.[0]).toBe(0xfe);
	for (const bad of [
		"1:2:3:4:5:6:7:8:9",
		"1::2::3",
		"256.0.0.1",
		"1.2.3",
		"g::",
	]) {
		expect(parseIp(bad)).toBeNull();
	}
});

test("host names are taken from a Host header, or refused", () => {
	expect(hostName("NAS.example:8443")).toBe("nas.example");
	expect(hostName("[::1]:4096")).toBe("[::1]");
	expect(hostName("evil.example/x@nas.example")).toBeNull();
	expect(hostName("")).toBeNull();
});

test("forwarded headers count only from a trusted proxy", () => {
	const proxies =
		server({
			HATCHLIGHT_PUBLIC_URL: "https://nas.example",
			HATCHLIGHT_TRUSTED_PROXIES: "10.0.0.0/8",
		}).transport?.trustedProxies ?? [];
	const url = new URL("http://hatchlight:4096/api/models");
	const headers = new Headers({
		"x-forwarded-proto": "https",
		"x-forwarded-host": "nas.example",
		"x-forwarded-for": "203.0.113.9, 10.0.0.7",
	});
	expect(requestOrigin(url, headers, "10.0.0.5", proxies)).toEqual({
		scheme: "https",
		host: "nas.example",
		client: "203.0.113.9",
	});
	expect(requestOrigin(url, headers, "198.51.100.1", proxies)).toEqual({
		scheme: "http",
		host: "hatchlight:4096",
		client: "198.51.100.1",
	});
	// A forged leftmost hop does not hide the address the proxy saw.
	const spoofed = new Headers({ "x-forwarded-for": "127.0.0.1, 203.0.113.9" });
	expect(requestOrigin(url, spoofed, "10.0.0.5", proxies).client).toBe(
		"203.0.113.9",
	);
	// Only http and https are schemes a browser can be on here.
	const odd = new Headers({ "x-forwarded-proto": "gopher" });
	expect(requestOrigin(url, odd, "10.0.0.5", proxies).scheme).toBe("http");
});

test("local processes find the server where it really listens", () => {
	expect(localUrl("127.0.0.1", 4096)).toBe("http://127.0.0.1:4096");
	expect(localUrl("0.0.0.0", 4096)).toBe("http://127.0.0.1:4096");
	expect(localUrl("::", 4096)).toBe("http://[::1]:4096");
	expect(localUrl("::1", 4096)).toBe("http://[::1]:4096");
	expect(localUrl("localhost", 4096)).toBe("http://localhost:4096");
	expect(localUrl("10.0.0.2", 4096)).toBe("http://10.0.0.2:4096");
	expect(localUrl("fd00::2", 4096)).toBe("http://[fd00::2]:4096");
});
