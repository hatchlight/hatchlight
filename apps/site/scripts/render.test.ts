import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { checkCatalog } from "@hatchlight/i18n";
import { LANGUAGES } from "../src/languages";
import { PAGES, type SitePage } from "../src/pages";
import { loadCatalog, renderPage, robots, sitemap } from "./render";

const ROOT = join(import.meta.dir, "..");
const template = await readFile(join(ROOT, "src", "page.html"), "utf8");
const comparison = await readFile(join(ROOT, "src", "compare.html"), "utf8");
const opener = await readFile(join(ROOT, "src", "hf.html"), "utf8");
const COMPARISONS = PAGES.filter((page) => page.template === "compare.html");
const HF = PAGES.find((page) => page.template === "hf.html") as SitePage;
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
		...COMPARISONS.flatMap((page) =>
			[...comparison.matchAll(/\{\{([\w.]+)/g)].map((m) =>
				m[1]?.replace(/^page\./, `${page.keys}.`),
			),
		),
		...[...opener.matchAll(/\{\{([\w.]+)/g)].map((m) =>
			m[1]?.replace(/^page\./, `${HF.keys}.`),
		),
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
	const json = page.match(
		/<script type="application\/ld\+json">(.*?)<\/script>/,
	)?.[1];
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

test("each comparison page renders in every language, at its own address", async () => {
	expect(COMPARISONS.map((page) => page.path)).toEqual([
		"compare/comfyui/",
		"compare/fooocus/",
	]);
	for (const page of COMPARISONS) {
		for (const language of LANGUAGES) {
			const catalog =
				language.code === "en" ? {} : await loadCatalog(language.code);
			const html = renderPage(comparison, language, en, catalog, page);
			expect(html).not.toContain("{{");
			expect(html).toContain(`<html lang="${language.code}"`);
			expect(html).toContain(
				`<link rel="canonical" href="https://hatchlight.app/${language.path}${page.path}" />`,
			);
			for (const other of LANGUAGES)
				expect(html).toContain(
					`<link rel="alternate" hreflang="${other.code}" href="https://hatchlight.app/${other.path}${page.path}" />`,
				);
			expect(html).toContain(
				`<link rel="alternate" hreflang="x-default" href="https://hatchlight.app/${page.path}" />`,
			);
			// Its title is its own, in its own language.
			const title = (catalog[`${page.keys}.title`] ??
				en[`${page.keys}.title`]) as string;
			expect(html).toContain(`<title>${title}</title>`);
			// Shared files and the main page are up the right number of folders.
			const up = "../".repeat(
				`${language.path}${page.path}`.split("/").filter(Boolean).length,
			);
			expect(html).toContain(`href="${up}src/styles.css"`);
			expect(html).toContain(`<a class="logo" href="${up}${language.path}"`);
			// The language links stay on this comparison.
			expect(html).toContain(`href="${up}pt-BR/${page.path}" hreflang="pt-BR"`);
			const json = html.match(
				/<script type="application\/ld\+json">(.*?)<\/script>/,
			)?.[1];
			const data = JSON.parse(json ?? "null");
			expect(data["@type"]).toBe("WebPage");
			expect(data.url).toBe(
				`https://hatchlight.app/${language.path}${page.path}`,
			);
			expect(data.inLanguage).toBe(language.code);
			expect(data.about["@type"]).toBe("SoftwareApplication");
		}
	}
	const portuguese = renderPage(
		comparison,
		LANGUAGES[1] as never,
		en,
		await loadCatalog("pt-BR"),
		COMPARISONS[1],
	);
	expect(portuguese).toContain("Quando escolher o Fooocus");
	expect(portuguese).toContain("https://github.com/lllyasviel/Fooocus");
});

test("the main page's footer links to the comparisons in its language", async () => {
	const portuguese = renderPage(
		template,
		LANGUAGES[1] as never,
		en,
		await loadCatalog("pt-BR"),
	);
	expect(portuguese).toContain('href="../pt-BR/compare/comfyui/"');
	expect(portuguese).toContain('href="../pt-BR/compare/fooocus/"');
	const english = renderPage(template, LANGUAGES[0] as never, en, {});
	expect(english).toContain(
		'href="./compare/comfyui/">Hatchlight vs ComfyUI</a>',
	);
});

test("the sitemap lists every comparison in every language", () => {
	const xml = sitemap("https://hatchlight.app/");
	for (const page of COMPARISONS)
		for (const language of LANGUAGES)
			expect(xml).toContain(
				`<loc>https://hatchlight.app/${language.path}${page.path}</loc>`,
			);
	expect(xml.match(/<url>/g)).toHaveLength(
		PAGES.filter((page) => !page.unlisted).length * LANGUAGES.length,
	);
});

test("the page Hugging Face links to renders in every language, unlisted", async () => {
	expect(HF.path).toBe("hf/");
	for (const language of LANGUAGES) {
		const catalog =
			language.code === "en" ? {} : await loadCatalog(language.code);
		const html = renderPage(opener, language, en, catalog, HF);
		expect(html).not.toContain("{{");
		expect(html).toContain(`<html lang="${language.code}"`);
		expect(html).toContain('<meta name="robots" content="noindex" />');
		const up = "../".repeat(
			`${language.path}${HF.path}`.split("/").filter(Boolean).length,
		);
		// Its only script is the site's own, next to the page.
		expect(
			[...html.matchAll(/<script[^>]*src="([^"]+)"/g)].map((m) => m[1]),
		).toEqual([`${up}src/hf.ts`]);
		expect(html).toContain(
			'href="https://github.com/hatchlight/hatchlight/releases/latest"',
		);
	}
	const portuguese = renderPage(
		opener,
		LANGUAGES[1] as never,
		en,
		await loadCatalog("pt-BR"),
		HF,
	);
	expect(portuguese).toContain("Abrindo no Hatchlight");
	expect(sitemap("https://hatchlight.app/")).not.toContain("/hf/");
});

test("the page's script writes the repository only as text", async () => {
	const code = await readFile(join(ROOT, "src", "hf.ts"), "utf8");
	expect(code).not.toMatch(
		/innerHTML|outerHTML|insertAdjacentHTML|document\.write/,
	);
	expect(code).toContain("hubTarget(");
	// The only place it sends the browser is Hatchlight's own scheme.
	expect(code).toContain("const link = `hatchlight://hf/${target.repo}");
});
