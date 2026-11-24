/**
 * Some models read prompts well only in English (their text encoder is CLIP
 * or T5). A prompt written in another language is put into English for them
 * first, by a small language model: one running on this computer, or one
 * reached with the person's own key.
 */
export interface Translator {
	/**
	 * The prompt in English, or the same text when it already is. Rejects
	 * when it cannot translate now; the prompt is then sent as written.
	 */
	toEnglish(prompt: string, signal: AbortSignal): Promise<string>;
}

/** What a language model is told, to translate a prompt and nothing more. */
export const TRANSLATE_INSTRUCTIONS = [
	"You translate prompts for an image and video generator into English.",
	"Translate word for word, as literally as reads naturally: do not add words, adjectives or details, and do not leave any out.",
	"Keep every color, number and detail exactly as given, in the same order.",
	"Keep names, brands and any text in quotes exactly as written: the quoted text is meant to appear in the picture.",
	"Reply with the English prompt only: no notes, no quotes around it, no explanations.",
	"If the prompt is already in English, reply with it unchanged.",
	'Example: "um carro azul numa rua molhada à noite" becomes "a blue car on a wet street at night".',
].join(" ");

/**
 * Whether a translation says the same as the prompt, but for case, spaces
 * and punctuation: a prompt that was already in English.
 */
export function sameWords(a: string, b: string): boolean {
	const words = (text: string) =>
		text
			.toLowerCase()
			.replace(/[^\p{L}\p{N}]+/gu, " ")
			.trim();
	return words(a) === words(b);
}

/** Small words that only English uses among the languages people write prompts in. */
const ENGLISH_WORDS = new Set([
	"the",
	"of",
	"with",
	"and",
	"an",
	"from",
	"is",
	"are",
	"by",
	"at",
	"to",
	"for",
	"under",
	"over",
	"into",
	"through",
	"its",
	"their",
	"wearing",
	"holding",
]);

/**
 * Small words of other languages that a prompt written without accents
 * still has: Portuguese, Spanish, French, German and Italian.
 */
const OTHER_WORDS = new Set([
	"um",
	"uma",
	"com",
	"em",
	"na",
	"nas",
	"nos",
	"da",
	"das",
	"dos",
	"de",
	"para",
	"por",
	"pela",
	"pelo",
	"e",
	"el",
	"los",
	"las",
	"del",
	"con",
	"una",
	"y",
	"le",
	"les",
	"des",
	"du",
	"une",
	"et",
	"avec",
	"sur",
	"dans",
	"der",
	"und",
	"mit",
	"ein",
	"eine",
	"im",
	"auf",
	"il",
	"della",
	"uno",
	"nel",
]);

/**
 * Whether a prompt is plainly in English already, so it needs no translator:
 * no letters outside English, and English's small words but no other
 * language's. When unsure it says no, and the translator decides.
 */
export function plainlyEnglish(prompt: string): boolean {
	// Printable ASCII and spaces only: an accent says another language.
	if (/[^ -~\s]/.test(prompt)) return false;
	const words = prompt.toLowerCase().match(/[a-z]+/g) ?? [];
	return (
		words.some((word) => ENGLISH_WORDS.has(word)) &&
		!words.some((word) => OTHER_WORDS.has(word))
	);
}

/**
 * The reply without its <think>…</think> blocks. Scanned by hand, where a
 * regular expression would take quadratic time on many unclosed <think>.
 */
function withoutReasoning(reply: string): string {
	const open = "<think>";
	const close = "</think>";
	let kept = "";
	let from = 0;
	for (;;) {
		const start = reply.indexOf(open, from);
		const end = start < 0 ? -1 : reply.indexOf(close, start + open.length);
		if (end < 0) return kept + reply.slice(from);
		kept += reply.slice(from, start);
		from = end + close.length;
	}
}

/**
 * The translation from a language model's reply: without the reasoning some
 * models write first, a label such as "Translation:", or quotes around it.
 */
export function cleanTranslation(reply: string): string {
	let text = withoutReasoning(reply).trim();
	text = text.replace(/^(english|translation|prompt)\s*:\s*/i, "").trim();
	const quoted = text.match(/^["“'«](.*)["”'»]$/s);
	if (quoted?.[1] && !/["“”«»]/.test(quoted[1])) text = quoted[1].trim();
	return text;
}
