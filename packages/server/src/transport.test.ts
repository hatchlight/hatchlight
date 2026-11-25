import { expect, test } from "bun:test";
import {
	ConfigError,
	DEFAULT_DEMO_MODEL,
	hostName,
	inBlocks,
	isLoopback,
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
		loraQuota: null,
		assetQuotaBytes: null,
		demo: null,
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
	expect(serverConfig({ mode: "personal", host: "127.0.0.1" }, env).mode).toBe(
		"personal",
	);
	expect(() => serverConfig({ mode: "public" }, {})).toThrow(ConfigError);
});

test("server mode listens everywhere and needs its public address", () => {
	expect(() => server({})).toThrow(/HATCHLIGHT_PUBLIC_URL/);
	const config = server({
		HATCHLIGHT_PUBLIC_URL: "https://Hatchlight.Example.com/",
	});
	expect(config.host).toBe("0.0.0.0");
	expect(config.loraQuota).toEqual({ files: 20, bytes: 10 * 1024 ** 3 });
	// Pictures have no limit unless one is set.
	expect(config.assetQuotaBytes).toBeNull();
	expect(
		server({
			HATCHLIGHT_PUBLIC_URL: "https://hatchlight.example.com",
			HATCHLIGHT_ASSET_GB_PER_PERSON: "2",
		}).assetQuotaBytes,
	).toBe(2 * 1024 ** 3);
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

test("demo mode listens everywhere, at its public address, with limits", () => {
	expect(() => serverConfig({ mode: "demo" }, {})).toThrow(
		/HATCHLIGHT_PUBLIC_URL/,
	);
	const config = serverConfig(
		{},
		{
			HATCHLIGHT_MODE: "demo",
			HATCHLIGHT_PUBLIC_URL: "https://demo.example",
		},
	);
	expect(config.mode).toBe("demo");
	expect(config.host).toBe("0.0.0.0");
	expect(config.transport).toEqual({
		publicOrigin: "https://demo.example",
		allowedHosts: ["demo.example"],
		trustedProxies: [],
	});
	// No accounts: nobody adds LoRAs or has room of their own.
	expect(config.loraQuota).toBeNull();
	expect(config.demo).toEqual({
		model: DEFAULT_DEMO_MODEL,
		ttlHours: 24,
		picturesPerHour: 20,
		picturesPerHourPerIp: 60,
		visitorsPerHourPerIp: 30,
		maxBatch: 2,
		maxSeconds: 4,
		frameAncestors: [],
	});
	expect(
		serverConfig(
			{ mode: "demo" },
			{
				HATCHLIGHT_PUBLIC_URL: "https://demo.example",
				HATCHLIGHT_DEMO_MODEL: "z-image",
				HATCHLIGHT_DEMO_TTL_HOURS: "6",
				HATCHLIGHT_DEMO_PICTURES_PER_HOUR: "5",
				HATCHLIGHT_DEMO_PICTURES_PER_HOUR_PER_IP: "10",
				HATCHLIGHT_DEMO_VISITORS_PER_HOUR_PER_IP: "3",
				HATCHLIGHT_DEMO_MAX_BATCH: "1",
				HATCHLIGHT_DEMO_MAX_SECONDS: "2",
				HATCHLIGHT_FRAME_ANCESTORS: "https://embed.example",
			},
		).demo,
	).toEqual({
		model: "z-image",
		ttlHours: 6,
		picturesPerHour: 5,
		picturesPerHourPerIp: 10,
		visitorsPerHourPerIp: 3,
		maxBatch: 1,
		maxSeconds: 2,
		frameAncestors: ["https://embed.example"],
	});
	for (const [name, value] of [
		["HATCHLIGHT_DEMO_TTL_HOURS", "0"],
		["HATCHLIGHT_DEMO_PICTURES_PER_HOUR", "many"],
		["HATCHLIGHT_DEMO_MAX_BATCH", "-1"],
		["HATCHLIGHT_FRAME_ANCESTORS", "http://embed.example"],
		["HATCHLIGHT_FRAME_ANCESTORS", "https://embed.example/path"],
	] as const) {
		expect(() =>
			serverConfig(
				{ mode: "demo" },
				{ HATCHLIGHT_PUBLIC_URL: "https://demo.example", [name]: value },
			),
		).toThrow(ConfigError);
	}
});

test("a demo on a Hugging Face Space takes its address from SPACE_HOST", () => {
	const config = serverConfig(
		{ mode: "demo" },
		{ SPACE_HOST: "someone-hatchlight.hf.space" },
	);
	expect(config.transport?.publicOrigin).toBe(
		"https://someone-hatchlight.hf.space",
	);
	expect(config.transport?.allowedHosts).toEqual([
		"someone-hatchlight.hf.space",
	]);
	// The Space's proxy, on a private network, is believed; a browser is not.
	const proxies = config.transport?.trustedProxies ?? [];
	expect(inBlocks("10.16.3.4", proxies)).toBe(true);
	expect(inBlocks("172.20.0.9", proxies)).toBe(true);
	expect(inBlocks("203.0.113.7", proxies)).toBe(false);
	// Shown on huggingface.co, in a frame.
	expect(config.demo?.frameAncestors).toEqual(["https://huggingface.co"]);
	// What is set by hand wins.
	const set = serverConfig(
		{ mode: "demo" },
		{
			SPACE_HOST: "someone-hatchlight.hf.space",
			HATCHLIGHT_PUBLIC_URL: "https://demo.example",
			HATCHLIGHT_TRUSTED_PROXIES: "10.1.0.0/16",
		},
	);
	expect(set.transport?.publicOrigin).toBe("https://demo.example");
	expect(inBlocks("10.16.3.4", set.transport?.trustedProxies ?? [])).toBe(
		false,
	);
	// SPACE_HOST means nothing to a server, which says its address itself.
	expect(() =>
		serverConfig(
			{ mode: "server" },
			{ SPACE_HOST: "someone-hatchlight.hf.space" },
		),
	).toThrow(/HATCHLIGHT_PUBLIC_URL/);
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

test("personal mode, which has no login, refuses to listen on the network", () => {
	for (const host of ["0.0.0.0", "::", "192.168.1.20", "nas.local"]) {
		expect(() => serverConfig({ host }, {})).toThrow(/--mode server/);
		expect(() => serverConfig({}, { HATCHLIGHT_HOST: host })).toThrow(
			ConfigError,
		);
	}
	for (const host of ["127.0.0.1", "127.0.0.2", "::1", "[::1]", "localhost"]) {
		expect(serverConfig({ host }, {}).host).toBe(host);
	}
	expect(isLoopback("::ffff:127.0.0.1")).toBe(true);
	expect(isLoopback("10.0.0.1")).toBe(false);
});

test("addresses full of zone marks are read in linear time", () => {
	const many = "%".repeat(50_000);
	const start = performance.now();
	// A line break after the marks is what made the old pattern quadratic.
	for (const text of [many, `${many}\n`, `[${many}]`, `fe80::1${many}\n`]) {
		parseIp(text);
		isLoopback(text);
		hostName(text);
	}
	expect(performance.now() - start).toBeLessThan(200);
	expect(parseIp("fe80::1%%%")?.[0]).toBe(0xfe);
});
