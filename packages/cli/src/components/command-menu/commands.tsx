import type { Command } from "./types";
import { 
  ThemeDialogContent, 
  AgentsDialogContent, 
  SessionDialogContent,
  ModelsDialogContent,
  KeysWizardDialogContent,
  McpDialogContent,
} from "../dialogs";
import { SUPPORTED_CHAT_MODELS } from "@mocode/shared";
import { getSessionChatActions } from "../../providers/session-chat-actions";
import { resolveResumeTransport } from "../../lib/stream-interrupt";

// browser OAuth login and local token lifecycle.
import { performLogin } from "../../lib/oauth";
import { clearAuth } from "../../lib/auth";
import { openUpgradeCheckout, openBillingPortal } from "../../lib/upgrade";

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
    name: "resume",
    description: "Regenerate from last user message (not Claude Code session picker)",
    value: "/resume",
    action: (ctx) => {
      const actions = getSessionChatActions();
      if (!actions) {
        ctx.toast.show({ variant: "error", message: "Open a session first" });
        return;
      }

      const eligibility = actions.getEligibility();
      const transport = resolveResumeTransport(eligibility);
      if (transport === "none") {
        ctx.toast.show({ variant: "error", message: "No resumable generation" });
        return;
      }

      void actions.continueGeneration({ mode: ctx.mode, model: ctx.model }).catch((error) => {
        ctx.toast.show({
          variant: "error",
          message: error instanceof Error ? error.message : "Resume failed",
        });
      });
    },
  },
  {
    name: "explore",
    description: "Delegate read-only codebase exploration to the explore subagent",
    value: "/explore",
    action: (ctx) => {
      if (!ctx.submit) {
        ctx.toast.show({ variant: "error", message: "Open a session first" });
        return;
      }
      void ctx.submit("/explore ");
    },
  },
  {
    name: "plan-research",
    description: "Delegate architecture and tradeoff research to the plan-research subagent",
    value: "/plan-research",
    action: (ctx) => {
      if (!ctx.submit) {
        ctx.toast.show({ variant: "error", message: "Open a session first" });
        return;
      }
      void ctx.submit("/plan-research ");
    },
  },
  {
    name: "mcp",
    description: "Manage MCP servers",
    value: "/mcp",
    action: (ctx) => {
      ctx.dialog.open({
        title: "MCP Servers",
        children: <McpDialogContent />,
      });
    },
  },
  {
    name: "keys",
    description: "Configure API keys",
    value: "/keys",
    action: (ctx) => {
      ctx.dialog.open({
        title: "API Keys",
        children: <KeysWizardDialogContent />,
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
  // --- Billing (phase 10) ---
  {
    name: "upgrade",
    description: "Buy more credits",
    value: "/upgrade",
    action: async (ctx) => {
      ctx.toast.show({
        message: "Opening credits checkout...",
      });
      try{
        // Opens Polar checkout in the system browser via POST /billing/checkout.
        await openUpgradeCheckout();
        ctx.toast.show({ variant: "success", message: "Checkout opened" });
      }catch(error){
        const message = error instanceof Error 
          ? error.message 
          : "Failed to open checkout";
        ctx.toast.show({ variant: "error", message });
      }
    },
  },
  {
    name: "usage",
    description: "Open billing portal in your browser",
    value: "/usage",
    action: async(ctx) => {
      ctx.toast.show({
        message: "Opening billing portal...",
      });
      try{
        // Polar customer portal for invoices and payment method via POST /billing/portal.
        await openBillingPortal();
        ctx.toast.show({ variant: "success", message: "Billing portal opened" });
      }catch(error){
        const message = error instanceof Error 
          ? error.message 
          : "Failed to open billing portal";
        ctx.toast.show({ variant: "error", message });
      }
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