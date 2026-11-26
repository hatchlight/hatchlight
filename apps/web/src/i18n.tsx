import { storedValue } from "@hatchlight/core/legacy";
import {
	createTranslator,
	type Language,
	type Message,
	matchLanguage,
	type Translator,
} from "@hatchlight/i18n";
import {
	createContext,
	type ReactNode,
	useContext,
	useEffect,
	useMemo,
	useState,
} from "react";
import en from "./locales/en.json";
import ja from "./locales/ja.json";
import ptBR from "./locales/pt-BR.json";

export type MessageKey = Extract<keyof typeof en, string>;

/** Whether the catalog has a message, for keys made from data such as ids. */
export const isMessageKey = (key: string): key is MessageKey => key in en;

const translations: Record<string, Partial<Record<MessageKey, Message>>> = {
	en: {},
	ja,
	"pt-BR": ptBR,
};

export const languages: Language[] = [
	{ code: "en", name: "English" },
	{ code: "pt-BR", name: "Português (Brasil)" },
	{ code: "ja", name: "日本語" },
];

const STORAGE_KEY = "hatchlight.language";
const codes = languages.map((language) => language.code);

function initialLanguage(): string {
	try {
		const saved = storedValue(localStorage, STORAGE_KEY);
		if (saved && codes.includes(saved)) return saved;
	} catch {
		// Storage can be unavailable; fall back to the browser's languages.
	}
	return matchLanguage(navigator.languages ?? [], codes, "en");
}

/** An error to show: English text, and a code when the server knows one. */
export interface Problem {
	message: string;
	code?: string | null;
	params?: Record<string, string | number> | null;
}

export type I18n = Translator<MessageKey> & {
	/** Says an error in the reader's language when its code is known. */
	explain(problem: unknown): string;
	language: string;
	setLanguage(code: string): void;
	languages: Language[];
};

const I18nContext = createContext<I18n | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
	const [language, setLanguageState] = useState(initialLanguage);

	useEffect(() => {
		document.documentElement.lang = language;
	}, [language]);

	const value = useMemo<I18n>(() => {
		const setLanguage = (code: string) => {
			if (!codes.includes(code)) return;
			setLanguageState(code);
			try {
				localStorage.setItem(STORAGE_KEY, code);
			} catch {
				// Storage can be unavailable; the choice then lasts for this visit only.
			}
		};
		const translator = createTranslator(language, en, translations[language]);
		const explain = (problem: unknown): string => {
			if (problem == null) return "";
			const { message, code, params } =
				typeof problem === "object" && "message" in problem
					? (problem as Problem)
					: { message: String(problem), code: null, params: null };
			const key = `errors.${code}`;
			if (!code || !(key in en)) return message;
			// Byte counts arrive raw; show them the way the reader writes sizes.
			const values = Object.fromEntries(
				Object.entries(params ?? {}).map(([name, value]) => [
					name,
					name.endsWith("Bytes") && typeof value === "number"
						? translator.bytes(value)
						: value,
				]),
			);
			return translator.t(key as MessageKey, values);
		};
		return {
			...translator,
			explain,
			language,
			setLanguage,
			languages,
		};
	}, [language]);

	return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18n {
	const value = useContext(I18nContext);
	if (!value) throw new Error("useI18n must be used inside an I18nProvider");
	return value;
}
