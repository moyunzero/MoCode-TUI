/**
 * BYOK local session persistence (D-10).
 *
 * Layout: `~/.mocode/projects/<normalized-cwd>/sessions-index.json` plus
 * per-session `<session-id>.json` files with continuous write on message updates.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Message } from "../hooks/use-chat";

export type LocalSessionOptions = {
  cwd?: string;
  projectsDir?: string;
};

export type LocalSession = {
  id: string;
  title: string;
  messages: Message[];
  createdAt: string;
  updatedAt: string;
};

export type SessionIndexEntry = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
};

type SessionsIndex = {
  sessions: SessionIndexEntry[];
};

const DEFAULT_PROJECTS_DIR = join(homedir(), ".mocode", "projects");

/** Normalizes a cwd path for use as a directory name under projects/. */
export function normalizeProjectPath(cwd: string): string {
  return cwd.replace(/\//g, "-");
}

function resolveProjectDir(options?: LocalSessionOptions): string {
  const cwd = options?.cwd ?? process.cwd();
  const projectsDir = options?.projectsDir ?? DEFAULT_PROJECTS_DIR;
  return join(projectsDir, normalizeProjectPath(cwd));
}

function ensureProjectDir(projectDir: string): void {
  if (!existsSync(projectDir)) {
    mkdirSync(projectDir, { mode: 0o700, recursive: true });
  }
}

function readIndex(projectDir: string): SessionsIndex {
  const indexPath = join(projectDir, "sessions-index.json");
  try {
    const data = readFileSync(indexPath, "utf-8");
    const parsed = JSON.parse(data) as SessionsIndex;
    return { sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [] };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { sessions: [] };
    }
    throw error;
  }
}

function writeIndex(projectDir: string, index: SessionsIndex): void {
  ensureProjectDir(projectDir);
  writeFileSync(join(projectDir, "sessions-index.json"), JSON.stringify(index, null, 2), {
    mode: 0o600,
  });
}

/** Creates a new local session file and index entry. */
export function createLocalSession(title: string, options?: LocalSessionOptions): LocalSession {
  const projectDir = resolveProjectDir(options);
  const now = new Date().toISOString();
  const session: LocalSession = {
    id: randomUUID(),
    title,
    messages: [],
    createdAt: now,
    updatedAt: now,
  };

  ensureProjectDir(projectDir);
  writeFileSync(join(projectDir, `${session.id}.json`), JSON.stringify(session, null, 2), {
    mode: 0o600,
  });

  const index = readIndex(projectDir);
  index.sessions.push({
    id: session.id,
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  });
  writeIndex(projectDir, index);

  return session;
}

/** Reads a local session by id, or null when missing. */
export function getLocalSession(id: string, options?: LocalSessionOptions): LocalSession | null {
  const sessionPath = join(resolveProjectDir(options), `${id}.json`);
  try {
    const data = readFileSync(sessionPath, "utf-8");
    return JSON.parse(data) as LocalSession;
  } catch {
    return null;
  }
}

/** Lists session index entries for the current or overridden project directory. */
export function listLocalSessions(options?: LocalSessionOptions): SessionIndexEntry[] {
  return readIndex(resolveProjectDir(options)).sessions;
}

/** Persists message updates to the session file and refreshes index timestamps. */
export function updateLocalSession(
  id: string,
  messages: Message[],
  options?: LocalSessionOptions,
): void {
  const projectDir = resolveProjectDir(options);
  const session = getLocalSession(id, options);
  if (!session) {
    throw new Error(`Local session not found: ${id}`);
  }

  const updated: LocalSession = {
    ...session,
    messages,
    updatedAt: new Date().toISOString(),
  };

  writeFileSync(join(projectDir, `${id}.json`), JSON.stringify(updated, null, 2), { mode: 0o600 });

  const index = readIndex(projectDir);
  const entryIndex = index.sessions.findIndex((entry) => entry.id === id);
  if (entryIndex !== -1) {
    index.sessions[entryIndex] = {
      id: updated.id,
      title: updated.title,
      createdAt: updated.createdAt,
      updatedAt: updated.updatedAt,
    };
    writeIndex(projectDir, index);
  }
}
