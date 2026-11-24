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

/**
 * English's small words, which make up much of any English sentence: a
 * prompt needs a few of them to count as English.
 */
const ENGLISH_GLUE = new Set(
	(
		"a an the of in on at to by for with and or from into onto over under " +
		"near behind above below through across between while is are was its " +
		"his her their this that these those wearing holding"
	).split(" "),
);

/**
 * Words of up to three letters that English prompts use. A short word not
 * here is most often another language's ("sob", "het", "een", "bir", "sa"),
 * so the prompt goes to the translator.
 */
const ENGLISH_SHORT = new Set(
	(
		"a an the of in on at to by for and or as is are was be it its his her " +
		"he she we you they him our my me up out off all one two six ten few " +
		"new old big red tan sky sun sea day man men boy guy cat dog fox owl " +
		"cow pig bee ant bug hat cap car bus van toy box cup mug pot pan jar " +
		"bed rug map pen key art oil ink eye ear arm leg lip toe fur ice fog " +
		"mud air sad mad shy wet dry hot raw low far top end way set mix no " +
		"not but how who why yet now fly run sit see led tv pc hd " +
		"uhd hdr rgb pov bw dof cg cgi ai ui gui " +
		// What follows an apostrophe: cat's, don't, we're.
		"s t d ll re ve m"
	).split(" "),
);

/**
 * Small words of other languages that are longer than three letters, which
 * a prompt written without accents still has.
 */
const OTHER_WORDS = new Set(
	(
		"para pela pelo pelas pelos uma umas sobre entre avec dans sous pour " +
		"eine einer einem einen della dello degli nella sulla unos unas desde"
	).split(" "),
);

/**
 * Whether a prompt is plainly in English already, so it needs no translator.
 * Its words of up to three letters must all be English, at least two of its
 * words must be English's small connecting words, and they must be a fair
 * share of it. When unsure it says no, and the translator decides: sending
 * another language to a model that reads only English is the costly mistake.
 */
export function plainlyEnglish(prompt: string): boolean {
	// Phone keyboards type curly apostrophes and quotes.
	const text = prompt.toLowerCase().replace(/[\u2018\u2019\u201C\u201D]/g, "'");
	// Printable ASCII and spaces only: an accent says another language.
	if (/[^ -~\s]/.test(text)) return false;
	// Words with digits, such as 85mm or 1024px, say nothing of the language.
	const words = (text.match(/[a-z0-9]+/g) ?? []).filter((w) => !/\d/.test(w));
	if (words.some((w) => w.length <= 3 && !ENGLISH_SHORT.has(w))) return false;
	if (words.some((w) => OTHER_WORDS.has(w))) return false;
	const glue = words.filter((w) => ENGLISH_GLUE.has(w)).length;
	return glue >= 2 && glue / words.length >= 0.2;
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
