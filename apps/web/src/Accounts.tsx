import type { AccountView, InviteView, UserRole } from "@hatchlight/core/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LogOutIcon, TriangleAlertIcon } from "lucide-react";
import {
	createContext,
	type FormEvent,
	type ReactNode,
	useContext,
	useEffect,
	useId,
	useState,
	useSyncExternalStore,
} from "react";
import { Logo } from "@/components/Logo";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { ApiError, api, type InviteTerms, whenSignedOut } from "./api";
import { type I18n, useI18n } from "./i18n";
import { Bar, ConfirmButton, LABEL, SECTION } from "./Training";

const MIN_PASSWORD = 10;

function roleText(t: I18n["t"], role: UserRole): string {
	switch (role) {
		case "owner":
			return t("role.owner");
		case "admin":
			return t("role.admin");
		case "member":
			return t("role.member");
	}
}

/** The person signed in on a server; null on a personal install. */
const AccountContext = createContext<AccountView | null>(null);

export const useAccount = () => useContext(AccountContext);

/** What the person may do. On a personal install, everything. */
export function useCan() {
	const account = useAccount();
	if (!account) {
		return { server: false, owner: true, admin: true, train: true, paid: true };
	}
	return {
		server: true,
		owner: account.role === "owner",
		admin: account.role !== "member",
		train: account.canTrain,
		paid: account.canUsePaid,
	};
}

/** Starts again from a clean page: nothing of another person stays cached. */
const reload = () => {
	window.location.hash = "#/";
	window.location.reload();
};

/** A text field tall enough to touch. */
const FIELD = "h-10";
/** A panel inside a section: one form, one list. */
const PANEL = "rounded-xl border border-line bg-bg/60 p-4";
/** The small heading of a panel. */
const PANEL_TITLE = "font-medium";

const inviteToken = (hash: string) =>
	/^#\/invite\/([\w-]+)$/.exec(hash)?.[1] ?? null;
const resetToken = (hash: string) =>
	/^#\/reset\/([\w-]+)$/.exec(hash)?.[1] ?? null;

const subscribeHash = (notify: () => void) => {
	window.addEventListener("hashchange", notify);
	return () => window.removeEventListener("hashchange", notify);
};

/**
 * On a server, nothing shows until someone is signed in: the first visit
 * sets the server up, an invite link makes an account, and everyone else
 * signs in. A personal install goes straight in.
 */
export function Gate({ children }: { children: ReactNode }) {
	const server = useQuery({
		queryKey: ["server"],
		queryFn: api.server,
		staleTime: Number.POSITIVE_INFINITY,
	});
	if (server.isPending) return null;
	if (server.data?.mode !== "server") return children;
	return <ServerGate secure={server.data.secure}>{children}</ServerGate>;
}

function ServerGate({
	secure,
	children,
}: {
	secure: boolean;
	children: ReactNode;
}) {
	const client = useQueryClient();
	const hash = useSyncExternalStore(subscribeHash, () => window.location.hash);
	const account = useQuery({
		queryKey: ["account"],
		queryFn: () =>
			api.account().catch((error) => {
				if (error instanceof ApiError && error.code === "signInRequired") {
					return null;
				}
				throw error;
			}),
		retry: false,
	});
	const setup = useQuery({
		queryKey: ["setup"],
		queryFn: api.setupNeeded,
		enabled: account.data === null,
	});
	useEffect(
		() =>
			whenSignedOut(() => {
				void client.invalidateQueries({ queryKey: ["account"] });
			}),
		[client],
	);

	const token = inviteToken(hash);
	const reset = resetToken(hash);
	let screen: ReactNode = null;
	if (account.isPending || (account.data === null && setup.isPending)) {
		screen = null;
	} else if (reset) {
		// Whoever is signed in here, the link is for its own person.
		screen = <ResetPassword token={reset} signedIn={account.data != null} />;
	} else if (account.data && !account.data.mustChangePassword) {
		return (
			<AccountContext.Provider value={account.data}>
				{secure && !account.data.resetNotice ? (
					children
				) : (
					<div className="flex h-full flex-col">
						{!secure && <Unencrypted banner />}
						{account.data.resetNotice && (
							<ResetNotice notice={account.data.resetNotice} />
						)}
						<div className="min-h-0 flex-1">{children}</div>
					</div>
				)}
			</AccountContext.Provider>
		);
	} else if (account.data) {
		screen = <ChoosePassword />;
	} else if (setup.data?.needed) {
		screen = <Setup />;
	} else if (token) {
		screen = <AcceptInvite token={token} />;
	} else {
		screen = <SignIn />;
	}
	return (
		<div className="relative isolate flex h-full overflow-x-hidden overflow-y-auto">
			<div className="sky -z-10" aria-hidden="true" />
			<main className="m-auto flex w-full max-w-md flex-col gap-6 px-4 py-10 sm:py-16">
				<Logo className="self-center" />
				{!secure && <Unencrypted />}
				{screen && (
					<Card
						className={cn(SECTION, "scene-in bg-panel/85 backdrop-blur-sm")}
					>
						<CardContent className="flex flex-col gap-6">{screen}</CardContent>
					</Card>
				)}
			</main>
		</div>
	);
}

