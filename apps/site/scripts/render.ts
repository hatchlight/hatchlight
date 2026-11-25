import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type Catalog, createTranslator } from "@hatchlight/i18n";
import { LINKS } from "../src/config";
import { LANGUAGES, type SiteLanguage } from "../src/languages";

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

/** The page for one language. Keys ending in ".html" may hold markup. */
export function renderPage(
	template: string,
	language: SiteLanguage,
	source: Catalog,
	translation: Catalog,
): string {
	const { t } = createTranslator(language.code, source, translation);
	const root = language.path
		? "../".repeat(language.path.split("/").filter(Boolean).length)
		: "./";
	const alternates = LINKS.site
		? [
				...LANGUAGES.map(
					(other) =>
						`<link rel="alternate" hreflang="${other.code}" href="${LINKS.site}${other.path}" />`,
				),
				`<link rel="alternate" hreflang="x-default" href="${LINKS.site}" />`,
			].join("\n\t\t")
		: "";
	const languageLinks = LANGUAGES.map((other) => {
		const current = other.code === language.code;
		return `<a href="${root}${other.path}" hreflang="${other.code}" lang="${other.code}"${current ? ' aria-current="page"' : ""}>${escapeHtml(other.name)}</a>`;
	}).join("");
	const canonical = LINKS.site
		? `<link rel="canonical" href="${LINKS.site}${language.path}" />`
		: "";
	const values: Record<string, string> = {
		lang: language.code,
		canonical,
		structuredData: structuredData(language, t),
		ogLocale: language.ogLocale,
		root,
		alternates,
		languageLinks,
		// Crawlers drop a relative image, so the preview uses the site address.
		ogImage: LINKS.site
			? `${LINKS.site}shots/ramen.webp`
			: `${root}shots/ramen.webp`,
	};

	return template.replace(TOKEN, (_, key: string, args?: string) => {
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
 * that it is free, which systems it runs on and where to get it. "<" is
 * escaped so no text can close the script it sits in.
 */
export function structuredData(
	language: SiteLanguage,
	t: (key: string) => string,
): string {
	const data = {
		"@context": "https://schema.org",
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
	const json = JSON.stringify(data).replaceAll("<", "\\u003c");
	return `<script type="application/ld+json">${json}</script>`;
}

/** Every page, with its other languages, for search engines. */
export function sitemap(site: string): string {
	const alternates = LANGUAGES.map(
		(other) =>
			`<xhtml:link rel="alternate" hreflang="${other.code}" href="${site}${other.path}"/>`,
	).join("");
	const urls = LANGUAGES.map(
		(language) => `<url><loc>${site}${language.path}</loc>${alternates}</url>`,
	).join("\n");
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

/** Writes index.html for each language, where Vite expects its pages. */
export async function render(): Promise<string[]> {
	const template = await readFile(join(ROOT, "src", "page.html"), "utf8");
	const source = await loadCatalog("en");
	const written: string[] = [];
	for (const language of LANGUAGES) {
		const translation =
			language.code === "en" ? {} : await loadCatalog(language.code);
		const file = join(ROOT, language.path, "index.html");
		await mkdir(dirname(file), { recursive: true });
		await writeFile(file, renderPage(template, language, source, translation));
		written.push(file);
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
