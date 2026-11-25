/** A page of the site, rendered once in each language. */
export interface SitePage {
	/** Its folder inside each language's folder; the main page has none. */
	path: string;
	/** Its template in src/. */
	template: string;
	/**
	 * Where its own messages live in the catalog: the template's
	 * `{{page.title}}` reads `${keys}.title`. Its title and description are
	 * `${keys}.title` and `${keys}.description`.
	 */
	keys: string;
	/** Left out of the sitemap: a page that only works from a link. */
	unlisted?: boolean;
}

/**
 * The main page comes first; then the comparisons with other apps, and the
 * page Hugging Face links to, which opens a repository in Hatchlight.
 */
export const PAGES: SitePage[] = [
	{ path: "", template: "page.html", keys: "meta" },
	{ path: "compare/comfyui/", template: "compare.html", keys: "vs.comfyui" },
	{ path: "compare/fooocus/", template: "compare.html", keys: "vs.fooocus" },
	{ path: "hf/", template: "hf.html", keys: "hf", unlisted: true },
];
