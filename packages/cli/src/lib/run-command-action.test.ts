import { describe, expect, test } from "bun:test";
import { runCommandAction } from "./run-command-action";

describe("runCommandAction", () => {
  test("forwards async rejections to onError", async () => {
    const errors: string[] = [];

    runCommandAction(
      async () => {
        throw new Error("agents dialog failed");
      },
      {} as never,
      (message) => errors.push(message),
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(errors).toEqual(["agents dialog failed"]);
  });

  test("ignores resolved async actions", async () => {
    const errors: string[] = [];
    let ran = false;

    runCommandAction(
      async () => {
        ran = true;
      },
      {} as never,
      (message) => errors.push(message),
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ran).toBe(true);
    expect(errors).toEqual([]);
  });
});
