import type { GalleryItem } from "@hatchlight/core/types";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { PlayIcon, SearchIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Mark } from "@/components/Logo";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, assetUrl, GALLERY_PAGE } from "./api";
import { useI18n } from "./i18n";
import { Lightbox, type LightboxItem } from "./Lightbox";

export function Gallery({
	addReference,
}: {
	addReference(assetId: string): void;
}) {
	const { t, explain } = useI18n();
	const [input, setInput] = useState("");
	const [query, setQuery] = useState("");
	const [open, setOpen] = useState<LightboxItem | null>(null);
	const models = useQuery({ queryKey: ["models"], queryFn: api.models });
	const end = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const timer = setTimeout(() => setQuery(input.trim()), 250);
		return () => clearTimeout(timer);
	}, [input]);

	const pages = useInfiniteQuery({
		queryKey: ["gallery", query],
		queryFn: ({ pageParam }) => api.gallery(query, pageParam),
		initialPageParam: undefined as GalleryItem | undefined,
		getNextPageParam: (last) =>
			last.length < GALLERY_PAGE ? undefined : last.at(-1),
	});
	const items = pages.data?.pages.flat() ?? [];
	const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings });
	// A blind comparison not picked yet keeps its models unnamed here too.
	const modelName = (item: GalleryItem) =>
		!item.modelId || (item.unpicked && settings.data?.blindPicks)
			? null
			: (models.data?.find((m) => m.id === item.modelId)?.name ?? item.modelId);

	// The next page loads as the end of the grid comes near; the button
	// below stays for keyboards and for browsers that never report it.
	const {
		hasNextPage,
		isFetchingNextPage,
		isFetchNextPageError,
		fetchNextPage,
	} = pages;
	useEffect(() => {
		const element = end.current;
		// After a failed page only the button tries again, never a loop.
		if (!element || !hasNextPage || isFetchingNextPage || isFetchNextPageError)
			return;
		const watcher = new IntersectionObserver(
			([seen]) => {
				if (seen?.isIntersecting) fetchNextPage();
			},
			{ rootMargin: "600px 0px" },
		);
		watcher.observe(element);
		return () => watcher.disconnect();
	}, [hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage]);

	return (
		<div className="min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-8 sm:py-10">
			<div className="mx-auto max-w-[96rem]">
				<header className="flex flex-wrap items-end justify-between gap-4">
					<h1 className="font-display text-4xl leading-none font-extrabold tracking-tight sm:text-5xl">
						{t("gallery.title")}
					</h1>
					<div className="relative w-full sm:w-80">
						<SearchIcon
							aria-hidden="true"
							className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-dim"
						/>
						<Input
							type="search"
							value={input}
							onChange={(event) => setInput(event.target.value)}
							placeholder={t("gallery.search")}
							aria-label={t("gallery.search")}
							className="h-11 rounded-xl bg-panel pl-9"
						/>
					</div>
				</header>
				{pages.error && (
					<p className="mt-6 text-sm text-danger" role="alert">
						{explain(pages.error)}
					</p>
				)}
				{pages.isSuccess &&
					items.length === 0 &&
					(query ? (
						<p className="mt-20 text-center text-dim">
							{t("gallery.noMatches", { query })}
						</p>
					) : (
						<div className="scene-in mx-auto mt-20 flex max-w-md flex-col items-center gap-4 text-center">
							<Mark className="h-20" />
							<h2 className="font-display text-3xl font-bold tracking-tight">
								{t("gallery.emptyTitle")}
							</h2>
							<p className="text-dim">{t("gallery.empty")}</p>
						</div>
					))}
				<ul className="mt-8 grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6">
					{items.map((item) => {
						const video = item.mime.startsWith("video/");
						const model = modelName(item);
						return (
							<li key={item.id}>
								<button
									type="button"
									title={item.prompt ?? undefined}
									onClick={() =>
										setOpen({
											assetId: item.id,
											mime: item.mime,
											prompt: item.prompt,
											modelName: model,
											params: item.params,
											costUsd: null,
										})
									}
									className="group flex w-full flex-col gap-2 rounded-xl text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
								>
									{video ? (
										<video
											src={assetUrl(item.id)}
											aria-label={item.prompt ?? t("gallery.generatedVideo")}
											muted
											playsInline
											preload="metadata"
											className="aspect-square w-full rounded-xl bg-panel object-cover transition-opacity group-hover:opacity-85"
										/>
									) : (
										<img
											src={assetUrl(item.id)}
											alt={item.prompt ?? t("common.generatedImage")}
											loading="lazy"
											className="aspect-square w-full rounded-xl bg-panel object-cover transition-opacity group-hover:opacity-85"
										/>
									)}
									{(model || video) && (
										<span className="flex items-center justify-between gap-2 px-0.5 font-mono text-xs text-dim">
											<span className="truncate">{model}</span>
											{video && (
												<span className="inline-flex shrink-0 items-center gap-1 uppercase">
													<PlayIcon aria-hidden="true" className="size-3" />
													{t("gallery.videoBadge")}
												</span>
											)}
										</span>
									)}
								</button>
							</li>
						);
					})}
				</ul>
				<div ref={end} />
				{pages.hasNextPage && (
					<div className="mt-8 text-center">
						<Button
							variant="outline"
							onClick={() => pages.fetchNextPage()}
							disabled={pages.isFetchingNextPage}
						>
							{pages.isFetchingNextPage
								? t("gallery.loading")
								: t("gallery.loadMore")}
						</Button>
					</div>
				)}
			</div>
			{open && (
				<Lightbox
					item={open}
					onClose={() => setOpen(null)}
					onUseAsReference={(id) => {
						addReference(id);
						setOpen(null);
					}}
				/>
			)}
		</div>
	);
}
