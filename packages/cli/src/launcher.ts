/**
 * How this same program starts a Hatchlight server: a compiled one by
 * itself, Bun with this script otherwise. A compiled program's script is
 * not a file.
 */
export function launcher(): string[] {
	const compiled = /\$bunfs|~BUN/.test(Bun.main);
	return compiled ? [process.execPath] : [process.execPath, Bun.main];
}

/** Opens an address in the browser, if this system has a way to. */
export function openInBrowser(url: string): void {
	const opener =
		process.platform === "darwin"
			? "open"
			: process.platform === "win32"
				? "explorer"
				: "xdg-open";
	try {
		Bun.spawn([opener, url], { stdio: ["ignore", "ignore", "ignore"] });
	} catch {
		// No browser launcher available; the address was printed.
	}
}

/** The options a server started for this process is given. */
export function serverArgs(values: {
	"data-dir"?: string;
	resources?: string;
}): string[] {
	return [
		...(values["data-dir"] ? ["--data-dir", values["data-dir"]] : []),
		...(values.resources ? ["--resources", values.resources] : []),
	];
}