/** The top of a screen before the app: its title, big, and a few words. */
function Heading({ title, intro }: { title: string; intro?: string }) {
	return (
		<div className="flex flex-col gap-3">
			<h1 className="font-display text-[34px] leading-none font-extrabold tracking-[-0.02em] text-balance sm:text-4xl">
				{title}
			</h1>
			{intro && <p className="text-sm leading-relaxed text-soft">{intro}</p>}
		</div>
	);
}

/** Someone else's link reset the password: said once, until dismissed. */
function ResetNotice({ notice }: { notice: { by: string; at: number } }) {
	const { t, date } = useI18n();
	const client = useQueryClient();
	const dismiss = useMutation({
		mutationFn: api.dismissResetNotice,
		onSuccess: () => client.invalidateQueries({ queryKey: ["account"] }),
	});
	return (
		<div
			role="status"
			className="flex shrink-0 flex-wrap items-center justify-center gap-x-4 gap-y-2 border-b border-line bg-panel px-4 py-2 text-sm"
		>
			<span>
				{t("account.resetNotice", { name: notice.by, date: date(notice.at) })}
			</span>
			<Button
				variant="outline"
				onClick={() => dismiss.mutate()}
				disabled={dismiss.isPending}
			>
				{t("account.resetNoticeOk")}
			</Button>
		</div>
	);
}

/** Passwords would cross the network as plain text. */
function Unencrypted({ banner = false }: { banner?: boolean }) {
	const { t } = useI18n();
	if (banner) {
		return (
			<p
				role="note"
				className="shrink-0 bg-warn px-4 py-1 text-center text-xs font-medium text-black"
			>
				{t("account.unencrypted")}
			</p>
		);
	}
	return (
		<p
			role="note"
			className="flex gap-3 rounded-xl border border-warn/40 bg-warn/10 px-4 py-3 text-sm leading-relaxed text-warn"
		>
			<TriangleAlertIcon
				aria-hidden="true"
				className="mt-0.5 size-4 shrink-0"
			/>
			{t("account.unencrypted")}
		</p>
	);
}

/** A label over its field; the field is the child. */
function Field({ label, children }: { label: string; children: ReactNode }) {
	return (
		<Label className="flex-col items-stretch gap-2 font-normal text-soft">
			{label}
			{children}
		</Label>
	);
}

function Problem({ error, id }: { error: unknown; id?: string }) {
	const { explain } = useI18n();
	if (!error) return null;
	return (
		<p id={id} role="alert" className="text-sm text-danger">
			{explain(error)}
		</p>
	);
}

/** Username and a new password, twice, as setup and invites ask. */
function NewAccount({
	submit,
	pending,
	error,
	children,
	action,
}: {
	submit: (username: string, password: string) => void;
	pending: boolean;
	error: unknown;
	children?: ReactNode;
	action: string;
}) {
	const { t } = useI18n();
	const id = useId();
	const [username, setUsername] = useState("");
	const [password, setPassword] = useState("");
	const [again, setAgain] = useState("");
	const mismatch = again !== "" && again !== password;
	return (
		<form
			className="flex flex-col gap-4"
			onSubmit={(event) => {
				event.preventDefault();
				if (!mismatch) submit(username, password);
			}}
		>
			{children}
			<Field label={t("account.username")}>
				<Input
					value={username}
					onChange={(event) => setUsername(event.target.value)}
					autoComplete="username"
					required
					aria-describedby={error ? `${id}-error` : undefined}
					className={FIELD}
				/>
			</Field>
			<Field label={t("account.newPassword")}>
				<Input
					type="password"
					value={password}
					onChange={(event) => setPassword(event.target.value)}
					autoComplete="new-password"
					minLength={MIN_PASSWORD}
					required
					aria-describedby={`${id}-hint`}
					className={FIELD}
				/>
			</Field>
			<Field label={t("account.passwordAgain")}>
				<Input
					type="password"
					value={again}
					onChange={(event) => setAgain(event.target.value)}
					autoComplete="new-password"
					required
					aria-invalid={mismatch || undefined}
					aria-describedby={`${id}-hint`}
					className={FIELD}
				/>
			</Field>
			<p
				id={`${id}-hint`}
				className={cn("text-xs", mismatch ? "text-danger" : "text-dim")}
			>
				{mismatch
					? t("account.passwordsDiffer")
					: t("account.passwordHint", { min: MIN_PASSWORD })}
			</p>
			<Problem error={error} id={`${id}-error`} />
			<Button
				type="submit"
				variant="aurora"
				size="lg"
				disabled={pending || mismatch || password.length < MIN_PASSWORD}
			>
				{action}
			</Button>
		</form>
	);
}

function Setup() {
	const { t } = useI18n();
	const [code, setCode] = useState("");
	const setup = useMutation({
		mutationFn: (input: { username: string; password: string }) =>
			api.setup({ code, ...input }),
		onSuccess: reload,
	});
	return (
		<>
			<Heading title={t("setup.title")} intro={t("setup.intro")} />
			<NewAccount
				submit={(username, password) => setup.mutate({ username, password })}
				pending={setup.isPending}
				error={setup.error}
				action={t("setup.create")}
			>
				<Field label={t("setup.code")}>
					<Input
						value={code}
						onChange={(event) => setCode(event.target.value)}
						autoComplete="off"
						spellCheck={false}
						required
						placeholder="XXXX-XXXX-XXXX"
						className={cn(FIELD, "font-mono tracking-wider uppercase")}
					/>
				</Field>
			</NewAccount>
		</>
	);
}

