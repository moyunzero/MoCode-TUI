import type { Command } from "./types";
import { 
  ThemeDialogContent, 
  AgentsDialogContent, 
  SessionDialogContent,
  ModelsDialogContent
} from "../dialogs";
import { SUPPORTED_CHAT_MODELS } from "@mocode/shared";

// Phase 9: browser OAuth login and local token lifecycle.
import { performLogin } from "../../lib/oauth";
import { clearAuth } from "../../lib/auth";

/** Slash-command registry. Each entry may define an `action` that receives toast/dialog/exit context. */
export const COMMANDS: Command[] = [
  {
    name: "new",
    description: "Start a new conversation",
    value: "/new",
    action: (ctx) => {
      ctx.navigate("/");
    },
  },
  // --- Prompt configuration dialogs (phase 7) ---
  {
    name: "agents",
    description: "Switch agents",
    value: "/agents",
    action: (ctx) => {
      ctx.dialog.open({
        title: "Select Agent",
        children: <AgentsDialogContent 
          currentMode={ctx.mode} 
          onSelectMode={(nextMode)=>ctx.setMode(nextMode)} 
        />
      });
    },
  },
  {
    name: "models",
    description: "Select AI model for generation",
    value: "/models",
    action: (ctx) => {
      ctx.dialog.open({
        title: "Select Model",
        children: (
          <ModelsDialogContent 
            models={SUPPORTED_CHAT_MODELS.map((model)=>model.id)}
            onSelectModel={ctx.setModel} 
          />
        )
      });
    },
  },
  {
    name: "sessions",
    description: "Browse past sessions",
    value: "/sessions",
    action: (ctx) => {
      ctx.dialog.open({
        title: "Select Session",
        children: <SessionDialogContent />
      });
    },
  },
  {
    name: "theme",
    description: "Change color theme",
    value: "/theme",
    action: (ctx) => {
      ctx.dialog.open({
        title: "Select Theme",
        children: <ThemeDialogContent />
      });
    },
  },
  // --- Authentication (phase 9) ---
  {
    name: "login",
    description: "Sign in with your browser",
    value: "/login",
    action: async (ctx) => {
      ctx.toast.show({ message: "Opening browser to sign in..." });

      try {
        // PKCE OAuth via Clerk; token persisted to ~/.mocode/auth.json on success.
        await performLogin();
        ctx.toast.show({ variant: "success", message: "Signed in" });
      } catch (error) {
        const message = error instanceof Error 
          ? error.message 
          : "Sign in failed or timed out";

        ctx.toast.show({ variant: "error", message });
      }
    },
  },
  {
    name: "logout",
    description: "Sign out of your account",
    value: "/logout",
    action: (ctx) => {
      // Local sign-out only; no server-side session revocation yet.
      clearAuth();
      ctx.toast.show({ variant: "success", message: "Signed out" });
    },
  },
  {
    name: "upgrade",
    description: "Buy more credits",
    value: "/upgrade",
    action: (ctx) => {
      ctx.toast.show({
        message: "Opening credits checkout...",
      });
    },
  },
  {
    name: "usage",
    description: "Open billing portal in your browser",
    value: "/usage",
    action: (ctx) => {
      ctx.toast.show({
        message: "Opening billing portal...",
      });
    },
  },
  {
    name: "exit",
    description: "Quit the application",
    value: "/exit",
    action: (ctx) => {
      ctx.exit();
    },
  }
];