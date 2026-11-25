import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type Catalog, createTranslator } from "@hatchlight/i18n";
import { LINKS } from "../src/config";
import { LANGUAGES, type SiteLanguage } from "../src/languages";
import { PAGES, type SitePage } from "../src/pages";

const ROOT = join(import.meta.dir, "..");
const TOKEN = /\{\{([\w.]+)(?:\|([^}]*))?\}\}/g;

/** Where crawlers find every page; written next to the site's other files. */
const PUBLIC = join(ROOT, "public");

const escapeHtml = (text: string) =>
	text
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");

export async function loadCatalog(code: string): Promise<Catalog> {
	return JSON.parse(
		await readFile(join(ROOT, "src", "locales", `${code}.json`), "utf8"),
	);
}

/**
 * One page in one language. Keys ending in ".html" may hold markup, and
 * `{{page.x}}` reads the page's own `${page.keys}.x`.
 */
export function renderPage(
	template: string,
	language: SiteLanguage,
	source: Catalog,
	translation: Catalog,
	page: SitePage = PAGES[0] as SitePage,
): string {
	const { t } = createTranslator(language.code, source, translation);
	const depth = `${language.path}${page.path}`.split("/").filter(Boolean);
	const root = depth.length ? "../".repeat(depth.length) : "./";
	const alternates = LINKS.site
		? [
				...LANGUAGES.map(
					(other) =>
						`<link rel="alternate" hreflang="${other.code}" href="${LINKS.site}${other.path}${page.path}" />`,
				),
				`<link rel="alternate" hreflang="x-default" href="${LINKS.site}${page.path}" />`,
			].join("\n\t\t")
		: "";
	const languageLinks = LANGUAGES.map((other) => {
		const current = other.code === language.code;
		return `<a href="${root}${other.path}${page.path}" hreflang="${other.code}" lang="${other.code}"${current ? ' aria-current="page"' : ""}>${escapeHtml(other.name)}</a>`;
	}).join("");
	const canonical = LINKS.site
		? `<link rel="canonical" href="${LINKS.site}${language.path}${page.path}" />`
		: "";
	const values: Record<string, string> = {
		lang: language.code,
		canonical,
		structuredData: structuredData(language, t, page),
		ogLocale: language.ogLocale,
		root,
		// The main page in this language, from here.
		home: `${root}${language.path}`,
		// Pages without a script link straight to where people get the app.
		repository: LINKS.repository ?? "#",
		download: LINKS.releases ?? LINKS.repository ?? "#",
		alternates,
		languageLinks,
		// Crawlers drop a relative image, so the preview uses the site address.
		ogImage: LINKS.site
			? `${LINKS.site}shots/ramen.webp`
			: `${root}shots/ramen.webp`,
	};

	return template
		.replaceAll("{{page.", `{{${page.keys}.`)
		.replace(TOKEN, (_, key: string, args?: string) => {
			if (key in values) return values[key] as string;
			if (!(key in source))
				throw new Error(`The page uses a key the catalog lacks: ${key}`);
			const params = Object.fromEntries(
				(args ?? "")
					.split(",")
					.filter(Boolean)
					.map((pair) => pair.split("=") as [string, string]),
			);
			const text = t(key, params);
			return key.endsWith(".html") ? text : escapeHtml(text);
		});
}

/**
 * What search engines show about the app (schema.org SoftwareApplication):
 * that it is free, which systems it runs on and where to get it. Other pages
 * are a WebPage about the app. "<" is escaped so no text can close the
 * script it sits in.
 */
export function structuredData(
	language: SiteLanguage,
	t: (key: string) => string,
	page: SitePage = PAGES[0] as SitePage,
): string {
	const app = {
		"@type": "SoftwareApplication",
		name: "Hatchlight",
		description: t("meta.description"),
		inLanguage: language.code,
		applicationCategory: "MultimediaApplication",
		operatingSystem: "Windows, macOS, Linux",
		offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
		license: "https://opensource.org/licenses/MIT",
		...(LINKS.site && {
			url: `${LINKS.site}${language.path}`,
			image: `${LINKS.site}shots/ramen.webp`,
		}),
		...(LINKS.releases && { downloadUrl: LINKS.releases }),
		...(LINKS.repository && {
			sameAs: [LINKS.repository, "https://www.npmjs.com/package/hatchlight"],
		}),
	};
	const data = page.path
		? {
				"@context": "https://schema.org",
				"@type": "WebPage",
				name: t(`${page.keys}.title`),
				description: t(`${page.keys}.description`),
				inLanguage: language.code,
				...(LINKS.site && {
					url: `${LINKS.site}${language.path}${page.path}`,
				}),
				about: app,
			}
		: { "@context": "https://schema.org", ...app };
	const json = JSON.stringify(data).replaceAll("<", "\\u003c");
	return `<script type="application/ld+json">${json}</script>`;
}

/** Every page, with its other languages, for search engines. */
export function sitemap(site: string): string {
	const urls = PAGES.filter((page) => !page.unlisted)
		.flatMap((page) => {
			const alternates = LANGUAGES.map(
				(other) =>
					`<xhtml:link rel="alternate" hreflang="${other.code}" href="${site}${other.path}${page.path}"/>`,
			).join("");
			return LANGUAGES.map(
				(language) =>
					`<url><loc>${site}${language.path}${page.path}</loc>${alternates}</url>`,
			);
		})
		.join("\n");
	return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${urls}
</urlset>
`;
}

/** Lets every crawler in, and tells it where the sitemap is. */
export function robots(site: string | null): string {
	return `User-agent: *\nAllow: /\n${site ? `Sitemap: ${site}sitemap.xml\n` : ""}`;
}

/** Writes index.html for each page in each language, where Vite expects them. */
export async function render(): Promise<string[]> {
	const source = await loadCatalog("en");
	const written: string[] = [];
	for (const language of LANGUAGES) {
		const translation =
			language.code === "en" ? {} : await loadCatalog(language.code);
		for (const page of PAGES) {
			const template = await readFile(join(ROOT, "src", page.template), "utf8");
			const file = join(ROOT, language.path, page.path, "index.html");
			await mkdir(dirname(file), { recursive: true });
			await writeFile(
				file,
				renderPage(template, language, source, translation, page),
			);
			written.push(file);
		}
	}
	await writeFile(join(PUBLIC, "robots.txt"), robots(LINKS.site));
	if (LINKS.site) {
		await writeFile(join(PUBLIC, "sitemap.xml"), sitemap(LINKS.site));
	}
	return written;
}

if (import.meta.main) {
	const files = await render();
	console.log(`Rendered ${files.length} pages`);
}