function SignIn() {
	const { t } = useI18n();
	const id = useId();
	const [username, setUsername] = useState("");
	const [password, setPassword] = useState("");
	const [code, setCode] = useState("");
	const [asksCode, setAsksCode] = useState(false);
	const login = useMutation({
		mutationFn: () =>
			api.login({ username, password, totp: asksCode ? code : undefined }),
		onSuccess: reload,
		onError: (error) => {
			if (error instanceof ApiError && error.code === "totpRequired") {
				setAsksCode(true);
			}
		},
	});
	const submit = (event: FormEvent) => {
		event.preventDefault();
		login.mutate();
	};
	// Being asked for the code is the next step, not a failure.
	const asked =
		login.error instanceof ApiError && login.error.code === "totpRequired";
	const failed = login.error != null && !asked;
	const describedBy = failed ? `${id}-error` : undefined;
	return (
		<>
			<Heading title={t("signin.title")} />
			<form className="flex flex-col gap-4" onSubmit={submit}>
				{asksCode ? (
					<Field label={t("signin.code")}>
						<Input
							value={code}
							onChange={(event) => setCode(event.target.value)}
							inputMode="numeric"
							autoComplete="one-time-code"
							autoFocus
							required
							aria-invalid={failed || undefined}
							aria-describedby={describedBy}
							className={cn(FIELD, "font-mono text-lg tracking-[0.3em]")}
						/>
					</Field>
				) : (
					<>
						<Field label={t("account.username")}>
							<Input
								value={username}
								onChange={(event) => setUsername(event.target.value)}
								autoComplete="username"
								required
								aria-invalid={failed || undefined}
								aria-describedby={describedBy}
								className={FIELD}
							/>
						</Field>
						<Field label={t("account.password")}>
							<Input
								type="password"
								value={password}
								onChange={(event) => setPassword(event.target.value)}
								autoComplete="current-password"
								required
								aria-invalid={failed || undefined}
								aria-describedby={describedBy}
								className={FIELD}
							/>
						</Field>
					</>
				)}
				{failed && <Problem error={login.error} id={`${id}-error`} />}
				<Button
					type="submit"
					variant="aurora"
					size="lg"
					disabled={login.isPending}
				>
					{t("signin.submit")}
				</Button>
				{asksCode && (
					<Button
						variant="ghost"
						onClick={() => {
							setAsksCode(false);
							setCode("");
							login.reset();
						}}
						className="text-dim"
					>
						{t("common.back")}
					</Button>
				)}
			</form>
			<p className="text-xs leading-relaxed text-dim">{t("signin.forgot")}</p>
		</>
	);
}

function AcceptInvite({ token }: { token: string }) {
	const { t } = useI18n();
	const invite = useQuery({
		queryKey: ["invite", token],
		queryFn: () => api.invite(token),
		retry: false,
	});
	const accept = useMutation({
		mutationFn: (input: { username: string; password: string }) =>
			api.acceptInvite(token, input),
		onSuccess: reload,
	});
	if (invite.isPending) return null;
	if (invite.error) {
		return (
			<>
				<Heading title={t("invite.title")} />
				<Problem error={invite.error} />
				<a href="#/" className={buttonVariants({ variant: "outline" })}>
					{t("signin.title")}
				</a>
			</>
		);
	}
	return (
		<>
			<Heading
				title={t("invite.title")}
				intro={t("invite.intro", { role: roleText(t, invite.data.role) })}
			/>
			<NewAccount
				submit={(username, password) => accept.mutate({ username, password })}
				pending={accept.isPending}
				error={accept.error}
				action={t("invite.accept")}
			/>
		</>
	);
}

/** A link from an admin or owner, to choose a new password. */
function ResetPassword({
	token,
	signedIn,
}: {
	token: string;
	/** Someone is signed in here already: the way on is the app. */
	signedIn: boolean;
}) {
	const { t } = useI18n();
	const id = useId();
	const [password, setPassword] = useState("");
	const [again, setAgain] = useState("");
	const reset = useQuery({
		queryKey: ["reset", token],
		queryFn: () => api.passwordReset(token),
		retry: false,
	});
	const save = useMutation({
		mutationFn: () => api.setPasswordFromLink(token, password),
	});
	const mismatch = again !== "" && again !== password;
	if (reset.isPending) return null;
	if (save.isSuccess || reset.error) {
		return (
			<>
				<Heading title={t("account.choosePassword")} />
				{save.isSuccess ? (
					<p role="status" className="text-sm text-good">
						{t("reset.done")}
					</p>
				) : (
					<Problem error={reset.error} />
				)}
				<Button variant="aurora" size="lg" onClick={reload}>
					{signedIn && !save.isSuccess ? t("reset.open") : t("signin.title")}
				</Button>
			</>
		);
	}
	return (
		<>
			<Heading
				title={t("account.choosePassword")}
				intro={t("reset.intro", { name: reset.data.username })}
			/>
			<form
				className="flex flex-col gap-4"
				onSubmit={(event) => {
					event.preventDefault();
					if (!mismatch) save.mutate();
				}}
			>
				{/* Lets a password manager save the new password for this account. */}
				<input
					type="text"
					value={reset.data.username}
					autoComplete="username"
					readOnly
					hidden
				/>
				<Field label={t("account.newPassword")}>
					<Input
						type="password"
						value={password}
						onChange={(event) => setPassword(event.target.value)}
						autoComplete="new-password"
						minLength={MIN_PASSWORD}
						required
						aria-describedby={`${id}-hint`}
						className={FIELD}
					/>
				</Field>
				<Field label={t("account.passwordAgain")}>
					<Input
						type="password"
						value={again}
						onChange={(event) => setAgain(event.target.value)}
						autoComplete="new-password"
						required
						aria-invalid={mismatch || undefined}
						aria-describedby={`${id}-hint`}
						className={FIELD}
					/>
				</Field>
				<p
					id={`${id}-hint`}
					className={cn("text-xs", mismatch ? "text-danger" : "text-dim")}
				>
					{mismatch
						? t("account.passwordsDiffer")
						: t("account.passwordHint", { min: MIN_PASSWORD })}
				</p>
				<Problem error={save.error} />
				<Button
					type="submit"
					variant="aurora"
					size="lg"
					disabled={
						save.isPending || mismatch || password.length < MIN_PASSWORD
					}
				>
					{t("reset.submit")}
				</Button>
			</form>
		</>
	);
}

