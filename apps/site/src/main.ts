import "./styles.css";
import { createTranslator, matchLanguage } from "@hatchlight/i18n";
import { develop, loadImage } from "@hatchlight/motion";
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { LINKS } from "./config";
import { LANGUAGES } from "./languages";
import en from "./locales/en.json";
import es from "./locales/es.json";
import ptBR from "./locales/pt-BR.json";

gsap.registerPlugin(ScrollTrigger);

const $ = <T extends Element = HTMLElement>(
	selector: string,
	root: ParentNode = document,
) => root.querySelector<T>(selector) as T;
const $$ = <T extends Element = HTMLElement>(
	selector: string,
	root: ParentNode = document,
) => [...root.querySelectorAll<T>(selector)];

// The page was rendered in one language; the script speaks the same one.
const CATALOGS: Record<string, Record<string, string>> = {
	en,
	"pt-BR": ptBR,
	es,
};
const language = matchLanguage(
	[document.documentElement.lang],
	LANGUAGES.map((l) => l.code),
	"en",
);
const { t } = createTranslator(language, en, CATALOGS[language]);
type Key = Parameters<typeof t>[0];
/** Where the site's root is, relative to this page. */
const root = document.documentElement.dataset.root ?? "./";

const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
if (!reduceMotion) document.documentElement.classList.add("motion");

/* ---------- links and the download button ---------- */

function visitorSystem(): "Windows" | "macOS" | "Linux" {
	const agent = navigator.userAgent;
	if (/Mac/i.test(agent)) return "macOS";
	if (/Linux|X11/i.test(agent) && !/Android/i.test(agent)) return "Linux";
	return "Windows";
}

for (const link of $$<HTMLAnchorElement>("[data-link]")) {
	const target = LINKS[link.dataset.link as keyof typeof LINKS];
	if (target) {
		link.href = target;
		link.target = "_blank";
		link.rel = "noopener";
	} else {
		link.hidden = true;
	}
}
for (const button of $$<HTMLAnchorElement>("[data-download]")) {
	if (LINKS.releases) {
		button.href = LINKS.releases;
		if (button.dataset.os != null)
			button.textContent = t("runtime.downloadFor", {
				system: visitorSystem(),
			});
	} else if (button.dataset.os != null) {
		button.textContent = t("runtime.comingSoon");
	}
}
if (LINKS.releases) {
	for (const note of $$("[data-released]")) note.hidden = false;
}

/* ---------- picture strips ---------- */

const PICTURES = [
	"ramen",
	"fisherman",
	"whale",
	"astronaut",
	"cabin",
	"dancer",
	"camera",
	"reel",
	"dew",
] as const;

const tracks = $$(".track");
for (const track of tracks) {
	const frames = PICTURES.map(
		(name) =>
			`<figure class="frame"><img src="${root}shots/${name}.webp" alt="" loading="lazy"><figcaption>${t(`reel.${name}` as Key)}</figcaption></figure>`,
	).join("");
	// Twice over, so the loop has no seam.
	track.innerHTML = frames + frames;
}

/* ---------- side by side ---------- */

async function sideBySide(): Promise<void> {
	const section = $("#compare");
	const canvases = $$<HTMLCanvasElement>("canvas[data-develop]", section);
	const images = await Promise.all(
		canvases.map((c) => loadImage(c.dataset.develop as string)),
	);
	const times = $$(".t", section);
	if (reduceMotion) {
		for (const [i, canvas] of canvases.entries()) {
			develop(canvas, images[i] as HTMLImageElement, 1);
		}
		return;
	}

	const typed = $(".typed", section);
	const text = typed.textContent ?? "";
	// At rest the frames show a soft, recognizable picture; scrolling develops it.
	const state = { chars: text.length * 0.25, a: 0.3, b: 0.3 };
	const draw = () => {
		typed.textContent = text.slice(0, Math.round(state.chars));
		develop(
			canvases[0] as HTMLCanvasElement,
			images[0] as HTMLImageElement,
			state.a,
		);
		develop(
			canvases[1] as HTMLCanvasElement,
			images[1] as HTMLImageElement,
			state.b,
		);
		times.forEach((el, i) => {
			const seconds = Number(el.dataset.seconds);
			const p = i === 0 ? state.a : state.b;
			el.textContent = `${((Math.max(0, p - 0.3) / 0.7) * seconds).toFixed(1)}s`;
		});
	};
	draw();
	gsap
		.timeline({
			onUpdate: draw,
			scrollTrigger: {
				trigger: section,
				start: "top 70%",
				end: "bottom 55%",
				scrub: 0.6,
			},
		})
		.to(state, { chars: text.length, duration: 1, ease: "none" })
		// Both models start together; the faster one finishes first.
		.to(state, { a: 1, duration: 1.2, ease: "power2.out" }, ">")
		.to(state, { b: 1, duration: 2.4, ease: "power1.inOut" }, "<");
}

