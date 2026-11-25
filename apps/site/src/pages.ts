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
}

/** The main page comes first; the others compare Hatchlight with other apps. */
export const PAGES: SitePage[] = [
	{ path: "", template: "page.html", keys: "meta" },
	{ path: "compare/comfyui/", template: "compare.html", keys: "vs.comfyui" },
	{ path: "compare/fooocus/", template: "compare.html", keys: "vs.fooocus" },
];
