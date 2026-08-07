import {
  assert,
  assertEqual,
  assertIncludes,
  installLocation,
  mockFetch,
  jsonResponse,
  test,
  summary,
  resetCounters,
} from "./helpers.mjs";
import { RagClient } from "../js/memory/rag.js";

export async function runRagClientTests() {
  resetCounters();
  console.log("\n== RagClient ==");
  installLocation();

  await test("skips query when disabled", async () => {
    const rag = new RagClient({ baseUrl: "http://127.0.0.1:8765", enabled: false });
    const r = await rag.query("anything");
    assertEqual(r.skipped, true);
    assertEqual(r.hits.length, 0);
  });

  await test("query maps hits and builds system block", async () => {
    const restore = mockFetch(async (url, init) => {
      assertIncludes(url, "/api/rag/query");
      const body = JSON.parse(init.body);
      assertEqual(body.query, "ollama flux");
      return jsonResponse(200, {
        hits: [{ text: "Use 0.32.5", source: "doc", score: 0.9 }],
      });
    });
    try {
      const rag = new RagClient({ baseUrl: "http://127.0.0.1:8765", enabled: true });
      const r = await rag.query("ollama flux", { topK: 3 });
      assert(r.ok);
      assertEqual(r.hits.length, 1);
      const block = rag.toSystemBlock(r.hits);
      assertIncludes(block, "0.32.5");
      assertIncludes(block, "doc");
    } finally {
      restore();
    }
  });

  await test("ingest posts text to API", async () => {
    const restore = mockFetch(async (url, init) => {
      assertIncludes(url, "/api/rag/ingest");
      assertEqual(init.method, "POST");
      const body = JSON.parse(init.body);
      assertIncludes(body.text, "note body");
      return jsonResponse(200, { ok: true, added: 1, total: 1 });
    });
    try {
      const rag = new RagClient({ baseUrl: "http://127.0.0.1:8765" });
      const r = await rag.ingest("note body", { source: "test" });
      assertEqual(r.added, 1);
    } finally {
      restore();
    }
  });

  return summary("RagClient");
}