/** A temporary password is replaced before anything else. */
function ChoosePassword() {
	const { t } = useI18n();
	return (
		<>
			<Heading
				title={t("account.choosePassword")}
				intro={t("account.choosePasswordIntro")}
			/>
			<PasswordForm onDone={reload} wide />
			<SignOut className="self-center text-dim" />
		</>
	);
}

function PasswordForm({
	onDone,
	wide = false,
}: {
	onDone?: () => void;
	/** The only form of a screen: its button spans it, in the Aurora light. */
	wide?: boolean;
}) {
	const { t } = useI18n();
	const id = useId();
	const [current, setCurrent] = useState("");
	const [next, setNext] = useState("");
	const [done, setDone] = useState(false);
	const change = useMutation({
		mutationFn: () => api.changePassword({ current, next }),
		onSuccess: () => {
			setCurrent("");
			setNext("");
			setDone(true);
			onDone?.();
		},
	});
	return (
		<form
			className="flex flex-col gap-4"
			onSubmit={(event) => {
				event.preventDefault();
				setDone(false);
				change.mutate();
			}}
		>
			<Field label={t("account.currentPassword")}>
				<Input
					type="password"
					value={current}
					onChange={(event) => setCurrent(event.target.value)}
					autoComplete="current-password"
					required
					aria-describedby={change.error ? `${id}-error` : undefined}
					className={FIELD}
				/>
			</Field>
			<Field label={t("account.newPassword")}>
				<Input
					type="password"
					value={next}
					onChange={(event) => setNext(event.target.value)}
					autoComplete="new-password"
					minLength={MIN_PASSWORD}
					required
					aria-describedby={`${id}-hint`}
					className={FIELD}
				/>
			</Field>
			<p id={`${id}-hint`} className="text-xs text-dim">
				{t("account.passwordHint", { min: MIN_PASSWORD })}
			</p>
			<Problem error={change.error} id={`${id}-error`} />
			{done && (
				<p role="status" className="text-sm text-good">
					{t("account.passwordChanged")}
				</p>
			)}
			<Button
				type="submit"
				variant={wide ? "aurora" : "outline"}
				size={wide ? "lg" : "default"}
				disabled={change.isPending || next.length < MIN_PASSWORD}
				className={wide ? undefined : "self-start"}
			>
				{t("account.changePassword")}
			</Button>
		</form>
	);
}

export function SignOut({ className }: { className?: string }) {
	const { t } = useI18n();
	const out = useMutation({ mutationFn: api.logout, onSettled: reload });
	return (
		<Button
			variant="ghost"
			onClick={() => out.mutate()}
			disabled={out.isPending}
			className={cn("h-10", className)}
		>
			<LogOutIcon aria-hidden="true" />
			{t("account.signOut")}
		</Button>
	);
}

/** Who is signed in, and a way out, at the foot of the navigation. */
export function AccountMenu({ className }: { className: string }) {
	const account = useAccount();
	const { t } = useI18n();
	if (!account) return null;
	return (
		<div className="mt-2 flex items-center justify-between gap-2 border-t border-line pt-3">
			<div className="flex min-w-0 flex-col items-start gap-1 px-2">
				<span
					className="max-w-full truncate text-sm font-medium"
					title={account.username}
				>
					{account.displayName}
				</span>
				<Badge
					variant="outline"
					className="font-mono text-[10px] tracking-[0.12em] text-dim uppercase"
				>
					{roleText(t, account.role)}
				</Badge>
			</div>
			<SignOut className={className} />
		</div>
	);
}

/** The top of a Settings section: its label and what it is for. */
function SectionHeader({ title, intro }: { title: string; intro: string }) {
	return (
		<CardHeader className="flex flex-col gap-2">
			<h2 className={LABEL}>{title}</h2>
			<p className="max-w-2xl text-sm leading-relaxed text-dim">{intro}</p>
		</CardHeader>
	);
}

