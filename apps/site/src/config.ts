/**
 * Where the site sends people. `releases` stays empty until the first
 * release: the download buttons then say the desktop app is coming.
 */
export const LINKS: {
	/** The site's own address, ending in "/"; used to tell search engines about each language. */
	site: string | null;
	repository: string | null;
	releases: string | null;
	/** The guide to running Hatchlight as a server. */
	selfHosting: string | null;
} = {
	site: "https://hatchlight.app/",
	repository: "https://github.com/hatchlight/hatchlight",
	releases: "https://github.com/hatchlight/hatchlight/releases/latest",
	selfHosting:
		"https://github.com/hatchlight/hatchlight/blob/main/docs/self-hosting.md",
};
