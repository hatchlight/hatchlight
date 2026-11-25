import { afterEach, describe, expect, test } from "bun:test";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { picture } from "@hatchlight/core/testing";
import { COMMANDS, EXIT, extension, parse, UsageError } from "./commands";
import { cleanups, idsIn, terminal } from "./testing";

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

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

	test("follows a guide picture, and refuses guide options that do not fit", async () => {
		const t = await terminal();
		await writeFile(join(t.dir, "pose.png"), picture(32, 32));
		const code = await t.run("generate", [
			"a dancer",
			"--allow-paid",
			"-m",
			"fake/alpha",
			"--guide",
			"pose.png",
			"--guide-kind",
			"pose",
			"--guide-map",
			"--guide-strength",
			"0.6",
			"--json",
		]);
		expect(code).toBe(EXIT.ok);
		const session = await t.api.session(t.json().sessionId);
		expect(session.turns[0]?.jobs[0]?.params.guide).toMatchObject({
			kind: "pose",
			ready: true,
			strength: 0.6,
		});
		expect(t.provider.submitted.at(-1)?.guide).toBeDefined();
		for (const args of [
			["--guide", "pose.png", "--guide-kind", "edges"],
			["--guide", "pose.png", "--guide-strength", "1.5"],
			["--guide", "pose.png", "--guide-strength", ""],
			["--guide-kind", "pose"],
			["--guide-map"],
		]) {
			await expect(
				t.run("generate", [
					"a fox",
					"--allow-paid",
					"-m",
					"fake/alpha",
					...args,
				]),
			).rejects.toBeInstanceOf(UsageError);
		}
		// A model that follows no guide says so.
		await expect(
			t.run("generate", [
				"a fox",
				"--allow-paid",
				"-m",
				"fake/beta",
				"--guide",
				"pose.png",
			]),
		).rejects.toMatchObject({ code: "noGuide" });
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

test("ranking lists the models by the results picked as the best", async () => {
	const t = await terminal();
	await t.run("ranking");
	expect(t.err.join()).toContain("No comparison has a pick yet");
	await t.run("generate", [
		"a portrait of a fox",
		"--allow-paid",
		"-m",
		"fake/alpha",
		"-m",
		"fake/beta",
		"--json",
	]);
	const { sessionId } = t.json();
	const turn = (await t.api.session(sessionId)).turns[0];
	await t.api.pick(turn?.id as string, turn?.jobs[0]?.assets[0]?.id as string);

	await t.run("ranking", ["--kind", "portrait"]);
	expect(t.out[0]).toMatch(/^1\.\s+Fake alpha\s+1\/1\s+100%/);
	expect(t.out[0]).toContain("few comparisons");
	expect(t.out[1]).toMatch(/^2\.\s+Fake beta\s+0\/1\s+0%/);
	await t.run("ranking", ["--kind", "landscape", "--json"]);
	expect(t.json()).toMatchObject({ comparisons: 0, models: [] });
	await expect(t.run("ranking", ["--kind", "cats"])).rejects.toThrow(
		"--kind takes one of",
	);
});

test("check compares a picture with pictures of its character", async () => {
	const compared: number[] = [];
	const t = await terminal({
		judge: {
			compare: async (references, _candidate, _signal, options) => {
				compared.push(references.length);
				return options?.traits
					? { score: 91, differences: [], verdict: "same" }
					: {
							score: 58,
							differences: ["coat is blue, should be green", "hair is shorter"],
							verdict: "different",
						};
			},
		},
	});
	await t.run("generate", [
		"a fox in a green coat",
		"--allow-paid",
		"-m",
		"fake/alpha",
		"-m",
		"fake/beta",
		"--count",
		"2",
		"--json",
	]);
	const [first, second, third] = t
		.json()
		.jobs.flatMap((j: { assets: { id: string }[] }) => j.assets)
		.map((a: { id: string }) => a.id);
	await writeFile(join(t.dir, "mine.png"), picture(32, 32));

	expect(await t.run("check", [third, "--like", `${first},${second}`])).toBe(
		EXIT.ok,
	);
	expect(t.out).toEqual([
		"58/100: not the same character",
		"- coat is blue, should be green",
		"- hair is shorter",
	]);
	await t.run("check", [
		"mine.png",
		"--like",
		first,
		"--traits",
		"green coat",
		"--json",
	]);
	expect(t.json()).toEqual({ score: 91, differences: [], verdict: "same" });
	expect(compared).toEqual([2, 1]);

	await expect(t.run("check", [third])).rejects.toThrow("with --like");
	await expect(
		t.run("check", [third, "--like", "ast_a,ast_b", "--like", "ast_c,ast_d"]),
	).rejects.toThrow("1 to 3 pictures");
	await expect(t.run("check", ["--like", first])).rejects.toThrow(
		"one picture to check",
	);
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
