import type { Media } from "@hatchlight/core/types";
import { useQuery } from "@tanstack/react-query";
import { type CSSProperties, useState } from "react";
import { Mark } from "@/components/Logo";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, useDemo } from "./api";
import { type Draft, rememberModels } from "./Composer";
import { useI18n } from "./i18n";
import { Picker } from "./Picker";

/** Writes the first prompt, once a model is ready. */
function FirstPrompt(props: {
	modelId: string;
	busy: boolean;
	error: string | null;
	onSubmit(draft: Draft): void;
}) {
	const { t } = useI18n();
	// Prompts that work on any model, with the short label each chip shows.
	const suggestions = [
		{
			prompt: t("welcome.suggestion.fox"),
			label: t("welcome.suggestion.fox.short"),
		},
		{
			prompt: t("welcome.suggestion.lighthouse"),
			label: t("welcome.suggestion.lighthouse.short"),
		},
		{
			prompt: t("welcome.suggestion.ramen"),
			label: t("welcome.suggestion.ramen.short"),
		},
		{
			prompt: t("welcome.suggestion.city"),
			label: t("welcome.suggestion.city.short"),
		},
	];
	const [prompt, setPrompt] = useState(() => suggestions[0]?.prompt ?? "");
	const canSend = prompt.trim() !== "" && !props.busy;
	const send = () => {
		if (!canSend) return;
		// The composer carries on with the same model afterwards.
		rememberModels([props.modelId]);
		props.onSubmit({
			prompt: prompt.trim(),
			modelIds: [props.modelId],
			count: 1,
		});
	};

	return (
		<form
			className="flex flex-col gap-3"
			onSubmit={(event) => {
				event.preventDefault();
				send();
			}}
		>
			<div className="flex flex-wrap gap-2 rounded-[22px] border border-[#2c2c32] bg-panel p-2 pl-4 focus-within:border-orange/50">
				<Input
					value={prompt}
					onChange={(event) => setPrompt(event.target.value)}
					aria-label={t("welcome.prompt")}
					placeholder={t("welcome.prompt")}
					className="h-12 min-w-0 flex-[1_1_16rem] border-0 bg-transparent px-0 text-base focus-visible:ring-0 md:text-base dark:bg-transparent"
				/>
				<Button
					type="submit"
					variant="aurora"
					disabled={!canSend}
					className="h-12 px-6 text-[15px] max-sm:w-full"
				>
					{props.busy ? t("welcome.generating") : t("welcome.generate")}
				</Button>
			</div>
			<div className="flex flex-wrap gap-2">
				{suggestions.map((suggestion) => (
					<Button
						key={suggestion.prompt}
						type="button"
						variant="outline"
						aria-pressed={prompt === suggestion.prompt}
						onClick={() => setPrompt(suggestion.prompt)}
						className="h-10 rounded-full px-4 text-soft aria-pressed:border-ink aria-pressed:text-ink dark:bg-panel"
					>
						{suggestion.label}
					</Button>
				))}
			</div>
			{props.error && <p className="text-sm text-danger">{props.error}</p>}
		</form>
	);
}

/**
 * The first screen a new user sees: choose a model, seeing how they differ
 * and which runs best here, then generate a first picture. Everything after
 * that happens in a normal session.
 */
export function Welcome(props: {
	busy: boolean;
	error: string | null;
	onSubmit(draft: Draft): void;
	onSkip(): void;
}) {
	const { t } = useI18n();
	const [media, setMedia] = useState<Media>("image");
	// A visitor of a public demo has its one model, on the demo's server:
	// nothing of this computer to show, and nothing else to choose.
	if (useDemo()) return <DemoWelcome {...props} />;

	return (
		<div className="relative flex flex-col gap-10 py-6 md:py-12">
			<div className="sky" aria-hidden="true" />
			<header className="rise-in relative flex flex-col items-start gap-5">
				<Mark className="h-14 md:h-16" />
				<h1 className="max-w-[16ch] font-display text-[44px] leading-[0.95] font-extrabold tracking-[-0.03em] text-balance sm:text-7xl">
					{t("welcome.title")}{" "}
					<span className="text-soft">{t("welcome.titleAccent")}</span>
				</h1>
				<p className="max-w-[58ch] text-[17px] leading-relaxed text-soft">
					{t("welcome.lede")}
				</p>
			</header>

			<div className="relative">
				<Picker
					media={media}
					setMedia={setMedia}
					ready={(modelId) => (
						<FirstPrompt
							modelId={modelId}
							busy={props.busy}
							error={props.error}
							onSubmit={props.onSubmit}
						/>
					)}
				/>
			</div>

			<Button
				variant="link"
				onClick={props.onSkip}
				className="rise-in relative h-10 self-start px-0 text-dim decoration-line-strong underline-offset-4 hover:text-ink"
				style={{ "--i": 8 } as CSSProperties}
			>
				{t("welcome.skip")}
			</Button>
		</div>
	);
}

/** The first screen of a public demo: straight to a prompt for its model. */
function DemoWelcome(props: {
	busy: boolean;
	error: string | null;
	onSubmit(draft: Draft): void;
	onSkip(): void;
}) {
	const { t } = useI18n();
	const models = useQuery({ queryKey: ["models"], queryFn: api.models });
	const model = models.data?.[0];

	return (
		<div className="relative flex flex-col gap-10 py-6 md:py-12">
			<div className="sky" aria-hidden="true" />
			<header className="rise-in relative flex flex-col items-start gap-5">
				<Mark className="h-14 md:h-16" />
				<h1 className="max-w-[16ch] font-display text-[44px] leading-[0.95] font-extrabold tracking-[-0.03em] text-balance sm:text-7xl">
					{t("demo.welcomeTitle")}{" "}
					<span className="text-soft">{t("demo.welcomeTitleAccent")}</span>
				</h1>
				{!models.isPending && (
					<p className="max-w-[58ch] text-[17px] leading-relaxed text-soft">
						{model
							? t("demo.welcomeLede", { model: model.name })
							: t("demo.modelNotReady")}
					</p>
				)}
			</header>

			{model && (
				<div className="rise-in relative flex flex-col gap-3 rounded-2xl border border-line-strong bg-panel/90 p-4">
					<p className="font-display text-lg font-bold tracking-tight">
						{t("picker.readyWith", { model: model.name })}
					</p>
					<FirstPrompt
						modelId={model.id}
						busy={props.busy}
						error={props.error}
						onSubmit={props.onSubmit}
					/>
				</div>
			)}

			{model && (
				<Button
					variant="link"
					onClick={props.onSkip}
					className="rise-in relative h-10 self-start px-0 text-dim decoration-line-strong underline-offset-4 hover:text-ink"
				>
					{t("welcome.skip")}
				</Button>
			)}
		</div>
	);
}
