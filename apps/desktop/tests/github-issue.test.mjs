import assert from "node:assert/strict";
import { test } from "node:test";
import { briefWithIssueSource } from "../src/github-issue.ts";

test("issue source travels with the original body or excerpt", () => {
  const url = "https://github.com/example/project/issues/9";
  const excerpt = "- [x] Done\n\n```Unterminated\n";
  assert.equal(briefWithIssueSource(excerpt, url), "Source: <" + url + ">\n\n" + excerpt);
  assert.equal(briefWithIssueSource("", url), "Source: <" + url + ">");
  assert.equal(briefWithIssueSource(excerpt), excerpt);
});
