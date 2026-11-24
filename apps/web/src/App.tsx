import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { AccountMenu } from "./Accounts";
import { Assistant } from "./Assistant";
import { api } from "./api";
import { Chat } from "./Chat";
import { Gallery } from "./Gallery";
import { useI18n } from "./i18n";
import { useLiveJobs } from "./live";
import { Models } from "./Models";
import { href, navigate, useRoute } from "./route";
import { Settings } from "./Settings";
import { UpdateToast } from "./UpdateToast";

const MAX_REFERENCES = 4;

export function App() {
	useLiveJobs();
	const { t } = useI18n();
	const route = useRoute();
	const client = useQueryClient();
	const sessions = useQuery({ queryKey: ["sessions"], queryFn: api.sessions });
	// Reference images for the next prompt. Lives here so the gallery can add to it.
	const [references, setReferences] = useState<string[]>([]);

	const addReference = (assetId: string) => {
		setReferences((current) =>
			current.includes(assetId)
				? current
				: [...current, assetId].slice(-MAX_REFERENCES),
		);
		// The picture waits in the composer of the advanced view.
		if (route.view !== "chat") navigate(href.newChat);
		else if (route.talk) {
			navigate(route.sessionId ? href.session(route.sessionId) : href.newChat);
		}
	};

	const remove = useMutation({
		mutationFn: api.deleteSession,
		onSuccess: (_, id) => {
			if (route.view === "chat" && route.sessionId === id)
				navigate(href.newChat);
			return client.invalidateQueries({ queryKey: ["sessions"] });
		},
	});

	const active = route.view === "chat" ? route.sessionId : undefined;
	const navLink = (current: boolean) =>
		`relative rounded-md px-3 py-2 text-sm transition-colors before:absolute before:inset-y-2 before:left-0 before:w-0.5 before:rounded before:bg-accent before:transition-opacity ${
			current
				? "bg-line text-ink before:opacity-100"
				: "text-dim before:opacity-0 hover:text-ink"
		}`;
	// Each view comes into the light when it is opened.
	const scene =
		route.view === "chat"
			? `chat/${route.sessionId ?? ""}/${route.talk ? "talk" : ""}`
			: route.view;
	const title = sessions.data?.find((s) => s.id === active)?.title;

	return (
		<div className="flex h-full">
			<UpdateToast />
			<nav className="flex w-60 shrink-0 flex-col border-r border-line bg-panel max-md:hidden">
				<div className="p-4">
					<a
						href={href.newChat}
						className="flex items-center gap-2 font-display text-xl leading-none font-extrabold tracking-tight"
					>
						<i
							aria-hidden="true"
							className="aurora relative size-4 rounded-full shadow-[0_0_14px_rgb(255_61_139/0.5)] after:absolute after:inset-[4px] after:rounded-full after:bg-panel"
						/>
						Hatchlight
					</a>
				</div>
				<div className="flex flex-col gap-1 px-2">
					<a
						href={href.newChat}
						className={navLink(route.view === "chat" && !active)}
					>
						{t("nav.newSession")}
					</a>
					<a href={href.gallery} className={navLink(route.view === "gallery")}>
						{t("nav.gallery")}
					</a>
				</div>
				<div className="mt-4 px-5 font-mono text-[11px] uppercase tracking-wider text-dim">
					{t("nav.sessions")}
				</div>
				<ul className="mt-1 flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2">
					{sessions.data?.map((session) => (
						<li key={session.id} className="group flex items-center">
							<a
								href={
									route.view === "chat" && route.talk
										? href.talk(session.id)
										: href.session(session.id)
								}
								title={session.title}
								className={`min-w-0 flex-1 truncate ${navLink(session.id === active)}`}
							>
								{session.title}
							</a>
							<button
								type="button"
								aria-label={t("nav.deleteSession", { title: session.title })}
								onClick={() => {
									if (window.confirm(t("nav.deleteSessionConfirm"))) {
										remove.mutate(session.id);
									}
								}}
								className="px-2 text-dim opacity-0 hover:text-danger focus-visible:opacity-100 group-hover:opacity-100"
							>
								×
							</button>
						</li>
					))}
					{sessions.data?.length === 0 && (
						<li className="px-3 py-2 text-sm text-dim">
							{t("nav.noSessions")}
						</li>
					)}
				</ul>
				<div className="flex flex-col gap-1 border-t border-line p-2">
					<a href={href.models} className={navLink(route.view === "models")}>
						{t("nav.localModels")}
					</a>
					<a
						href={href.settings}
						className={navLink(route.view === "settings")}
					>
						{t("nav.settings")}
					</a>
					<AccountMenu className="shrink-0 text-xs text-dim hover:text-ink" />
				</div>
			</nav>

			<main key={scene} className="scene-in flex min-w-0 flex-1 flex-col">
				<div className="flex gap-1 border-b border-line bg-panel p-2 md:hidden">
					<a href={href.newChat} className={navLink(route.view === "chat")}>
						{t("nav.session")}
					</a>
					<a href={href.gallery} className={navLink(route.view === "gallery")}>
						{t("nav.gallery")}
					</a>
					<a href={href.models} className={navLink(route.view === "models")}>
						{t("nav.models")}
					</a>
					<a
						href={href.settings}
						className={navLink(route.view === "settings")}
					>
						{t("nav.settings")}
					</a>
				</div>
				{route.view === "chat" && (
					<header className="flex items-center justify-between gap-4 border-b border-line px-6 py-3">
						<h1 className="min-w-0 truncate font-medium">
							{title ?? t("nav.newSession")}
						</h1>
						<div
							role="tablist"
							aria-label={t("session.mode")}
							className="flex shrink-0 gap-1 rounded-lg border border-line p-1"
						>
							{(
								[
									[true, t("session.chat")],
									[false, t("session.advanced")],
								] as const
							).map(([talk, label]) => {
								const selected = route.talk === talk;
								const to = route.sessionId
									? talk
										? href.talk(route.sessionId)
										: href.session(route.sessionId)
									: talk
										? href.newTalk
										: href.newChat;
								return (
									<a
										key={label}
										role="tab"
										aria-selected={selected}
										href={to}
										className={`rounded-md px-4 py-1.5 text-sm transition-colors ${
											selected
												? "aurora font-semibold text-black"
												: "text-dim hover:text-ink"
										}`}
									>
										{label}
									</a>
								);
							})}
						</div>
					</header>
				)}
				{route.view === "chat" && route.talk && (
					<Assistant
						key={route.sessionId ?? "new"}
						sessionId={route.sessionId}
						addReference={addReference}
					/>
				)}
				{route.view === "chat" && !route.talk && (
					<Chat
						key={route.sessionId ?? "new"}
						sessionId={route.sessionId}
						references={references}
						setReferences={setReferences}
						addReference={addReference}
					/>
				)}
				{route.view === "gallery" && <Gallery addReference={addReference} />}
				{route.view === "models" && <Models />}
				{route.view === "settings" && <Settings />}
			</main>
		</div>
	);
}
