import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { checkCatalog } from "@hatchlight/i18n";
import { LANGUAGES } from "../src/languages";
import { loadCatalog, renderPage, robots, sitemap } from "./render";

const ROOT = join(import.meta.dir, "..");
const template = await readFile(join(ROOT, "src", "page.html"), "utf8");
const script = await readFile(join(ROOT, "src", "main.ts"), "utf8");
const en = await loadCatalog("en");

test("every language renders a complete page in that language", async () => {
	for (const language of LANGUAGES) {
		const catalog =
			language.code === "en" ? {} : await loadCatalog(language.code);
		const page = renderPage(template, language, en, catalog);
		expect(page).not.toContain("{{");
		expect(page).toContain(`<html lang="${language.code}"`);
		// Each page links to every language, and marks its own.
		for (const other of LANGUAGES)
			expect(page).toContain(`hreflang="${other.code}"`);
		expect(page).toContain(`aria-current="page">${language.name}`);
		// Crawlers need an absolute image; a relative one does not preview.
		expect(page).toContain(
			'property="og:image" content="https://hatchlight.app/shots/ramen.webp"',
		);
		expect(page).not.toContain("data-coming");
		expect(page).not.toContain("Star the project");
		expect(page).not.toContain("Dê uma estrela");
	}
	const portuguese = renderPage(
		template,
		LANGUAGES[1] as never,
		en,
		await loadCatalog("pt-BR"),
	);
	expect(portuguese).toContain("Roda no seu computador, de graça.");
	expect(portuguese).toContain("ainda em teste");
	expect(portuguese).toContain("NVIDIA (CUDA)");
	const english = renderPage(template, LANGUAGES[0] as never, en, {});
	expect(english).toContain(
		"On Linux they run on NVIDIA (CUDA) and the CPU, and that support is early and still being tested.",
	);
	expect(english).not.toContain("Linux is coming");
	expect(english).toContain("The installers are not signed yet.");
	// Pages in a folder reach the shared files one level up.
	expect(portuguese).toContain('src="../src/main.ts"');
	expect(portuguese).toContain('src="../shots/fisherman.webp"');
});

test("plain text is escaped; only .html keys may carry markup", () => {
	const page = renderPage(template, LANGUAGES[0] as never, en, {
		"hero.eyebrow": "<script>alert(1)</script>",
	});
	expect(page).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
	expect(page).toContain('<span class="w"><em>See</em></span>');
});

test("a key the catalog lacks fails the build instead of shipping", () => {
	expect(() =>
		renderPage("<p>{{nope.missing}}</p>", LANGUAGES[0] as never, en, {}),
	).toThrow("lacks: nope.missing");
});

test("translations match the English catalog", async () => {
	for (const language of LANGUAGES.slice(1)) {
		expect(checkCatalog(en, await loadCatalog(language.code))).toEqual([]);
	}
});

test("every English message is used by the page or its script", () => {
	const used = new Set([
		...[...template.matchAll(/\{\{([\w.]+)/g)].map((m) => m[1]),
		...[...script.matchAll(/t\("([\w.]+)"/g)].map((m) => m[1]),
	]);
	// Captions are looked up by picture name.
	const reel = [...script.matchAll(/^\t"(\w+)",$/gm)].map(
		(m) => `reel.${m[1]}`,
	);
	for (const key of reel) used.add(key);
	expect(Object.keys(en).filter((key) => !used.has(key))).toEqual([]);
});

test("each page names its own address and tells search engines what the app is", async () => {
	const portuguese = renderPage(
		template,
		LANGUAGES[1] as never,
		en,
		await loadCatalog("pt-BR"),
	);
	expect(portuguese).toContain(
		'<link rel="canonical" href="https://hatchlight.app/pt-BR/" />',
	);
	const json = portuguese.match(
		/<script type="application\/ld\+json">(.*?)<\/script>/,
	)?.[1];
	const data = JSON.parse(json ?? "null");
	expect(data["@type"]).toBe("SoftwareApplication");
	expect(data.inLanguage).toBe("pt-BR");
	expect(data.offers.price).toBe("0");
	// The description comes from the page's own language.
	expect(data.description).not.toBe(en["meta.description"]);
});

test("the structured data cannot close its script", () => {
	const page = renderPage(template, LANGUAGES[0] as never, en, {
		"meta.description": "</script><script>alert(1)</script>",
	});
	const json = page.match(/<script type="application\/ld\+json">(.*?)<\/script>/)?.[1];
	expect(json).toContain("\\u003c/script>");
	expect(JSON.parse(json ?? "null").description).toBe(
		"</script><script>alert(1)</script>",
	);
});

test("the sitemap lists every language, and robots.txt points to it", () => {
	const xml = sitemap("https://hatchlight.app/");
	for (const language of LANGUAGES) {
		expect(xml).toContain(`<loc>https://hatchlight.app/${language.path}</loc>`);
		expect(xml).toContain(`hreflang="${language.code}"`);
	}
	expect(robots("https://hatchlight.app/")).toBe(
		"User-agent: *\nAllow: /\nSitemap: https://hatchlight.app/sitemap.xml\n",
	);
});
