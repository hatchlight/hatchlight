import type { Language } from "@hatchlight/i18n";

export interface SiteLanguage extends Language {
	/** The language's folder on the site; the first one lives at the root. */
	path: string;
	/** Open Graph locale, e.g. "pt_BR". */
	ogLocale: string;
}

/** English is the source; to add a language, add its catalog and a line here. */
export const LANGUAGES: SiteLanguage[] = [
	{ code: "en", name: "English", path: "", ogLocale: "en_US" },
	{
		code: "pt-BR",
		name: "Português (Brasil)",
		path: "pt-BR/",
		ogLocale: "pt_BR",
	},
	{ code: "fr", name: "Français", path: "fr/", ogLocale: "fr_FR" },
];
