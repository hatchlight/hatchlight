import type { AccountView, InviteView, UserRole } from "@hatchlight/core/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	createContext,
	type FormEvent,
	type ReactNode,
	useContext,
	useEffect,
	useState,
	useSyncExternalStore,
} from "react";
import { ApiError, api, type InviteTerms, whenSignedOut } from "./api";
import { type I18n, useI18n } from "./i18n";

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

const input =
	"w-full rounded-md border border-line bg-bg px-3 py-2 text-sm focus:border-dim focus:outline-none";
const primary =
	"rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-ink disabled:opacity-40";
const secondary =
	"rounded-md border border-line px-3 py-2 text-sm text-dim hover:border-dim hover:text-ink disabled:opacity-40";

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
		<div className="flex h-full overflow-y-auto">
			<main className="m-auto flex w-full max-w-sm flex-col gap-6 p-8">
				<p className="flex items-center gap-3 font-display text-3xl leading-none font-extrabold tracking-tight">
					<i
						aria-hidden="true"
						className="aurora relative size-6 rounded-full shadow-[0_0_24px_rgb(255_61_139/0.5)] after:absolute after:inset-[6px] after:rounded-full after:bg-bg"
					/>
					Hatchlight
				</p>
				{!secure && <Unencrypted />}
				{screen}
			</main>
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
			className="flex shrink-0 items-center justify-center gap-3 border-b border-line bg-panel px-4 py-2 text-sm"
		>
			<span>
				{t("account.resetNotice", { name: notice.by, date: date(notice.at) })}
			</span>
			<button
				type="button"
				onClick={() => dismiss.mutate()}
				disabled={dismiss.isPending}
				className={secondary}
			>
				{t("account.resetNoticeOk")}
			</button>
		</div>
	);
}

/** Passwords would cross the network as plain text. */
function Unencrypted({ banner = false }: { banner?: boolean }) {
	const { t } = useI18n();
	return (
		<p
			role="note"
			className={
				banner
					? "shrink-0 bg-warn px-4 py-1 text-center text-xs font-medium text-black"
					: "rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-sm text-warn"
			}
		>
			{t("account.unencrypted")}
		</p>
	);
}

function Field({ label, children }: { label: string; children: ReactNode }) {
	return (
		// biome-ignore lint/a11y/noLabelWithoutControl: the control is the child
		<label className="flex flex-col gap-1.5 text-sm">
			<span className="text-dim">{label}</span>
			{children}
		</label>
	);
}

function Problem({ error }: { error: unknown }) {
	const { explain } = useI18n();
	if (!error) return null;
	return (
		<p role="alert" className="text-sm text-danger">
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
				<input
					value={username}
					onChange={(event) => setUsername(event.target.value)}
					autoComplete="username"
					required
					className={input}
				/>
			</Field>
			<Field label={t("account.newPassword")}>
				<input
					type="password"
					value={password}
					onChange={(event) => setPassword(event.target.value)}
					autoComplete="new-password"
					minLength={MIN_PASSWORD}
					required
					className={input}
				/>
			</Field>
			<Field label={t("account.passwordAgain")}>
				<input
					type="password"
					value={again}
					onChange={(event) => setAgain(event.target.value)}
					autoComplete="new-password"
					required
					className={input}
				/>
			</Field>
			<p className="text-xs text-dim">
				{mismatch
					? t("account.passwordsDiffer")
					: t("account.passwordHint", { min: MIN_PASSWORD })}
			</p>
			<Problem error={error} />
			<button
				type="submit"
				disabled={pending || mismatch || password.length < MIN_PASSWORD}
				className={primary}
			>
				{action}
			</button>
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
			<div>
				<h1 className="text-xl font-semibold">{t("setup.title")}</h1>
				<p className="mt-2 text-sm leading-relaxed text-dim">
					{t("setup.intro")}
				</p>
			</div>
			<NewAccount
				submit={(username, password) => setup.mutate({ username, password })}
				pending={setup.isPending}
				error={setup.error}
				action={t("setup.create")}
			>
				<Field label={t("setup.code")}>
					<input
						value={code}
						onChange={(event) => setCode(event.target.value)}
						autoComplete="off"
						spellCheck={false}
						required
						placeholder="XXXX-XXXX-XXXX"
						className={`${input} font-mono uppercase`}
					/>
				</Field>
			</NewAccount>
		</>
	);
}

