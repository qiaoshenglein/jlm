import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Toaster } from "@/components/ui/sonner";
import App from "./App";
import "./globals.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
    <Toaster theme="dark" position="top-center" richColors closeButton toastOptions={{ duration: 4000 }} />
  </StrictMode>,
);
