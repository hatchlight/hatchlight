import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Gate } from "./Accounts";
import { App } from "./App";
import { I18nProvider } from "./i18n";
import "./index.css";

const client = new QueryClient({
	defaultOptions: { queries: { staleTime: 30_000, retry: 1 } },
});

createRoot(document.getElementById("root") as HTMLElement).render(
	<StrictMode>
		<I18nProvider>
			<QueryClientProvider client={client}>
				<Gate>
					<App />
				</Gate>
			</QueryClientProvider>
		</I18nProvider>
	</StrictMode>,
);