function SignIn() {
	const { t } = useI18n();
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
	return (
		<>
			<h1 className="text-xl font-semibold">{t("signin.title")}</h1>
			<form className="flex flex-col gap-4" onSubmit={submit}>
				{asksCode ? (
					<Field label={t("signin.code")}>
						<input
							value={code}
							onChange={(event) => setCode(event.target.value)}
							inputMode="numeric"
							autoComplete="one-time-code"
							// biome-ignore lint/a11y/noAutofocus: the step that opens asks for it
							autoFocus
							required
							className={`${input} font-mono tracking-widest`}
						/>
					</Field>
				) : (
					<>
						<Field label={t("account.username")}>
							<input
								value={username}
								onChange={(event) => setUsername(event.target.value)}
								autoComplete="username"
								required
								className={input}
							/>
						</Field>
						<Field label={t("account.password")}>
							<input
								type="password"
								value={password}
								onChange={(event) => setPassword(event.target.value)}
								autoComplete="current-password"
								required
								className={input}
							/>
						</Field>
					</>
				)}
				{!asked && <Problem error={login.error} />}
				<button type="submit" disabled={login.isPending} className={primary}>
					{t("signin.submit")}
				</button>
				{asksCode && (
					<button
						type="button"
						onClick={() => {
							setAsksCode(false);
							setCode("");
							login.reset();
						}}
						className={secondary}
					>
						{t("common.back")}
					</button>
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
				<Problem error={invite.error} />
				<a href="#/" className={secondary}>
					{t("signin.title")}
				</a>
			</>
		);
	}
	return (
		<>
			<div>
				<h1 className="text-xl font-semibold">{t("invite.title")}</h1>
				<p className="mt-2 text-sm leading-relaxed text-dim">
					{t("invite.intro", { role: roleText(t, invite.data.role) })}
				</p>
			</div>
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
				{save.isSuccess ? (
					<p className="text-sm text-good">{t("reset.done")}</p>
				) : (
					<Problem error={reset.error} />
				)}
				<button type="button" onClick={reload} className={primary}>
					{signedIn && !save.isSuccess ? t("reset.open") : t("signin.title")}
				</button>
			</>
		);
	}
	return (
		<>
			<div>
				<h1 className="text-xl font-semibold">{t("account.choosePassword")}</h1>
				<p className="mt-2 text-sm leading-relaxed text-dim">
					{t("reset.intro", { name: reset.data.username })}
				</p>
			</div>
			<form
				className="flex flex-col gap-4"
				onSubmit={(event) => {
					event.preventDefault();
					if (!mismatch) save.mutate();
				}}
			>
				<Field label={t("account.newPassword")}>
					<input
						type="password"
						value={password}
						onChange={(event) => setPassword(event.target.value)}
						autoComplete="new-password"
						minLength={MIN_PASSWORD}
						required
						className={input}
					/>
				</Field>
				<Field label={t("account.passwordAgain")}>
					<input
						type="password"
						value={again}
						onChange={(event) => setAgain(event.target.value)}
						autoComplete="new-password"
						required
						className={input}
					/>
				</Field>
				<p className="text-xs text-dim">
					{mismatch
						? t("account.passwordsDiffer")
						: t("account.passwordHint", { min: MIN_PASSWORD })}
				</p>
				<Problem error={save.error} />
				<button
					type="submit"
					disabled={
						save.isPending || mismatch || password.length < MIN_PASSWORD
					}
					className={primary}
				>
					{t("reset.submit")}
				</button>
			</form>
		</>
	);
}

/** A temporary password is replaced before anything else. */
function ChoosePassword() {
	const { t } = useI18n();
	return (
		<>
			<div>
				<h1 className="text-xl font-semibold">{t("account.choosePassword")}</h1>
				<p className="mt-2 text-sm leading-relaxed text-dim">
					{t("account.choosePasswordIntro")}
				</p>
			</div>
			<PasswordForm onDone={reload} />
			<SignOut />
		</>
	);
}

function PasswordForm({ onDone }: { onDone?: () => void }) {
	const { t } = useI18n();
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
			className="flex flex-col gap-3"
			onSubmit={(event) => {
				event.preventDefault();
				setDone(false);
				change.mutate();
			}}
		>
			<Field label={t("account.currentPassword")}>
				<input
					type="password"
					value={current}
					onChange={(event) => setCurrent(event.target.value)}
					autoComplete="current-password"
					required
					className={input}
				/>
			</Field>
			<Field label={t("account.newPassword")}>
				<input
					type="password"
					value={next}
					onChange={(event) => setNext(event.target.value)}
					autoComplete="new-password"
					minLength={MIN_PASSWORD}
					required
					className={input}
				/>
			</Field>
			<p className="text-xs text-dim">
				{t("account.passwordHint", { min: MIN_PASSWORD })}
			</p>
			<Problem error={change.error} />
			{done && (
				<p className="text-sm text-good">{t("account.passwordChanged")}</p>
			)}
			<button
				type="submit"
				disabled={change.isPending || next.length < MIN_PASSWORD}
				className={`self-start ${primary}`}
			>
				{t("account.changePassword")}
			</button>
		</form>
	);
}

