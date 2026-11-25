import { parseHubLink } from "@hatchlight/core/hugging-face";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	Cpu,
	Images,
	MessageSquare,
	MoreHorizontal,
	Plus,
	Settings as SettingsIcon,
	Trash2,
} from "lucide-react";
import { lazy, Suspense, useEffect, useState } from "react";
import { Logo, Mark } from "@/components/Logo";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
	Sidebar,
	SidebarContent,
	SidebarFooter,
	SidebarGroup,
	SidebarGroupContent,
	SidebarGroupLabel,
	SidebarHeader,
	SidebarInset,
	SidebarMenu,
	SidebarMenuAction,
	SidebarMenuButton,
	SidebarMenuItem,
	SidebarProvider,
	SidebarRail,
	SidebarTrigger,
	useSidebar,
} from "@/components/ui/sidebar";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { AccountMenu } from "./Accounts";
import { api } from "./api";
import { Chat } from "./Chat";
import { onLinks } from "./desktop";
import { useI18n } from "./i18n";
import { KeysLostToast } from "./KeysLostToast";
import { useLiveJobs } from "./live";
import { href, navigate, type Route, useRoute } from "./route";
import { UpdateToast } from "./UpdateToast";

const MAX_REFERENCES = 4;

// Views loaded when first opened, so the app starts with less to read.
const Assistant = lazy(() =>
	import("./Assistant").then((m) => ({ default: m.Assistant })),
);
const Gallery = lazy(() =>
	import("./Gallery").then((m) => ({ default: m.Gallery })),
);
const Models = lazy(() =>
	import("./Models").then((m) => ({ default: m.Models })),
);
const HubOpen = lazy(() =>
	import("./HubOpen").then((m) => ({ default: m.HubOpen })),
);
const Settings = lazy(() =>
	import("./Settings").then((m) => ({ default: m.Settings })),
);

function sidebarStartsOpen(): boolean {
	try {
		return localStorage.getItem("hatchlight.sidebar") !== "false";
	} catch {
		return true;
	}
}

export function App() {
	useLiveJobs();
	const route = useRoute();
	// The desktop app was opened with a link, such as from Hugging Face.
	useEffect(
		() =>
			onLinks((link) => {
				const target = parseHubLink(link);
				navigate(target ? href.hub(target) : href.hubInvalid);
			}),
		[],
	);
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

	// Each view comes into the light when it is opened.
	const scene =
		route.view === "chat"
			? `chat/${route.sessionId ?? ""}/${route.talk ? "talk" : ""}`
			: // A repository opens over the models, which stay as they were.
				route.view === "hub"
				? "models"
				: route.view;

	return (
		// Fits the space it is given: a server's notices may sit above it.
		<SidebarProvider
			defaultOpen={sidebarStartsOpen()}
			className="relative h-full min-h-0"
		>
			<UpdateToast />
			<KeysLostToast />
			<AppSidebar route={route} />
			<SidebarInset className="min-h-0 overflow-hidden bg-bg">
				{route.view === "chat" ? (
					<SessionHeader route={route} />
				) : (
					<MobileBar />
				)}
				<div
					key={scene}
					className="scene-in flex min-h-0 flex-1 flex-col max-md:pb-[4.25rem]"
				>
					<Suspense fallback={null}>
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
						{route.view === "gallery" && (
							<Gallery addReference={addReference} />
						)}
						{route.view === "models" && <Models focus={route.focus} />}
						{route.view === "hub" && (
							<>
								<Models />
								<HubOpen target={route.target} />
							</>
						)}
						{route.view === "settings" && <Settings />}
					</Suspense>
				</div>
				<BottomNav route={route} />
			</SidebarInset>
		</SidebarProvider>
	);
}