/** Settings > Account: password, two-step sign-in, and where one is signed in. */
export function AccountSettings() {
	const account = useAccount();
	const { t, bytes } = useI18n();
	if (!account) return null;
	const { usedBytes, quotaBytes } = account.storage;
	return (
		<Card className={SECTION}>
			<SectionHeader
				title={t("account.title")}
				intro={t("account.signedInAs", { name: account.username })}
			/>
			<CardContent className="flex flex-col gap-3">
				<div className={cn(PANEL, "flex flex-col gap-3")}>
					<h3 className={PANEL_TITLE}>{t("account.storageTitle")}</h3>
					<p className="text-sm text-dim">
						{quotaBytes == null
							? t("account.storage", { used: bytes(usedBytes) })
							: t("account.storageOf", {
									used: bytes(usedBytes),
									quota: bytes(quotaBytes),
								})}
					</p>
					{quotaBytes != null && quotaBytes > 0 && (
						<Bar
							value={Math.min((usedBytes / quotaBytes) * 100, 100)}
							label={t("account.storageTitle")}
						/>
					)}
				</div>
				<div className="grid items-start gap-3 md:grid-cols-2">
					<div className={PANEL}>
						<h3 className={cn(PANEL_TITLE, "mb-4")}>
							{t("account.changePassword")}
						</h3>
						<PasswordForm />
					</div>
					<TwoStep enabled={account.totp} />
				</div>
				<Sessions />
			</CardContent>
		</Card>
	);
}

function TwoStep({ enabled }: { enabled: boolean }) {
	const { t } = useI18n();
	const client = useQueryClient();
	const [code, setCode] = useState("");
	const [current, setCurrent] = useState("");
	const [password, setPassword] = useState("");
	const refresh = () => client.invalidateQueries({ queryKey: ["account"] });
	const done = () => {
		setCode("");
		setCurrent("");
		setPassword("");
		return refresh();
	};
	// A new secret: to turn it on, or to move it to another app.
	const start = useMutation({ mutationFn: api.startTotp });
	// Changing it takes the password, and the current app's code when on.
	const enable = useMutation({
		mutationFn: () =>
			api.enableTotp({
				secret: start.data?.secret ?? "",
				code,
				password,
				current: enabled ? current : undefined,
			}),
		onSuccess: () => {
			start.reset();
			return done();
		},
	});
	const disable = useMutation({
		mutationFn: () => api.disableTotp({ password, code: current }),
		onSuccess: done,
	});
	const passwordField = (
		<Field label={t("account.currentPassword")}>
			<Input
				type="password"
				value={password}
				onChange={(event) => setPassword(event.target.value)}
				autoComplete="current-password"
				className={FIELD}
			/>
		</Field>
	);
	const codeField = (
		value: string,
		set: (value: string) => void,
		label: string,
	) => (
		<Field label={label}>
			<Input
				value={value}
				onChange={(event) => set(event.target.value)}
				placeholder="123456"
				inputMode="numeric"
				autoComplete="one-time-code"
				className={cn(FIELD, "font-mono tracking-[0.3em]")}
			/>
		</Field>
	);
	const newApp = start.data && (
		<div className="flex flex-col gap-3 rounded-lg border border-line bg-panel p-3">
			<p className="text-sm leading-relaxed">{t("account.twoStepAdd")}</p>
			<a
				href={start.data.uri}
				className="rounded-sm font-mono text-xs break-all text-pink underline underline-offset-2 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
			>
				{start.data.uri}
			</a>
			<p className="flex flex-col gap-1.5 text-sm text-dim">
				{t("account.twoStepSecret")}
				<code className="rounded-lg border border-line bg-bg px-3 py-2.5 font-mono text-base tracking-[0.18em] break-all text-ink select-all">
					{start.data.secret.replace(/(.{4})/g, "$1 ").trim()}
				</code>
			</p>
		</div>
	);
	return (
		<div className={cn(PANEL, "flex flex-col gap-4")}>
			<div className="flex items-center justify-between gap-4">
				<h3 className={PANEL_TITLE}>{t("account.twoStep")}</h3>
				<Badge
					variant="outline"
					className={cn(
						"font-mono text-[10px] tracking-[0.12em] uppercase",
						enabled ? "border-good/40 text-good" : "text-dim",
					)}
				>
					{enabled ? t("account.twoStepOn") : t("account.twoStepOff")}
				</Badge>
			</div>
			<p className="text-sm leading-relaxed text-dim">
				{t("account.twoStepIntro")}
			</p>
			{enabled && start.data ? (
				<form
					className="flex flex-col gap-4"
					onSubmit={(event) => {
						event.preventDefault();
						enable.mutate();
					}}
				>
					{newApp}
					<p className="text-sm text-dim">{t("account.twoStepMoveHint")}</p>
					{passwordField}
					<div className="grid gap-4 sm:grid-cols-2">
						{codeField(current, setCurrent, t("account.twoStepOldCode"))}
						{codeField(code, setCode, t("account.twoStepNewCode"))}
					</div>
					<div className="flex flex-wrap gap-2">
						<Button
							type="submit"
							variant="aurora"
							disabled={!password || !current || !code || enable.isPending}
						>
							{t("account.twoStepMoveConfirm")}
						</Button>
						<Button
							variant="ghost"
							onClick={() => {
								start.reset();
								enable.reset();
								setCode("");
								setCurrent("");
							}}
						>
							{t("common.cancel")}
						</Button>
					</div>
				</form>
			) : enabled ? (
				<>
					<form
						className="flex flex-col gap-4"
						onSubmit={(event) => {
							event.preventDefault();
							disable.mutate();
						}}
					>
						<div className="grid gap-4 sm:grid-cols-2">
							{passwordField}
							{codeField(current, setCurrent, t("signin.code"))}
						</div>
						<Button
							type="submit"
							variant="outline"
							disabled={!password || !current || disable.isPending}
							className="self-start text-dim hover:text-danger"
						>
							{t("account.twoStepDisable")}
						</Button>
					</form>
					<Button
						variant="ghost"
						onClick={() => {
							disable.reset();
							start.mutate();
						}}
						disabled={start.isPending}
						className="self-start"
					>
						{t("account.twoStepMove")}
					</Button>
				</>
			) : start.data ? (
				<form
					className="flex flex-col gap-4"
					onSubmit={(event) => {
						event.preventDefault();
						enable.mutate();
					}}
				>
					{newApp}
					<div className="grid gap-4 sm:grid-cols-2">
						{passwordField}
						{codeField(code, setCode, t("signin.code"))}
					</div>
					<Button
						type="submit"
						variant="aurora"
						disabled={!code || !password || enable.isPending}
						className="self-start"
					>
						{t("account.twoStepConfirm")}
					</Button>
				</form>
			) : (
				<Button
					variant="outline"
					onClick={() => start.mutate()}
					disabled={start.isPending}
					className="self-start"
				>
					{t("account.twoStepEnable")}
				</Button>
			)}
			<Problem error={start.error ?? enable.error ?? disable.error} />
		</div>
	);
}

