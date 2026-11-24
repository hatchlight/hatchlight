import { afterEach, expect, test } from "bun:test";
import {
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	readlink,
	rm,
	stat,
	symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { extractTarGz } from "./tar";
import { tarGz } from "./testing";

const dirs: string[] = [];
afterEach(async () => {
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true });
});
async function tempDir() {
	const dir = await mkdtemp(join(tmpdir(), "hatchlight-tar-"));
	dirs.push(dir);
	return dir;
}

async function extract(archive: Uint8Array) {
	const dir = await tempDir();
	const path = join(dir, "archive.tar.gz");
	await Bun.write(path, archive);
	const out = join(dir, "out");
	await extractTarGz(path, out);
	return out;
}

const text = (value: string) => new TextEncoder().encode(value);

test("extracts files and folders, keeping programs runnable", async () => {
	const big = text("weights ".repeat(400_000)); // spans many chunks
	const out = await extract(
		tarGz([
			{ name: "./", type: "5" },
			{ name: "./sd-cli", data: text("#!/bin/sh\necho run"), mode: 0o4755 },
			{ name: "./lib/", type: "5" },
			{ name: "./lib/libggml.so", data: big },
			{ name: "./empty.txt" },
		]),
	);
	expect((await readdir(out)).sort()).toEqual(["empty.txt", "lib", "sd-cli"]);
	expect(await Bun.file(join(out, "sd-cli")).text()).toBe(
		"#!/bin/sh\necho run",
	);
	expect(await Bun.file(join(out, "lib", "libggml.so")).bytes()).toEqual(big);
	expect(await Bun.file(join(out, "empty.txt")).size).toBe(0);
	// Executable, but never setuid.
	expect((await stat(join(out, "sd-cli"))).mode & 0o7777).toBe(0o755);
	expect((await stat(join(out, "empty.txt"))).mode & 0o777).toBe(0o644);
});

test("keeps links to files next to them", async () => {
	const out = await extract(
		tarGz([
			{ name: "libmtmd.so.0.0.1", data: text("library") },
			{ name: "libmtmd.so.0", type: "2", linkname: "libmtmd.so.0.0.1" },
			{ name: "libmtmd.so", type: "2", linkname: "libmtmd.so.0" },
		]),
	);
	expect((await lstat(join(out, "libmtmd.so"))).isSymbolicLink()).toBe(true);
	expect(await readlink(join(out, "libmtmd.so"))).toBe("libmtmd.so.0");
	expect(await Bun.file(join(out, "libmtmd.so")).text()).toBe("library");
});

test("reads long names from pax headers", async () => {
	const name = `${"folder/".repeat(20)}program`;
	const out = await extract(tarGz([{ name, data: text("x"), pax: true }]));
	expect(await Bun.file(join(out, name)).text()).toBe("x");
});

test("refuses paths and links that would leave the destination", async () => {
	for (const name of ["../escape.txt", "/etc/passwd", "a/../../b", "./"]) {
		await expect(extract(tarGz([{ name, data: text("x") }]))).rejects.toThrow(
			"unsafe path",
		);
	}
	for (const linkname of ["/etc/passwd", "../outside", "lib/../..", ".."]) {
		await expect(
			extract(tarGz([{ name: "link", type: "2", linkname }])),
		).rejects.toThrow("unsafe link");
	}
});

/** A pax record, its length counting its own digits. */
function paxRecord(key: string, value: string): string {
	const body = ` ${key}=${value}\n`;
	let length = body.length + 1;
	while (`${length}${body}`.length !== length) length++;
	return `${length}${body}`;
}