/** Sessions and the places of the app: a column on wide screens, a drawer on phones. */
function AppSidebar({ route }: { route: Route }) {
	const { t } = useI18n();
	const client = useQueryClient();
	const { isMobile, setOpenMobile } = useSidebar();
	const sessions = useQuery({ queryKey: ["sessions"], queryFn: api.sessions });
	const [deleting, setDeleting] = useState<{ id: string; title: string }>();
	const active = route.view === "chat" ? route.sessionId : undefined;
	// On a phone the drawer closes once a place is chosen.
	const close = () => {
		if (isMobile) setOpenMobile(false);
	};

	const remove = useMutation({
		mutationFn: api.deleteSession,
		onSuccess: (_, id) => {
			if (route.view === "chat" && route.sessionId === id)
				navigate(href.newChat);
			return client.invalidateQueries({ queryKey: ["sessions"] });
		},
	});

	const places = [
		{
			to: href.gallery,
			label: t("nav.gallery"),
			icon: Images,
			current: route.view === "gallery",
		},
		{
			to: href.models,
			label: t("nav.localModels"),
			icon: Cpu,
			current: route.view === "models" || route.view === "hub",
		},
	];

	return (
		<>
			<Sidebar
				collapsible="icon"
				role="navigation"
				aria-label={t("ui.menu")}
				// Held within the app, not the window: a server's notice above
				// it, such as the unencrypted-connection banner, stays in view.
				className="absolute h-full border-sidebar-border"
			>
				<SidebarHeader className="gap-4 p-4 group-data-[collapsible=icon]:px-2">
					<a
						href={href.newChat}
						onClick={close}
						className="flex items-center rounded-lg px-1 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0"
					>
						<Logo
							crack="var(--rail)"
							className="group-data-[collapsible=icon]:hidden"
						/>
						<Mark
							crack="var(--rail)"
							label="Hatchlight"
							className="hidden group-data-[collapsible=icon]:block"
						/>
					</a>
					<SidebarMenu>
						<SidebarMenuItem className="mb-2">
							<SidebarMenuButton
								tooltip={t("nav.newSession")}
								onClick={close}
								render={<a href={href.newChat} />}
								className="cta h-11 justify-center rounded-xl font-semibold text-on-aurora hover:text-on-aurora active:text-on-aurora data-active:text-on-aurora group-data-[collapsible=icon]:size-10!"
							>
								<Plus className="size-[18px]!" strokeWidth={2.4} />
								<span>{t("nav.newSession")}</span>
							</SidebarMenuButton>
						</SidebarMenuItem>
						{places.map((place) => (
							<SidebarMenuItem key={place.to}>
								<SidebarMenuButton
									tooltip={place.label}
									isActive={place.current}
									onClick={close}
									render={<a href={place.to} />}
									className="h-10 rounded-lg"
								>
									<place.icon />
									<span>{place.label}</span>
								</SidebarMenuButton>
							</SidebarMenuItem>
						))}
					</SidebarMenu>
				</SidebarHeader>
				<SidebarContent>
					<SidebarGroup className="px-4 group-data-[collapsible=icon]:px-2">
						<SidebarGroupLabel className="font-mono text-[11px] tracking-[0.14em] text-dim uppercase">
							{t("nav.sessions")}
						</SidebarGroupLabel>
						<SidebarGroupContent>
							<SidebarMenu>
								{sessions.data?.map((session) => (
									<SidebarMenuItem key={session.id}>
										<SidebarMenuButton
											isActive={session.id === active}
											onClick={close}
											render={
												<a
													href={
														route.view === "chat" && route.talk
															? href.talk(session.id)
															: href.session(session.id)
													}
													title={session.title}
													aria-current={
														session.id === active ? "page" : undefined
													}
												/>
											}
											className="h-10 rounded-lg data-active:shadow-[inset_0_0_0_1px_#2c2c32]"
										>
											<span className="truncate">{session.title}</span>
										</SidebarMenuButton>
										<DropdownMenu>
											<DropdownMenuTrigger
												render={
													<SidebarMenuAction
														showOnHover
														className="top-2"
														aria-label={t("nav.sessionActions", {
															title: session.title,
														})}
													/>
												}
											>
												<MoreHorizontal />
											</DropdownMenuTrigger>
											<DropdownMenuContent side="right" align="start">
												<DropdownMenuItem
													variant="destructive"
													onClick={() =>
														setDeleting({
															id: session.id,
															title: session.title,
														})
													}
												>
													<Trash2 />
													{t("nav.delete")}
												</DropdownMenuItem>
											</DropdownMenuContent>
										</DropdownMenu>
									</SidebarMenuItem>
								))}
								{sessions.data?.length === 0 && (
									<li className="px-2 py-2 text-sm text-dim group-data-[collapsible=icon]:hidden">
										{t("nav.noSessions")}
									</li>
								)}
							</SidebarMenu>
						</SidebarGroupContent>
					</SidebarGroup>
				</SidebarContent>
				<SidebarFooter className="p-4 group-data-[collapsible=icon]:px-2">
					<SidebarMenu>
						<SidebarMenuItem>
							<SidebarMenuButton
								tooltip={t("nav.settings")}
								isActive={route.view === "settings"}
								onClick={close}
								render={<a href={href.settings} />}
								className="h-10 rounded-lg"
							>
								<SettingsIcon />
								<span>{t("nav.settings")}</span>
							</SidebarMenuButton>
						</SidebarMenuItem>
					</SidebarMenu>
					{/* Who is signed in, on a server shared by several people. */}
					<div className="group-data-[collapsible=icon]:hidden">
						<AccountMenu className="shrink-0 rounded-md px-2 py-1 text-xs text-dim hover:text-ink" />
					</div>
				</SidebarFooter>
				<SidebarRail />
			</Sidebar>

			<AlertDialog
				open={deleting !== undefined}
				onOpenChange={(open) => {
					if (!open) setDeleting(undefined);
				}}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>
							{t("nav.deleteSession", { title: deleting?.title ?? "" })}
						</AlertDialogTitle>
						<AlertDialogDescription>
							{t("nav.deleteSessionConfirm")}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>{t("nav.cancel")}</AlertDialogCancel>
						<AlertDialogAction
							variant="destructive"
							onClick={() => {
								if (deleting) remove.mutate(deleting.id);
								setDeleting(undefined);
							}}
						>
							{t("nav.delete")}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</>
	);
}