function Sessions() {
	const { t, date } = useI18n();
	const client = useQueryClient();
	const sessions = useQuery({
		queryKey: ["account-sessions"],
		queryFn: api.accountSessions,
	});
	const refresh = () =>
		client.invalidateQueries({ queryKey: ["account-sessions"] });
	const revoke = useMutation({
		mutationFn: api.revokeSession,
		onSuccess: refresh,
	});
	const others = useMutation({
		mutationFn: api.revokeOtherSessions,
		onSuccess: refresh,
	});
	return (
		<div className={cn(PANEL, "flex flex-col gap-4")}>
			<div className="flex flex-wrap items-center justify-between gap-3">
				<h3 className={PANEL_TITLE}>{t("account.sessions")}</h3>
				{(sessions.data?.length ?? 0) > 1 && (
					<ConfirmButton
						label={t("account.signOutOthers")}
						question={t("account.signOutOthersQuestion")}
						confirm={t("account.signOutOthers")}
						disabled={others.isPending}
						onConfirm={() => others.mutate()}
					/>
				)}
			</div>
			<ul className="flex flex-col divide-y divide-line">
				{sessions.data?.map((session) => {
					const browser = session.userAgent ?? t("account.unknownBrowser");
					return (
						<li
							key={session.id}
							className="flex flex-col gap-3 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between"
						>
							<span className="flex min-w-0 flex-col gap-1">
								<span className="text-sm break-words">{browser}</span>
								<span className="flex flex-wrap items-center gap-2 font-mono text-xs text-dim">
									{session.current ? (
										<Badge
											variant="outline"
											className="border-good/40 font-mono text-[10px] tracking-[0.12em] text-good uppercase"
										>
											{t("account.thisBrowser")}
										</Badge>
									) : (
										t("account.lastSeen", { when: date(session.lastSeenAt) })
									)}
									{session.ip && <span>{session.ip}</span>}
								</span>
							</span>
							{!session.current && (
								<ConfirmButton
									label={t("account.signOutThere")}
									ariaLabel={`${t("account.signOutThere")}: ${browser}`}
									question={t("account.signOutThereQuestion", {
										browser,
									})}
									confirm={t("account.signOutThere")}
									onConfirm={() => revoke.mutate(session.id)}
								/>
							)}
						</li>
					);
				})}
			</ul>
			<Problem error={sessions.error ?? revoke.error ?? others.error} />
		</div>
	);
}

/** Settings > People: invites, and who may do what. Admins and owners. */
export function UsersSettings() {
	const account = useAccount();
	const { t } = useI18n();
	if (!account || account.role === "member") return null;
	return (
		<Card className={SECTION}>
			<SectionHeader title={t("users.title")} intro={t("users.intro")} />
			<CardContent className="flex flex-col gap-3">
				<NewInvite owner={account.role === "owner"} />
				<Invites />
				<People me={account} />
			</CardContent>
		</Card>
	);
}