test("what an extended header says applies to the next entry only", async () => {
	const out = await extract(
		tarGz([
			{
				name: "PaxHeader",
				type: "x",
				data: text(paxRecord("path", "first.txt") + paxRecord("size", "3")),
			},
			// A GNU long name in between keeps its own size.
			{ name: "././@LongLink", type: "L", data: text("long-name.txt\0") },
			{ name: "ignored", data: text("abc") },
			{ name: "second.txt", data: text("own name") },
		]),
	);
	expect((await readdir(out)).sort()).toEqual(["long-name.txt", "second.txt"]);
	expect(await Bun.file(join(out, "long-name.txt")).text()).toBe("abc");
	expect(await Bun.file(join(out, "second.txt")).text()).toBe("own name");
});

test("refuses sizes that cannot be, and extended headers too large", async () => {
	for (const size of ["-1", "abc", "1e300", "9007199254740993"]) {
		await expect(
			extract(
				tarGz([
					{ name: "PaxHeader", type: "x", data: text(paxRecord("size", size)) },
					{ name: "a.txt", data: text("x") },
				]),
			),
		).rejects.toThrow("damaged");
	}
	await expect(
		extract(
			tarGz([
				{
					name: "PaxHeader",
					type: "x",
					data: text(paxRecord("comment", "x".repeat(1024 * 1024))),
				},
			]),
		),
	).rejects.toThrow("too large");
});

test("refuses backslashes in names and links", async () => {
	await expect(
		extract(tarGz([{ name: "..\\escape.txt", data: text("x") }])),
	).rejects.toThrow("unsafe path");
	await expect(
		extract(tarGz([{ name: "link", type: "2", linkname: "..\\outside" }])),
	).rejects.toThrow("unsafe link");
});

test("refuses hard links, devices and other kinds of entries", async () => {
	for (const type of ["1", "3", "4", "6"]) {
		await expect(
			extract(tarGz([{ name: "odd", type, linkname: "target" }])),
		).rejects.toThrow("not supported");
	}
});

test("a file written through a link stays in the destination", async () => {
	// The link names a sibling folder: what goes through it lands there.
	const out = await extract(
		tarGz([
			{ name: "real/", type: "5" },
			{ name: "alias", type: "2", linkname: "real" },
			{ name: "alias/file.txt", data: text("inside") },
		]),
	);
	expect(await Bun.file(join(out, "real", "file.txt")).text()).toBe("inside");
});

test("refuses what is damaged, cut short or not a tar.gz", async () => {
	await expect(extract(text("not an archive at all"))).rejects.toThrow();
	await expect(
		extract(tarGz([{ name: "a.txt", data: text("x"), checksum: 1 }])),
	).rejects.toThrow("damaged");
	const whole = gunzipSync(
		tarGz([{ name: "a.txt", data: text("x".repeat(5000)) }]),
	);
	await expect(extract(gzipSync(whole.slice(0, 2048)))).rejects.toThrow(
		"truncated",
	);
	await expect(extract(tarGz([]).slice(0, 10))).rejects.toThrow();
});

test("extracts what GNU tar writes, links included", async () => {
	const dir = await tempDir();
	const source = join(dir, "source");
	await mkdir(join(source, "deep"), { recursive: true });
	await Bun.write(join(source, "sd-cli"), "#!/bin/sh\necho run");
	await Bun.write(join(source, "libggml.so.0"), "library");
	await symlink("libggml.so.0", join(source, "libggml.so"));
	await Bun.write(join(source, "deep", `${"n".repeat(120)}.txt`), "long");
	const archive = join(dir, "engine.tar.gz");
	const tar = Bun.spawnSync(["tar", "-czf", archive, "-C", source, "."]);
	if (tar.exitCode !== 0) throw new Error(tar.stderr.toString());

	const out = join(dir, "out");
	await extractTarGz(archive, out);
	expect(await readlink(join(out, "libggml.so"))).toBe("libggml.so.0");
	expect(
		await Bun.file(join(out, "deep", `${"n".repeat(120)}.txt`)).text(),
	).toBe("long");
	expect(await Bun.file(join(out, "sd-cli")).text()).toBe(
		"#!/bin/sh\necho run",
	);
});
