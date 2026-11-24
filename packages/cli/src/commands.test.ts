import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeProvider } from "@hatchlight/core";
import { picture } from "@hatchlight/core/testing";
import { HatchlightClient } from "@hatchlight/mcp";
import { createApp, createRuntime } from "@hatchlight/server";
import { COMMANDS, EXIT, extension, parse, UsageError } from "./commands";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A person at a terminal, using a real Hatchlight whose models are fakes. */
async function terminal(options: { startedServer?: boolean } = {}) {
	const dir = await mkdtemp(join(tmpdir(), "hatchlight-cli-"));
	const provider = new FakeProvider();
	const runtime = await createRuntime({
		dataDir: join(dir, "data"),
		providers: [provider],
		localModels: [],
		engines: [],
	});
	await runtime.start();
	const app = createApp(runtime);
	const url = "http://127.0.0.1:4096";
	const api = new HatchlightClient(url, (target, init) =>
		Promise.resolve(app.fetch(new Request(target, init))),
	);
	let stop = new AbortController();
	const out: string[] = [];
	const err: string[] = [];
	const opened: string[] = [];
	cleanups.push(async () => {
		provider.gate = null;
		await runtime.engine.idle();
		runtime.close();
		await rm(dir, { recursive: true });
	});
	const run = async (name: string, args: string[] = []) => {
		out.length = 0;
		err.length = 0;
		const command = COMMANDS[name];
		if (!command) throw new Error(`no ${name}`);
		const { values, positionals } = parse(command, args);
		return command.run(values, positionals, {
			api,
			url,
			startedServer: options.startedServer ?? false,
			pollMs: 5,
			io: {
				out: (line) => out.push(line),
				err: (line) => err.push(line),
				status: () => {},
				cwd: dir,
				signal: stop.signal,
				open: (target) => opened.push(target),
			},
		});
	};
	const json = () => JSON.parse(out.join("\n"));
	return {
		run,
		json,
		out,
		err,
		opened,
		dir,
		provider,
		interrupt: () => stop.abort(),
		resetInterrupt: () => {
			stop = new AbortController();
		},
	};
}

const idsIn = (lines: string[], prefix: string) =>
	lines.join("\n").match(new RegExp(`${prefix}_[A-Za-z0-9_-]+`, "g")) ?? [];

describe("models", () => {
	test("lists what can be used, with what it costs", async () => {
		const t = await terminal();
		expect(await t.run("models")).toBe(EXIT.ok);
		expect(t.out.join("\n")).toContain("fake/alpha");
		expect(t.out.join("\n")).toContain("$0.01/image");
		await t.run("models", ["--json"]);
		expect(t.json().map((m: { id: string }) => m.id)).toEqual([
			"fake/alpha",
			"fake/beta",
		]);
		await t.run("models", ["--media", "video"]);
		expect(t.out).toEqual([]);
		expect(t.err.join()).toContain("No model can be used yet");
	});
});

describe("generate", () => {
	test("paid models need --allow-paid, and nothing is made without it", async () => {
		const t = await terminal();
		await expect(
			t.run("generate", ["a fox", "-m", "fake/alpha"]),
		).rejects.toThrow("pass --allow-paid");
		await expect(t.run("generate", ["a fox"])).rejects.toThrow(
			"No local model is installed",
		);
		await t.run("gallery");
		expect(t.out).toEqual([]);
	});

	test("waits, compares models, and saves what was made", async () => {
		const t = await terminal();
		const code = await t.run("generate", [
			"a red fox",
			"in snow",
			"--allow-paid",
			"-m",
			"fake/alpha",
			"-m",
			"fake/beta",
			"--ratio",
			"16:9",
			"-o",
			"out",
			"--json",
		]);
		expect(code).toBe(EXIT.ok);
		const result = t.json();
		expect(result.sessionId).toMatch(/^ses_/);
		expect(result.done).toBe(true);
		expect(result.jobs.map((j: { status: string }) => j.status)).toEqual([
			"succeeded",
			"succeeded",
		]);
		const files = await readdir(join(t.dir, "out"));
		expect(files).toHaveLength(2);
		const saved = result.jobs[0].assets[0];
		expect(saved.path).toBe(
			join(t.dir, "out", files.find((f) => f.startsWith(saved.id)) ?? ""),
		);
		expect(t.err.join()).toContain("This may cost about $0.02");
	});

	test("starts from a file or a result, in the same session", async () => {
		const t = await terminal();
		await t.run("generate", ["a fox", "--allow-paid", "-m", "fake/alpha"]);
		const [session] = idsIn(t.out, "ses");
		const [made] = idsIn(t.out, "ast");
		await writeFile(join(t.dir, "mine.png"), picture(32, 32));
		const code = await t.run("generate", [
			"the same fox, at night",
			"--allow-paid",
			"-m",
			"fake/alpha",
			"-r",
			made as string,
			"-r",
			"mine.png",
			"--session",
			session as string,
		]);
		expect(code).toBe(EXIT.ok);
		expect(t.out[0]).toContain(`Session ${session}`);
		await expect(
			t.run("generate", [
				"x",
				"--allow-paid",
				"-m",
				"fake/alpha",
				"-r",
				"missing.png",
			]),
		).rejects.toThrow("Cannot read missing.png");
	});

	test("what was made is still said when it cannot be saved", async () => {
		const t = await terminal();
		await writeFile(join(t.dir, "taken.png"), "mine");
		const code = await t.run("generate", [
			"a fox",
			"--allow-paid",
			"-m",
			"fake/alpha",
			"-o",
			"taken.png",
		]);
		expect(code).toBe(EXIT.failed);
		expect(t.out[0]).toMatch(/^Session ses_/);
		expect(idsIn(t.out, "ast")).toHaveLength(1);
		expect(t.err.join()).toContain("Not saved");
		expect(await readFile(join(t.dir, "taken.png"), "utf8")).toBe("mine");
	});

	test("several results aimed at one file are refused before anything is made", async () => {
		const t = await terminal();
		await expect(
			t.run("generate", [
				"a fox",
				"--allow-paid",
				"-m",
				"fake/alpha",
				"-m",
				"fake/beta",
				"-o",
				"one.png",
			]),
		).rejects.toThrow("give a folder");
		await t.run("gallery");
		expect(t.out).toEqual([]);
	});

	test("a failed job makes the command fail", async () => {
		const t = await terminal();
		t.provider.failWith = "out of memory";
		const code = await t.run("generate", [
			"a fox",
			"--allow-paid",
			"-m",
			"fake/alpha",
		]);
		expect(code).toBe(EXIT.failed);
		expect(t.out.join("\n")).toContain("failed: out of memory");
	});

	test("arguments out of range are refused before anything is made", async () => {
		const t = await terminal();
		for (const args of [
			["--count", "9"],
			["--seed", "-1"],
			["--strength", "2"],
			["--session", "../etc"],
		]) {
			await expect(
				t.run("generate", ["a fox", "--allow-paid", ...args]),
			).rejects.toBeInstanceOf(UsageError);
		}
		expect(() => parse(COMMANDS.generate as never, ["--nope"])).toThrow(
			UsageError,
		);
	});

	test("Ctrl+C stops waiting, and the job goes on", async () => {
		const t = await terminal();
		let open = () => {};
		t.provider.gate = new Promise((resolve) => {
			open = resolve;
		});
		const running = t.run("generate", [
			"a fox",
			"--allow-paid",
			"-m",
			"fake/alpha",
		]);
		await Bun.sleep(30);
		t.interrupt();
		expect(await running).toBe(EXIT.interrupted);
		const [session] = idsIn(t.out, "ses");
		expect(t.err.join()).toContain(`hatchlight status ${session}`);
		open();
	});
});

