import assert from "node:assert/strict";
import { test } from "node:test";
import { renderSafeMarkdown } from "../src/markdown.js";

test("renders markdown while removing unsafe HTML and link protocols", async () => {
  const html = await renderSafeMarkdown(
    "Respuesta **importante**. <img src=x onerror=alert(1)> " +
      "[enlace](javascript:alert(1))",
  );
  assert.match(html, /<strong>importante<\/strong>/);
  assert.doesNotMatch(html, /<img|onerror|javascript:/i);
});
