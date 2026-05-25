import assert from "node:assert/strict";
import test from "node:test";
import { formatCsv, formatTable } from "../src/format.js";

test("formatCsv escapes commas, quotes, and newlines", () => {
  const output = formatCsv(["name", "note"], [["Ada", "hello, world"], ["Lin", 'a "quote"\nline']]);

  assert.equal(output, 'name,note\nAda,"hello, world"\nLin,"a ""quote""\nline"\n');
});

test("formatTable renders headers and rows", () => {
  const output = formatTable(["id", "name"], [[1, "Ada"]], { maxWidth: 80 });

  assert.match(output, /id\s+\|\s+name/);
  assert.match(output, /1\s+\|\s+Ada/);
});
