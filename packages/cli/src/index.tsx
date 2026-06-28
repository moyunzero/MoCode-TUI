import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { runTerminalSetupFromArgv } from "./terminal-setup";
import { parseCliArgs, setLocalMode } from "./lib/local-mode";
import {
  disableTerminalKeyboardProtocols,
  enableTerminalKeyboardProtocols,
  KITTY_KEYBOARD_OPTIONS,
} from "./terminal-keyboard";
import { createMemoryRouter,RouterProvider } from "react-router";
import { RootLayout } from "./layouts/root-layout";
import { Home } from "./screens/home";
import { NewSession } from "./screens/new-session";
import { Session } from "./screens/session";

// Handle `--terminal-setup` before booting the TUI (macOS Apple Terminal only).
if (runTerminalSetupFromArgv(process.argv.slice(2))) {
  process.exit(0);
}

const { local } = parseCliArgs(process.argv.slice(2));
if (local) {
  setLocalMode(true);
}

const router = createMemoryRouter([
  {
    path: "/",
    element: <RootLayout />,
    children: [
      {
        index: true,
        element: <Home />
      },
      {
        path: "sessions/new",
        element: <NewSession />
      },
      {
        path: "sessions/:id",
        element: <Session />
      }
    ],
  }
])

// Provider order: theme tokens → keyboard stack → modal overlays → toasts.
function App() {
  return  <RouterProvider router={router} />;
}

// OpenTUI renderer: Kitty + modifyOtherKeys let Shift+Enter differ from Enter.
const renderer = await createCliRenderer({
  targetFps: 60,
  exitOnCtrlC: false, // /exit command owns shutdown; avoid double-handling Ctrl+C.
  useKittyKeyboard: KITTY_KEYBOARD_OPTIONS,
  onDestroy: disableTerminalKeyboardProtocols,
});
enableTerminalKeyboardProtocols(renderer);
createRoot(renderer).render(<App />);
