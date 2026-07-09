import { describe, expect, test } from "vitest";
import { parseGitStatusPorcelainZ } from "../backend/services/git-status.js";

describe("parseGitStatusPorcelainZ", () => {
  test("parses paths with spaces and rename records from NUL-delimited porcelain", () => {
    const output = [
      " M file with spaces.js",
      "R  new name.js",
      "old name.js",
      "?? weird -> literal.txt",
      "",
    ].join("\0");

    expect(parseGitStatusPorcelainZ(output)).toEqual([
      "file with spaces.js",
      "new name.js",
      "weird -> literal.txt",
    ]);
  });
});
