import { describe, expect, test } from "bun:test";
import {
	hubLink,
	hubTarget,
	isHubFile,
	isHubName,
	parseHubLink,
	parseHubSpec,
} from "./hugging-face";

describe("links that open a repository in Hatchlight", () => {
	test("a repository, and a file in it, are read", () => {
		expect(parseHubLink("hatchlight://hf/owner/repo")).toEqual({
			repo: "owner/repo",
			file: null,
		});
		expect(
			parseHubLink(
				"hatchlight://hf/Some-Org/model_v1.5?file=loras%2Fstyle%20(v2).safetensors",
			),
		).toEqual({
			repo: "Some-Org/model_v1.5",
			file: "loras/style (v2).safetensors",
		});
		// A trailing slash is still the repository.
		expect(parseHubLink("hatchlight://hf/owner/repo/")?.repo).toBe(
			"owner/repo",
		);
	});

	test("a link made by Hatchlight reads back as what it was made from", () => {
		for (const target of [
			{ repo: "a/b", file: null },
			{ repo: "owner/repo", file: "folder/my file+1.safetensors" },
		]) {
			expect(parseHubLink(hubLink(target))).toEqual(target);
		}
	});

	test("anything else is not a link to a repository", () => {
		for (const link of [
			"",
			"hatchlight://hf/owner",
			"hatchlight://hf/owner/repo/extra",
			"hatchlight://hf/../repo",
			"hatchlight://hf/owner/..",
			"hatchlight://hf/owner/%2e%2e",
			"hatchlight://hf/owner%2Frepo/x",
			"hatchlight://other/owner/repo",
			"hatchlight://user:pass@hf/owner/repo",
			"hatchlight://hf:99/owner/repo",
			"hatchlight://hf/owner/repo#file=x",
			"hatchlight://hf/owner/repo?file=",
			"hatchlight://hf/owner/repo?file=../../etc/passwd",
			"hatchlight://hf/owner/repo?file=/etc/passwd",
			"hatchlight://hf/owner/repo?file=a%5Cb.safetensors",
			"hatchlight://hf/owner/repo?file=a.safetensors&file=b.safetensors",
			"hatchlight://hf/owner/repo?file=a.safetensors&then=b",
			"hatchlight://hf/owner/repo?url=https://evil.example",
			"https://huggingface.co/owner/repo",
			"javascript:alert(1)",
			"file:///etc/passwd",
			`hatchlight://hf/owner/${"r".repeat(2048)}`,
			"not a link",
		]) {
			expect(parseHubLink(link)).toBeNull();
		}
	});
});

describe("names as Hugging Face allows them", () => {
	test("owners and repositories", () => {
		for (const name of ["a", "A1", "stable-diffusion-v1-5", "x_y.z"]) {
			expect(isHubName(name)).toBe(true);
		}
		for (const name of [
			"",
			"-a",
			"a-",
			".a",
			"a.",
			"a--b",
			"a..b",
			"a b",
			"a/b",
			"é",
			"a".repeat(97),
		]) {
			expect(isHubName(name)).toBe(false);
		}
	});

	test("files, in folders or not", () => {
		for (const path of [
			"model.safetensors",
			"unet/diffusion_pytorch_model.fp16.safetensors",
			"LoRA (v2) + extra.safetensors",
		]) {
			expect(isHubFile(path)).toBe(true);
		}
		for (const path of [
			"",
			"/model.safetensors",
			"a//b",
			"../model.safetensors",
			"a/../b",
			".hidden",
			"a\\b",
			"a?b",
			"a%2fb",
			"a\nb",
			"trailing ",
			"a/b/c/d/e/f/g/h/i",
			"a".repeat(257),
		]) {
			expect(isHubFile(path)).toBe(false);
		}
	});

	test("a repository and file given apart are checked the same way", () => {
		expect(hubTarget("owner/repo", "a.safetensors")).toEqual({
			repo: "owner/repo",
			file: "a.safetensors",
		});
		expect(hubTarget("owner/repo", "")).toEqual({
			repo: "owner/repo",
			file: null,
		});
		expect(hubTarget("owner")).toBeNull();
		expect(hubTarget("owner/repo/x")).toBeNull();
		expect(hubTarget(42)).toBeNull();
		expect(hubTarget("owner/repo", 42)).toBeNull();
	});
});

describe("what is typed after `hatchlight install`", () => {
	test("hf:<owner>/<repo> and a file in it", () => {
		expect(parseHubSpec("hf:owner/repo")).toEqual({
			repo: "owner/repo",
			file: null,
		});
		expect(parseHubSpec("hf:owner/repo/folder/a.safetensors")).toEqual({
			repo: "owner/repo",
			file: "folder/a.safetensors",
		});
		for (const spec of [
			"owner/repo",
			"hf:",
			"hf:owner",
			"hf:/repo",
			"hf:owner/../x",
			"hf:owner/repo/../../x",
		]) {
			expect(parseHubSpec(spec)).toBeNull();
		}
	});
});