export function SignOut({ className = secondary }: { className?: string }) {
	const { t } = useI18n();
	const out = useMutation({ mutationFn: api.logout, onSettled: reload });
	return (
		<button
			type="button"
			onClick={() => out.mutate()}
			disabled={out.isPending}
			className={className}
		>
			{t("account.signOut")}
		</button>
	);
}

/** Who is signed in, and a way out, at the foot of the navigation. */
export function AccountMenu({ className }: { className: string }) {
	const account = useAccount();
	const { t } = useI18n();
	if (!account) return null;
	return (
		<div className="flex items-center justify-between gap-2 px-3 py-1">
			<span className="min-w-0 truncate text-sm" title={account.username}>
				{account.displayName}
				<span className="ml-2 font-mono text-[11px] text-dim uppercase">
					{roleText(t, account.role)}
				</span>
			</span>
			<SignOut className={className} />
		</div>
	);
}

/** Settings > Account: password, two-step sign-in, and where one is signed in. */
export function AccountSettings() {
	const account = useAccount();
	const { t } = useI18n();
	if (!account) return null;
	return (
		<section className="mt-10">
			<h2 className="font-medium">{t("account.title")}</h2>
			<p className="mt-2 text-sm text-dim">
				{t("account.signedInAs", { name: account.username })}
			</p>
			<div className="mt-4 rounded-lg border border-line bg-panel p-4">
				<h3 className="mb-3 font-medium">{t("account.changePassword")}</h3>
				<PasswordForm />
			</div>
			<TwoStep enabled={account.totp} />
			<Sessions />
		</section>
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
		<input
			type="password"
			value={password}
			onChange={(event) => setPassword(event.target.value)}
			placeholder={t("account.currentPassword")}
			aria-label={t("account.currentPassword")}
			autoComplete="current-password"
			className={`min-w-0 flex-1 ${input}`}
		/>
	);
	const codeField = (
		value: string,
		set: (value: string) => void,
		label: string,
	) => (
		<input
			value={value}
			onChange={(event) => set(event.target.value)}
			placeholder="123456"
			aria-label={label}
			title={label}
			inputMode="numeric"
			autoComplete="one-time-code"
			className={`w-36 font-mono tracking-widest ${input}`}
		/>
	);
	const newApp = start.data && (
		<>
			<p className="text-sm">{t("account.twoStepAdd")}</p>
			<a
				href={start.data.uri}
				className="break-all font-mono text-xs text-accent underline"
			>
				{start.data.uri}
			</a>
			<p className="text-sm">
				{t("account.twoStepSecret")}{" "}
				<code className="font-mono text-sm tracking-wider">
					{start.data.secret.replace(/(.{4})/g, "$1 ").trim()}
				</code>
			</p>
		</>
	);
	return (
		<div className="mt-4 rounded-lg border border-line bg-panel p-4">
			<div className="flex items-baseline justify-between gap-4">
				<h3 className="font-medium">{t("account.twoStep")}</h3>
				<span
					className={`font-mono text-xs ${enabled ? "text-accent" : "text-dim"}`}
				>
					{enabled ? t("account.twoStepOn") : t("account.twoStepOff")}
				</span>
			</div>
			<p className="mt-2 text-sm leading-relaxed text-dim">
				{t("account.twoStepIntro")}
			</p>
			{enabled && start.data ? (
				<form
					className="mt-3 flex flex-col gap-3"
					onSubmit={(event) => {
						event.preventDefault();
						enable.mutate();
					}}
				>
					{newApp}
					<p className="text-sm text-dim">{t("account.twoStepMoveHint")}</p>
					<div className="flex flex-wrap gap-2">
						{passwordField}
						{codeField(current, setCurrent, t("account.twoStepOldCode"))}
						{codeField(code, setCode, t("account.twoStepNewCode"))}
					</div>
					<div className="flex gap-2">
						<button
							type="submit"
							disabled={!password || !current || !code || enable.isPending}
							className={primary}
						>
							{t("account.twoStepMoveConfirm")}
						</button>
						<button
							type="button"
							onClick={() => {
								start.reset();
								enable.reset();
								setCode("");
								setCurrent("");
							}}
							className={secondary}
						>
							{t("common.cancel")}
						</button>
					</div>
				</form>
			) : enabled ? (
				<>
					<form
						className="mt-3 flex flex-wrap gap-2"
						onSubmit={(event) => {
							event.preventDefault();
							disable.mutate();
						}}
					>
						{passwordField}
						{codeField(current, setCurrent, t("signin.code"))}
						<button
							type="submit"
							disabled={!password || !current || disable.isPending}
							className={secondary}
						>
							{t("account.twoStepDisable")}
						</button>
					</form>
					<button
						type="button"
						onClick={() => {
							disable.reset();
							start.mutate();
						}}
						disabled={start.isPending}
						className={`mt-3 ${secondary}`}
					>
						{t("account.twoStepMove")}
					</button>
				</>
			) : start.data ? (
				<form
					className="mt-3 flex flex-col gap-3"
					onSubmit={(event) => {
						event.preventDefault();
						enable.mutate();
					}}
				>
					{newApp}
					<div className="flex flex-wrap gap-2">
						{passwordField}
						{codeField(code, setCode, t("signin.code"))}
						<button
							type="submit"
							disabled={!code || !password || enable.isPending}
							className={primary}
						>
							{t("account.twoStepConfirm")}
						</button>
					</div>
				</form>
			) : (
				<button
					type="button"
					onClick={() => start.mutate()}
					disabled={start.isPending}
					className={`mt-3 ${secondary}`}
				>
					{t("account.twoStepEnable")}
				</button>
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
		<div className="mt-4 rounded-lg border border-line bg-panel p-4">
			<div className="flex items-baseline justify-between gap-4">
				<h3 className="font-medium">{t("account.sessions")}</h3>
				{(sessions.data?.length ?? 0) > 1 && (
					<button
						type="button"
						onClick={() => others.mutate()}
						disabled={others.isPending}
						className="text-xs text-dim hover:text-danger"
					>
						{t("account.signOutOthers")}
					</button>
				)}
			</div>
			<ul className="mt-3 flex flex-col gap-2">
				{sessions.data?.map((session) => (
					<li
						key={session.id}
						className="flex items-center justify-between gap-3 text-sm"
					>
						<span className="min-w-0">
							<span className="block truncate">
								{session.userAgent ?? t("account.unknownBrowser")}
							</span>
							<span className="font-mono text-xs text-dim">
								{session.current
									? t("account.thisBrowser")
									: t("account.lastSeen", { when: date(session.lastSeenAt) })}
								{session.ip ? ` · ${session.ip}` : ""}
							</span>
						</span>
						{!session.current && (
							<button
								type="button"
								onClick={() => revoke.mutate(session.id)}
								className="shrink-0 text-xs text-dim hover:text-danger"
							>
								{t("account.signOutThere")}
							</button>
						)}
					</li>
				))}
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
		<section className="mt-10">
			<h2 className="font-medium">{t("users.title")}</h2>
			<p className="mt-2 text-sm leading-relaxed text-dim">
				{t("users.intro")}
			</p>
			<NewInvite owner={account.role === "owner"} />
			<Invites />
			<People me={account} />
		</section>
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
	// Admins make members only.
	const roles: UserRole[] = owner ? ["member", "admin", "owner"] : ["member"];
	return (
		<div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
			{owner ? (
				<select
					value={terms.role}
					onChange={(event) =>
						setTerms({ ...terms, role: event.target.value as UserRole })
					}
					aria-label={t("users.role")}
					className="rounded-md border border-line bg-bg px-2 py-1.5 text-sm"
				>
					{roles.map((role) => (
						<option key={role} value={role}>
							{roleText(t, role)}
						</option>
					))}
				</select>
			) : (
				// Admins make members only: nothing to choose.
				<span className="text-dim">{roleText(t, terms.role)}</span>
			)}
			{terms.role === "member" && (
				<>
					<label className="flex items-center gap-2">
						<input
							type="checkbox"
							checked={terms.canUsePaid}
							onChange={(event) =>
								setTerms({ ...terms, canUsePaid: event.target.checked })
							}
						/>
						{t("users.canUsePaid")}
					</label>
					<label className="flex items-center gap-2">
						<input
							type="checkbox"
							checked={terms.canTrain}
							onChange={(event) =>
								setTerms({ ...terms, canTrain: event.target.checked })
							}
						/>
						{t("users.canTrain")}
					</label>
				</>
			)}
			{/* biome-ignore lint/a11y/noLabelWithoutControl: the input is inside */}
			<label className="flex items-center gap-2">
				{t("users.limit")}
				<LimitInput
					value={terms.monthlyLimitUsd}
					placeholder={t("users.noLimit")}
					onCommit={(monthlyLimitUsd) =>
						setTerms({ ...terms, monthlyLimitUsd })
					}
				/>
			</label>
		</div>
	);
}

/**
 * A dollar amount, or nothing for no limit. Saved when the field is left or
 * Enter is pressed, not at every key.
 */
function LimitInput({
	value,
	placeholder,
	onCommit,
}: {
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
		<input
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
			className="w-24 rounded-md border border-line bg-bg px-2 py-1.5 font-mono text-sm"
		/>
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
		<div className="mt-4 rounded-lg border border-line bg-panel p-4">
			<h3 className="mb-3 font-medium">{t("users.invite")}</h3>
			<Terms terms={terms} setTerms={setTerms} owner={owner} />
			<button
				type="button"
				onClick={() => create.mutate()}
				disabled={create.isPending}
				className={`mt-3 ${primary}`}
			>
				{t("users.createInvite")}
			</button>
			{link && (
				<div className="mt-3 flex flex-col gap-2">
					<p className="text-sm text-dim">{t("users.inviteLink")}</p>
					<div className="flex gap-2">
						<input
							readOnly
							value={link}
							aria-label={t("users.inviteLink")}
							onFocus={(event) => event.target.select()}
							className={`min-w-0 flex-1 font-mono text-xs ${input}`}
						/>
						<button
							type="button"
							onClick={() =>
								void navigator.clipboard
									?.writeText(link)
									.then(() => setCopied(true))
							}
							className={secondary}
						>
							{copied ? t("settings.agentsCopied") : t("settings.agentsCopy")}
						</button>
					</div>
				</div>
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
		<div className="mt-4 rounded-lg border border-line bg-panel p-4">
			<h3 className="font-medium">{t("users.openInvites")}</h3>
			<ul className="mt-3 flex flex-col gap-2">
				{open.map((invite) => (
					<li
						key={invite.id}
						className="flex items-center justify-between gap-3 text-sm"
					>
						<span>
							{roleText(t, invite.role)}
							<span className="ml-2 font-mono text-xs text-dim">
								{t("users.expires", { when: date(invite.expiresAt) })}
							</span>
						</span>
						<button
							type="button"
							onClick={() => remove.mutate(invite.id)}
							className="text-xs text-dim hover:text-danger"
						>
							{t("users.revokeInvite")}
						</button>
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
		<div className="mt-4 rounded-lg border border-line bg-panel p-4">
			<h3 className="font-medium">{t("users.people")}</h3>
			<ul className="mt-3 flex flex-col divide-y divide-line">
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
	return (
		<li className="flex flex-col gap-2 py-3">
			<div className="flex items-baseline justify-between gap-3">
				<span
					className={`font-medium ${user.disabled ? "text-dim line-through" : ""}`}
				>
					{user.username}
					{user.id === me.id && (
						<span className="ml-2 text-xs text-dim">{t("users.you")}</span>
					)}
				</span>
				{user.totp && (
					<span className="font-mono text-[11px] text-dim uppercase">
						{t("account.twoStepOn")}
					</span>
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
			{mayChange ? (
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
					<div className="flex flex-wrap gap-2">
						{user.id !== me.id && (
							<button
								type="button"
								onClick={() => update.mutate({ disabled: !user.disabled })}
								className={secondary}
							>
								{user.disabled ? t("users.enable") : t("users.disable")}
							</button>
						)}
						{user.id !== me.id && (
							<button
								type="button"
								onClick={() => reset.mutate()}
								disabled={reset.isPending}
								className={secondary}
							>
								{t("users.resetPassword")}
							</button>
						)}
					</div>
				</>
			) : (
				<p className="text-sm text-dim">{roleText(t, user.role)}</p>
			)}
			{link && (
				<div className="flex flex-col gap-2">
					<p className="text-sm text-dim">
						{t("users.resetLink", { name: user.username })}
					</p>
					<div className="flex gap-2">
						<input
							readOnly
							value={link}
							aria-label={t("users.resetLink", { name: user.username })}
							onFocus={(event) => event.target.select()}
							className={`min-w-0 flex-1 font-mono text-xs ${input}`}
						/>
						<button
							type="button"
							onClick={() =>
								void navigator.clipboard
									?.writeText(link)
									.then(() => setCopied(true))
							}
							className={secondary}
						>
							{copied ? t("settings.agentsCopied") : t("settings.agentsCopy")}
						</button>
					</div>
				</div>
			)}
			<Problem error={update.error ?? reset.error} />
		</li>
	);
}