function Terms({
	terms,
	setTerms,
	owner,
}: {
	terms: InviteTerms;
	setTerms: (terms: InviteTerms) => void;
	owner: boolean;
}) {
	const { t } = useI18n();
	const id = useId();
	// Admins make members only.
	const roles: UserRole[] = owner ? ["member", "admin", "owner"] : ["member"];
	return (
		<div className="flex flex-col gap-x-6 gap-y-3 sm:flex-row sm:flex-wrap sm:items-center">
			{owner ? (
				<div className="flex items-center gap-3">
					<Label htmlFor={`${id}-role`} className="font-normal text-dim">
						{t("users.role")}
					</Label>
					<Select
						items={roles.map((role) => ({
							value: role,
							label: roleText(t, role),
						}))}
						value={terms.role}
						onValueChange={(next: UserRole | null) => {
							if (next) setTerms({ ...terms, role: next });
						}}
					>
						<SelectTrigger
							id={`${id}-role`}
							className="min-w-32 data-[size=default]:h-10"
						>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{roles.map((role) => (
								<SelectItem key={role} value={role}>
									{roleText(t, role)}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>
			) : (
				// Admins make members only: nothing to choose.
				<span className="text-sm text-dim">{roleText(t, terms.role)}</span>
			)}
			{terms.role === "member" && (
				<>
					<Label className="min-h-10 gap-3 font-normal">
						<Switch
							checked={terms.canUsePaid}
							onCheckedChange={(checked) =>
								setTerms({ ...terms, canUsePaid: checked })
							}
						/>
						{t("users.canUsePaid")}
					</Label>
					<Label className="min-h-10 gap-3 font-normal">
						<Switch
							checked={terms.canTrain}
							onCheckedChange={(checked) =>
								setTerms({ ...terms, canTrain: checked })
							}
						/>
						{t("users.canTrain")}
					</Label>
				</>
			)}
			<div className="flex items-center gap-3">
				<Label htmlFor={`${id}-limit`} className="font-normal text-dim">
					{t("users.limit")}
				</Label>
				<LimitInput
					id={`${id}-limit`}
					value={terms.monthlyLimitUsd}
					placeholder={t("users.noLimit")}
					onCommit={(monthlyLimitUsd) =>
						setTerms({ ...terms, monthlyLimitUsd })
					}
				/>
			</div>
		</div>
	);
}

/**
 * A dollar amount, or nothing for no limit. Saved when the field is left or
 * Enter is pressed, not at every key.
 */
function LimitInput({
	id,
	value,
	placeholder,
	onCommit,
}: {
	id: string;
	value: number | null;
	placeholder: string;
	onCommit(value: number | null): void;
}) {
	const [draft, setDraft] = useState(value == null ? "" : String(value));
	// What the server says wins once it changes.
	useEffect(() => setDraft(value == null ? "" : String(value)), [value]);
	const commit = () => {
		const next = draft.trim() === "" ? null : Number(draft);
		if (next !== null && !(Number.isFinite(next) && next >= 0)) {
			setDraft(value == null ? "" : String(value));
			return;
		}
		if (next !== value) onCommit(next);
	};
	return (
		<Input
			id={id}
			type="number"
			min={0}
			step="any"
			value={draft}
			placeholder={placeholder}
			onChange={(event) => setDraft(event.target.value)}
			onBlur={commit}
			onKeyDown={(event) => {
				if (event.key === "Enter") {
					event.preventDefault();
					commit();
				}
			}}
			className={cn(FIELD, "w-28 font-mono")}
		/>
	);
}

/** A link to hand to someone, with a button that copies it. */
function CopyLink({
	link,
	label,
	copied,
	onCopy,
}: {
	link: string;
	label: string;
	copied: boolean;
	onCopy(): void;
}) {
	const { t } = useI18n();
	const id = useId();
	return (
		<div className="flex flex-col gap-2">
			<Label htmlFor={id} className="leading-relaxed font-normal text-dim">
				{label}
			</Label>
			<div className="flex flex-col gap-2 sm:flex-row">
				<Input
					id={id}
					readOnly
					value={link}
					onFocus={(event) => event.target.select()}
					className={cn(FIELD, "flex-1 font-mono text-xs md:text-xs")}
				/>
				<Button variant="outline" onClick={onCopy}>
					{copied ? t("settings.agentsCopied") : t("settings.agentsCopy")}
				</Button>
			</div>
		</div>
	);
}

function NewInvite({ owner }: { owner: boolean }) {
	const { t } = useI18n();
	const client = useQueryClient();
	const [terms, setTerms] = useState<InviteTerms>({
		role: "member",
		canUsePaid: false,
		canTrain: false,
		monthlyLimitUsd: null,
	});
	const [copied, setCopied] = useState(false);
	const create = useMutation({
		mutationFn: () => api.createInvite(terms),
		onSuccess: () => {
			setCopied(false);
			return client.invalidateQueries({ queryKey: ["invites"] });
		},
	});
	const link = create.data
		? `${window.location.origin}/#/invite/${create.data.token}`
		: null;
	return (
		<div className={cn(PANEL, "flex flex-col gap-4")}>
			<h3 className={PANEL_TITLE}>{t("users.invite")}</h3>
			<Terms terms={terms} setTerms={setTerms} owner={owner} />
			<Button
				variant="aurora"
				onClick={() => create.mutate()}
				disabled={create.isPending}
				className="self-start"
			>
				{t("users.createInvite")}
			</Button>
			{link && (
				<CopyLink
					link={link}
					label={t("users.inviteLink")}
					copied={copied}
					onCopy={() =>
						void navigator.clipboard
							?.writeText(link)
							.then(() => setCopied(true))
					}
				/>
			)}
			<Problem error={create.error} />
		</div>
	);
}

function Invites() {
	const { t, date } = useI18n();
	const client = useQueryClient();
	const invites = useQuery({ queryKey: ["invites"], queryFn: api.invites });
	const remove = useMutation({
		mutationFn: api.deleteInvite,
		onSuccess: () => client.invalidateQueries({ queryKey: ["invites"] }),
	});
	const now = Date.now();
	const open = (invites.data ?? []).filter(
		(invite: InviteView) => invite.usedAt == null && invite.expiresAt > now,
	);
	if (open.length === 0) return null;
	return (
		<div className={cn(PANEL, "flex flex-col gap-4")}>
			<h3 className={PANEL_TITLE}>{t("users.openInvites")}</h3>
			<ul className="flex flex-col divide-y divide-line">
				{open.map((invite) => (
					<li
						key={invite.id}
						className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0"
					>
						<span className="flex flex-wrap items-center gap-2 text-sm">
							<Badge
								variant="outline"
								className="font-mono text-[10px] tracking-[0.12em] uppercase"
							>
								{roleText(t, invite.role)}
							</Badge>
							<span className="font-mono text-xs text-dim">
								{t("users.expires", { when: date(invite.expiresAt) })}
							</span>
						</span>
						<ConfirmButton
							label={t("users.revokeInvite")}
							question={t("users.revokeInviteQuestion")}
							confirm={t("users.revokeInvite")}
							onConfirm={() => remove.mutate(invite.id)}
						/>
					</li>
				))}
			</ul>
			<Problem error={remove.error} />
		</div>
	);
}

function People({ me }: { me: AccountView }) {
	const { t } = useI18n();
	const users = useQuery({ queryKey: ["users"], queryFn: api.users });
	return (
		<div className={cn(PANEL, "flex flex-col gap-2")}>
			<h3 className={PANEL_TITLE}>{t("users.people")}</h3>
			<ul className="flex flex-col divide-y divide-line">
				{users.data?.map((user) => (
					<Person key={user.id} user={user} me={me} />
				))}
			</ul>
			<Problem error={users.error} />
		</div>
	);
}

function Person({ user, me }: { user: AccountView; me: AccountView }) {
	const { t, date } = useI18n();
	const client = useQueryClient();
	const [copied, setCopied] = useState(false);
	// Owners manage anyone; admins only members other than themselves.
	const mayChange =
		me.role === "owner" || (user.role === "member" && user.id !== me.id);
	const update = useMutation({
		mutationFn: (change: Partial<InviteTerms> & { disabled?: boolean }) =>
			api.updateUser(user.id, change),
		onSuccess: () => client.invalidateQueries({ queryKey: ["users"] }),
	});
	const reset = useMutation({
		mutationFn: () => api.resetPassword(user.id),
		onSuccess: () => setCopied(false),
	});
	const link = reset.data
		? `${window.location.origin}/#/reset/${reset.data.token}`
		: null;
	const badge = "font-mono text-[10px] tracking-[0.12em] uppercase";
	return (
		<li className="flex flex-col gap-3 py-4 last:pb-0">
			<div className="flex flex-wrap items-center gap-2">
				<span
					className={cn(
						"font-medium break-all",
						user.disabled && "text-dim line-through",
					)}
				>
					{user.username}
				</span>
				{user.id === me.id && (
					<span className="text-xs text-dim">{t("users.you")}</span>
				)}
				{!mayChange && (
					<Badge variant="outline" className={cn(badge, "text-dim")}>
						{roleText(t, user.role)}
					</Badge>
				)}
				{user.totp && (
					<Badge
						variant="outline"
						className={cn(badge, "border-good/40 text-good")}
					>
						{t("account.twoStep")}
					</Badge>
				)}
			</div>
			{user.lastReset && (
				<p className="text-xs text-dim">
					{t("users.lastReset", {
						name: user.lastReset.by,
						date: date(user.lastReset.at),
					})}
				</p>
			)}
			{mayChange && (
				<>
					<Terms
						terms={{
							role: user.role,
							canUsePaid: user.canUsePaid,
							canTrain: user.canTrain,
							monthlyLimitUsd: user.monthlyLimitUsd,
						}}
						setTerms={(terms) => update.mutate(terms)}
						owner={me.role === "owner"}
					/>
					{user.id !== me.id && (
						<div className="flex flex-wrap gap-2">
							{user.disabled ? (
								<Button
									variant="outline"
									onClick={() => update.mutate({ disabled: false })}
								>
									{t("users.enable")}
								</Button>
							) : (
								<ConfirmButton
									label={t("users.disable")}
									question={t("users.disableQuestion", {
										name: user.username,
									})}
									confirm={t("users.disable")}
									onConfirm={() => update.mutate({ disabled: true })}
								/>
							)}
							<ConfirmButton
								label={t("users.resetPassword")}
								question={t("users.resetQuestion", { name: user.username })}
								confirm={t("users.resetPassword")}
								disabled={reset.isPending}
								onConfirm={() => reset.mutate()}
							/>
						</div>
					)}
				</>
			)}
			{link && (
				<CopyLink
					link={link}
					label={t("users.resetLink", { name: user.username })}
					copied={copied}
					onCopy={() =>
						void navigator.clipboard
							?.writeText(link)
							.then(() => setCopied(true))
					}
				/>
			)}
			<Problem error={update.error ?? reset.error} />
		</li>
	);
}