describe("following jobs", () => {
	test("--no-wait needs a server that outlives the command", async () => {
		const t = await terminal({ startedServer: true });
		await expect(
			t.run("generate", [
				"a fox",
				"--allow-paid",
				"-m",
				"fake/alpha",
				"--no-wait",
			]),
		).rejects.toThrow("needs Hatchlight running already");
		await expect(t.run("retry", ["job_abc"])).rejects.toThrow(
			"needs Hatchlight running already",
		);
	});

	test("a job is followed, canceled and run again", async () => {
		const t = await terminal();
		let open = () => {};
		t.provider.gate = new Promise((resolve) => {
			open = resolve;
		});
		const code = await t.run("generate", [
			"a fox",
			"--allow-paid",
			"-m",
			"fake/alpha",
			"--no-wait",
			"--json",
		]);
		expect(code).toBe(EXIT.ok);
		const { sessionId, jobs } = t.json();
		const jobId = jobs[0].id;

		await t.run("cancel", [jobId]);
		await t.run("status", [sessionId, "--json"]);
		expect(t.json().turns[0].jobs[0].status).toBe("canceled");

		t.provider.gate = null;
		open();
		await t.run("retry", [jobId]);
		let status = "";
		for (let i = 0; i < 200 && !status.includes("done"); i++) {
			await t.run("status", [sessionId]);
			status = t.out.join("\n");
			await Bun.sleep(5);
		}
		expect(status).toContain('"a fox"');
		expect(status).toContain("Fake alpha");
		expect(status).toContain("done");
	});
});

describe("gallery and get", () => {
	test("finds what was made, and saves it without overwriting", async () => {
		const t = await terminal();
		await t.run("generate", [
			"a lighthouse",
			"--allow-paid",
			"-m",
			"fake/alpha",
		]);
		await t.run("generate", ["a fox", "--allow-paid", "-m", "fake/alpha"]);
		await t.run("gallery", ["lighthouse"]);
		expect(t.out).toHaveLength(1);
		expect(t.out[0]).toContain('"a lighthouse"');
		const [id] = idsIn(t.out, "ast");

		await t.run("get", [id as string]);
		const [path] = t.out;
		expect(path?.startsWith(join(t.dir, id as string))).toBe(true);
		expect((await readFile(path as string)).byteLength).toBeGreaterThan(0);
		await expect(t.run("get", [id as string])).rejects.toThrow("--force");
		expect(await t.run("get", [id as string, "--force"])).toBe(EXIT.ok);

		await t.run("get", [id as string, "-o", "pics/light.bmp"]);
		expect(t.out).toEqual([join(t.dir, "pics", "light.bmp")]);
		await expect(t.run("get", ["/etc/passwd"])).rejects.toThrow(
			"Not a picture id",
		);
	});
});

test("open shows the app, or a session in it", async () => {
	const t = await terminal();
	await t.run("open");
	expect(t.opened).toEqual(["http://127.0.0.1:4096"]);
	await t.run("open", ["ses_abc"]);
	expect(t.opened[1]).toBe("http://127.0.0.1:4096/#/s/ses_abc");
});

test("files are named by what they hold", () => {
	expect(extension("image/png")).toBe(".png");
	expect(extension("image/jpeg")).toBe(".jpg");
	expect(extension("video/mp4")).toBe(".mp4");
	expect(extension("image/svg+xml")).toBe(".svg");
});
