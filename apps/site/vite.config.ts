import { join } from "node:path";
import { defineConfig } from "vite";
import { LANGUAGES } from "./src/languages";
import { PAGES } from "./src/pages";

// Served from the root of its own domain, hatchlight.app (public/CNAME).
// Each page in each language is its own file, rendered by scripts/render.ts.
export default defineConfig({
	base: "/",
	build: {
		rollupOptions: {
			input: Object.fromEntries(
				LANGUAGES.flatMap((language) =>
					PAGES.map((page) => [
						[language.code, ...page.path.split("/").filter(Boolean)].join("-"),
						join(import.meta.dirname, language.path, page.path, "index.html"),
					]),
				),
			),
		},
	},
	server: { port: 5174, strictPort: true },
});
