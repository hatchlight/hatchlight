import {
	createTranslator,
	type Message,
	matchLanguage,
} from "@hatchlight/i18n";
import { latent } from "@hatchlight/motion";
import "./index.css";
import de from "./locales/de.json";
import en from "./locales/en.json";
import es from "./locales/es.json";
import fr from "./locales/fr.json";
import ptBR from "./locales/pt-BR.json";

/**
 * What the desktop app shows while its server starts. The app navigates away
 * once the server is ready, or back here with `?failed=` if it stopped.
 */

const catalogs: Record<string, Partial<Record<keyof typeof en, Message>>> = {
	en: {},
	"pt-BR": ptBR,
	es,
	de,
	fr,
};
const language = matchLanguage(
	navigator.languages ?? [],
	["en", "pt-BR", "es", "de", "fr"],
	"en",
);
const { t } = createTranslator(language, en, catalogs[language]);
document.documentElement.lang = language;

const status = document.getElementById("status") as HTMLElement;
const detail = document.getElementById("detail") as HTMLElement;
const frame = document.getElementById("frame") as HTMLCanvasElement;
status.textContent = t("desktop.starting");

const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
let running = !reduce;
latent(frame, undefined, performance.now());
const draw = (time: number) => {
	if (!running) return;
	latent(frame, undefined, time);
	requestAnimationFrame(draw);
};
if (running) requestAnimationFrame(draw);

const failed = new URLSearchParams(location.search).get("failed");
if (failed != null) {
	running = false;
	status.textContent = t("desktop.failed");
	status.classList.replace("text-dim", "text-danger");
	detail.textContent = failed;
	detail.classList.remove("hidden");
	showRetry();
}

/**
 * "Try again" asks the desktop app to start its server once more, for when
 * what stopped it is gone, such as another Hatchlight using the same data.
 */
function showRetry() {
	const invoke = (
		window as {
			__TAURI__?: { core: { invoke: (command: string) => Promise<unknown> } };
		}
	).__TAURI__?.core.invoke;
	if (!invoke) return;
	const hint = document.getElementById("hint") as HTMLElement;
	const retry = document.getElementById("retry") as HTMLButtonElement;
	hint.textContent = t("desktop.retryHint");
	retry.textContent = t("desktop.retry");
	hint.classList.remove("hidden");
	retry.classList.remove("hidden");
	retry.addEventListener("click", () => {
		retry.disabled = true;
		invoke("restart_server").catch((error: unknown) => {
			detail.textContent = String(error);
			retry.disabled = false;
		});
	});
}
