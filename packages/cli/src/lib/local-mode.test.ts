import { describe, expect, test } from "bun:test";
import { parseCliArgs } from "./local-mode";

describe("parseCliArgs", () => {
  test("argv containing --local returns local:true per D-09", () => {
    expect(parseCliArgs(["--local"])).toEqual({ local: true });
  });

  test("argv without --local returns local:false", () => {
    expect(parseCliArgs([])).toEqual({ local: false });
    expect(parseCliArgs(["--help"])).toEqual({ local: false });
  });

  test("--local among other flags still sets local:true", () => {
    expect(parseCliArgs(["mocode", "--local", "chat"])).toEqual({ local: true });
  });
});
