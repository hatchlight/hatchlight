import { describe, expect, test } from "bun:test";
import { cleanTranslation, plainlyEnglish, sameWords } from "./translate";

describe("a prompt plainly in English", () => {
	test("is told apart from one the translator must read", () => {
		for (const english of [
			"A cozy ramen shop on a rainy night, neon reflections on the street",
			"a red fox curled up in the snow",
			"portrait of an old fisherman, 85mm",
			"the cat’s red hat on a wooden table",
		]) {
			expect(plainlyEnglish(english)).toBe(true);
		}
		for (const other of [
			"uma raposa vermelha na neve",
			"um gato preto com chapeu",
			"café à noite",
			"un zorro rojo en la nieve con luz de la manana",
			"ein roter Fuchs im Schnee",
			"cyberpunk city, neon, rain",
			"gato fofo usando chapeu, estilo pixar, by greg rutkowski",
			"menina sob a chuva at night, cinematic",
			"isang pusa at aso sa bubong",
			"beyaz bir at",
			"het huis is groot",
			"een kat of een hond",
			"en katt under bordet",
			"kot to zwierze",
			"gatto nero in cucina a mezzanotte",
			"cachorro correndo a praia, estilo anime, by pixar",
			"",
		]) {
			expect(plainlyEnglish(other)).toBe(false);
		}
	});
});

describe("a translation that says the same as its prompt", () => {
	test("differs only in case, spaces or punctuation", () => {
		expect(
			sameWords(
				"a red fox curled up in fresh snow",
				"A red fox curled up in fresh snow.",
			),
		).toBe(true);
		expect(sameWords("uma raposa", "a fox")).toBe(false);
		expect(sameWords("café, à noite", "Café à noite")).toBe(true);
	});
});

describe("a translation as a language model replies it", () => {
	test("is taken without what models add around it", () => {
		expect(cleanTranslation("a red fox in the snow")).toBe(
			"a red fox in the snow",
		);
		expect(cleanTranslation("  Translation: a red fox \n")).toBe("a red fox");
		expect(cleanTranslation('"a red fox"')).toBe("a red fox");
		expect(cleanTranslation("«une renarde rousse»")).toBe("une renarde rousse");
		expect(
			cleanTranslation("<think>\nThe user wants…\n</think>\n\na fox"),
		).toBe("a fox");
	});

	test("drops every closed reasoning block and keeps an unclosed one", () => {
		expect(
			cleanTranslation("<think>a</think>a <think>b</think>fox<think>"),
		).toBe("a fox<think>");
	});

	test("a reply full of unclosed reasoning is read in linear time", () => {
		const reply = "<think>".repeat(50_000);
		const started = performance.now();
		expect(cleanTranslation(reply)).toBe(reply);
		expect(performance.now() - started).toBeLessThan(500);
	});

	test("keeps quotes that belong to the prompt", () => {
		expect(cleanTranslation('a sign that says "OPEN"')).toBe(
			'a sign that says "OPEN"',
		);
		expect(cleanTranslation('"OPEN" written on "the door"')).toBe(
			'"OPEN" written on "the door"',
		);
	});
});
