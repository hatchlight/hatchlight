import { hubRepoUrl, hubTarget } from "@hatchlight/core/hugging-face";

/**
 * hatchlight.app/hf?repo=<owner>/<repo>&file=<path>, the page Hugging Face's
 * "Use this model" menu links to: it opens the repository in Hatchlight, and
 * offers the download for when Hatchlight is not installed. The repository
 * and file come from the address, so they are checked and only ever written
 * as text.
 */

const query = new URLSearchParams(location.search);
const target = hubTarget(query.get("repo"), query.get("file"));

if (target) {
	// Built here with its fixed scheme, so the page can only ever send the
	// browser to Hatchlight itself. Same form as hubLink in core.
	const link = `hatchlight://hf/${target.repo}${target.file ? `?${new URLSearchParams({ file: target.file })}` : ""}`;
	for (const element of document.querySelectorAll<HTMLElement>(
		"[data-found]",
	)) {
		element.hidden = false;
	}
	for (const element of document.querySelectorAll<HTMLElement>(
		"[data-invalid]",
	)) {
		element.hidden = true;
	}
	(document.querySelector("[data-repo]") as HTMLElement).textContent =
		target.repo;
	if (target.file) {
		for (const element of document.querySelectorAll<HTMLElement>(
			"[data-file]",
		)) {
			element.hidden = false;
		}
		(document.querySelector("[data-file-name]") as HTMLElement).textContent =
			target.file;
	}
	(document.querySelector("[data-open]") as HTMLAnchorElement).href = link;
	(document.querySelector("[data-hub]") as HTMLAnchorElement).href = hubRepoUrl(
		target.repo,
	);
	// Tried once on arrival; the browser asks before it opens the app, and
	// the button stays for when it did not.
	location.href = link;
}