/* ---------- motion ---------- */

function motion(): void {
	// Hero: the title leads; eyebrow, copy and buttons follow as one wave.
	gsap.from(".hero h1 .w", {
		yPercent: 110,
		rotate: 4,
		duration: 1.1,
		ease: "expo.out",
		stagger: { each: 0.09, ease: "power2.in" },
	});
	gsap.from([".eyebrow", ".lede", ".hero .ctas", ".hero .meta"], {
		y: 18,
		autoAlpha: 0,
		duration: 0.8,
		ease: "power3.out",
		delay: 0.35,
		stagger: 0.07,
	});
	gsap.from(".strip", {
		xPercent: (i: number) => (i ? 30 : -30),
		duration: 1.6,
		ease: "expo.out",
		delay: 0.2,
	});

	// The pictures drift on their own and speed up with the scroll.
	const drifts = tracks.map((track) => {
		const forward = Number(track.dataset.direction) < 0;
		return gsap.fromTo(
			track,
			{ xPercent: forward ? 0 : -50 },
			{ xPercent: forward ? -50 : 0, duration: 38, ease: "none", repeat: -1 },
		);
	});
	ScrollTrigger.create({
		start: 0,
		end: "max",
		onUpdate: (self) => {
			const boost = 1 + Math.min(6, Math.abs(self.getVelocity()) / 300);
			for (const drift of drifts) {
				gsap.to(drift, {
					timeScale: boost,
					duration: 0.3,
					overwrite: true,
					onComplete: () => {
						gsap.to(drift, { timeScale: 1, duration: 1.2 });
					},
				});
			}
		},
	});

	// The spec card reads the machine: names type in, the memory bar fills.
	const spec = $(".spec");
	const typedValues = $$("[data-type]", spec).map((el) => ({
		el,
		text: el.textContent ?? "",
	}));
	gsap
		.timeline({ scrollTrigger: { trigger: spec, start: "top 75%" } })
		.from(spec, { y: 40, rotate: 1.5, duration: 0.9, ease: "expo.out" })
		.from(".vram i", { scaleX: 0, duration: 1, ease: "power2.out" }, 0.2)
		.add(() => {
			for (const { el, text } of typedValues) {
				const state = { n: 0 };
				gsap.to(state, {
					n: text.length,
					duration: 0.8,
					ease: "none",
					onUpdate: () => {
						el.textContent = text.slice(0, Math.round(state.n));
					},
				});
			}
		}, 0.1)
		.from(
			".picks li",
			{
				x: 24,
				autoAlpha: 0,
				duration: 0.5,
				ease: "power3.out",
				stagger: { each: 0.08, ease: "power1.in" },
			},
			0.6,
		);

	// Gallery: pictures sharpen as they scroll into view.
	for (const figure of $$(".sheet figure")) {
		ScrollTrigger.create({
			trigger: figure,
			start: "top 82%",
			once: true,
			onEnter: () => figure.classList.add("sharp"),
		});
	}

	// The step numbers count up.
	for (const number of $$(".steps b")) {
		const target = Number(number.textContent);
		const state = { n: 0 };
		gsap.to(state, {
			n: target,
			duration: 0.8,
			ease: "power1.out",
			scrollTrigger: { trigger: ".steps", start: "top 80%" },
			onUpdate: () => {
				number.textContent = String(Math.round(state.n));
			},
		});
	}

	gsap.from(".providers li", {
		y: 20,
		autoAlpha: 0,
		duration: 0.6,
		ease: "back.out(1.8)",
		stagger: 0.06,
		scrollTrigger: { trigger: ".providers", start: "top 85%" },
	});
}

if (!reduceMotion) motion();
void sideBySide();
