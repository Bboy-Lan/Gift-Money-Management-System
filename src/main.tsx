import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./App";
import { MessageCenterProvider } from "./hooks/useMessages";
import "./styles.css";
import "./message-center.css";

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 1_000, refetchOnWindowFocus: false } },
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <MessageCenterProvider><App /></MessageCenterProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
