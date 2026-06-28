import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createLocalSession, updateLocalSession } from "./local-sessions";

const TEST_CWD = "/tmp/mocode-test-project";
const PROJECTS_DIR = join(homedir(), ".mocode-test-sessions", "projects");

function normalizedProjectDir(cwd: string): string {
  return join(PROJECTS_DIR, cwd.replace(/\//g, "-"));
}

describe("local-sessions", () => {
  beforeEach(() => {
    const dir = normalizedProjectDir(TEST_CWD);
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true });
    }
  });

  afterEach(() => {
    const dir = normalizedProjectDir(TEST_CWD);
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true });
    }
  });

  test("createLocalSession writes sessions-index.json under normalized cwd path per D-10", () => {
    const session = createLocalSession("Test Session", { cwd: TEST_CWD, projectsDir: PROJECTS_DIR });

    const indexPath = join(normalizedProjectDir(TEST_CWD), "sessions-index.json");
    expect(existsSync(indexPath)).toBe(true);

    const index = JSON.parse(readFileSync(indexPath, "utf-8"));
    expect(index.sessions.some((s: { id: string }) => s.id === session.id)).toBe(true);
  });

  test("createLocalSession writes session-id.json file", () => {
    const session = createLocalSession("Test Session", { cwd: TEST_CWD, projectsDir: PROJECTS_DIR });

    const sessionPath = join(normalizedProjectDir(TEST_CWD), `${session.id}.json`);
    expect(existsSync(sessionPath)).toBe(true);

    const data = JSON.parse(readFileSync(sessionPath, "utf-8"));
    expect(data.id).toBe(session.id);
    expect(data.title).toBe("Test Session");
  });

  test("updateLocalSession persists messages to session file", () => {
    const session = createLocalSession("Test", { cwd: TEST_CWD, projectsDir: PROJECTS_DIR });
    const messages = [{ id: "msg-1", role: "user" as const, parts: [{ type: "text" as const, text: "hello" }] }];

    updateLocalSession(session.id, messages, { cwd: TEST_CWD, projectsDir: PROJECTS_DIR });

    const sessionPath = join(normalizedProjectDir(TEST_CWD), `${session.id}.json`);
    const data = JSON.parse(readFileSync(sessionPath, "utf-8"));
    expect(data.messages).toEqual(messages);
  });
});
