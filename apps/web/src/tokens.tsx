import type { ApiTokenView, TokenScope } from "@hatchlight/core/types";
import { type I18n, useI18n } from "./i18n";

/** How a scope is named on screen. */
export function scopeText(t: I18n["t"], scope: TokenScope): string {
	switch (scope) {
		case "read":
			return t("tokens.scopeRead");
		case "generate":
			return t("tokens.scopeGenerate");
		case "paid":
			return t("tokens.scopePaid");
		case "train":
			return t("tokens.scopeTrain");
	}
}

/** A token's scopes, limit, spending and dates, in one line. */
export function TokenFacts({ token }: { token: ApiTokenView }) {
	const { t, date, number } = useI18n();
	// Small limits, such as $0.015, are shown as they are.
	const usd = (value: number) =>
		number(value, {
			style: "currency",
			currency: "USD",
			minimumFractionDigits: 2,
			maximumFractionDigits: 4,
		});
	return (
		<span className="text-xs text-dim">
			{[
				token.scopes.map((scope) => scopeText(t, scope)).join(", "),
				token.spendLimitUsd == null
					? t("tokens.spent", { spent: usd(token.spentUsd) })
					: t("tokens.spentOf", {
							spent: usd(token.spentUsd),
							limit: usd(token.spendLimitUsd),
						}),
				token.lastUsedAt == null
					? t("tokens.neverUsed")
					: t("tokens.lastUsed", { date: date(token.lastUsedAt) }),
				token.expiresAt == null
					? t("tokens.noExpiry")
					: token.expiresAt < Date.now()
						? t("tokens.expired")
						: t("tokens.expires", { date: date(token.expiresAt) }),
			].join(" · ")}
		</span>
	);
}