/** A session's name and the switch between talking and the advanced view. */
function SessionHeader({ route }: { route: Extract<Route, { view: "chat" }> }) {
	const { t } = useI18n();
	const sessions = useQuery({ queryKey: ["sessions"], queryFn: api.sessions });
	const title = sessions.data?.find((s) => s.id === route.sessionId)?.title;
	const go = (talk: boolean) =>
		navigate(
			route.sessionId
				? talk
					? href.talk(route.sessionId)
					: href.session(route.sessionId)
				: talk
					? href.newTalk
					: href.newChat,
		);

	return (
		<header className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-3 border-b border-[#1a1a1e] px-4 py-3 md:h-[4.75rem] md:flex-nowrap md:px-8 md:py-0">
			<SidebarTrigger className="size-11 rounded-xl border border-line bg-panel md:size-9 md:border-0 md:bg-transparent" />
			<h1 className="min-w-0 flex-1 truncate font-display text-[22px] font-bold tracking-[-0.02em] md:text-[26px]">
				{title ?? t("nav.newSession")}
			</h1>
			<Tabs
				value={route.talk ? "talk" : "advanced"}
				onValueChange={(value) => go(value === "talk")}
				className="max-md:w-full"
			>
				<TabsList aria-label={t("session.mode")} className="max-md:w-full">
					<TabsTrigger value="talk">{t("session.chat")}</TabsTrigger>
					<TabsTrigger value="advanced">{t("session.advanced")}</TabsTrigger>
				</TabsList>
			</Tabs>
		</header>
	);
}

/** On phones, outside a session: the menu button and the logo. */
function MobileBar() {
	return (
		<div className="flex items-center gap-3 border-b border-[#1a1a1e] px-4 py-3 md:hidden">
			<SidebarTrigger className="size-11 rounded-xl border border-line bg-panel" />
			<Logo />
		</div>
	);
}

/** The places of the app, under the thumb on phones. */
function BottomNav({ route }: { route: Route }) {
	const { t } = useI18n();
	const items = [
		{
			to: href.newChat,
			label: t("nav.session"),
			icon: MessageSquare,
			current: route.view === "chat",
		},
		{
			to: href.gallery,
			label: t("nav.gallery"),
			icon: Images,
			current: route.view === "gallery",
		},
		{
			to: href.models,
			label: t("nav.models"),
			icon: Cpu,
			current: route.view === "models" || route.view === "hub",
		},
		{
			to: href.settings,
			label: t("nav.settings"),
			icon: SettingsIcon,
			current: route.view === "settings",
		},
	];
	return (
		<nav
			aria-label={t("nav.main")}
			className="fixed inset-x-0 bottom-0 z-30 grid h-[4.25rem] grid-cols-4 border-t border-sidebar-border bg-rail/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden"
		>
			{items.map((item) => (
				<a
					key={item.to}
					href={item.to}
					aria-current={item.current ? "page" : undefined}
					className={cn(
						"flex flex-col items-center justify-center gap-1 text-[11px]",
						item.current ? "text-ink" : "text-dim",
					)}
				>
					<item.icon className="size-[22px]" strokeWidth={1.8} />
					{item.label}
					<span
						aria-hidden="true"
						className={cn(
							"h-[3px] w-[18px] rounded-full",
							item.current && "aurora",
						)}
					/>
				</a>
			))}
		</nav>
	);
}
