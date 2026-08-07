import {
  assert,
  assertIncludes,
  mockFetch,
  jsonResponse,
  test,
  summary,
  resetCounters,
} from "./helpers.mjs";
import { ConversationStore } from "../js/memory/conversation.js";
import { Summarizer } from "../js/memory/summarizer.js";

export async function runSummarizerTests() {
  resetCounters();
  console.log("\n== Summarizer ==");

  await test("skips compression under budget", async () => {
    const store = new ConversationStore();
    store.pushUser("short");
    store.pushAssistant("ok");
    const sum = new Summarizer({
      ollamaUrl: "http://127.0.0.1:11434",
      getModel: () => "ministral-3:8b",
      charBudget: 10000,
      keepRecentChars: 5000,
    });
    const r = await sum.maybeCompress(store);
    assertEqualish(r, { summarized: false, dropped: 0 });
    assert(!sum.summary, "no summary when under budget");
  });

  await test("compresses oversized history via Ollama chat mock", async () => {
    const store = new ConversationStore();
    for (let i = 0; i < 20; i++) {
      store.pushUser(`question ${i} ` + "detail ".repeat(40));
      store.pushAssistant(`answer ${i} ` + "text ".repeat(40));
    }
    store.pushUser("latest question about Silo");
    store.pushAssistant("", {
      tool_calls: [{ function: { name: "web_search", arguments: { query: "Silo" } } }],
    });
    store.pushTool({
      tool_name: "web_search",
      content: "Silo season notes " + "x".repeat(200),
    });
    store.pushAssistant("Silo is returning.");

    const restore = mockFetch(async (url) => {
      assertIncludes(url, "/api/chat");
      return jsonResponse(200, {
        message: {
          content:
            "User asked many prior questions. Latest topic: Silo series return. Tool search confirmed notes.",
        },
      });
    });

    try {
      const sum = new Summarizer({
        ollamaUrl: "http://127.0.0.1:11434",
        getModel: () => "ministral-3:8b",
        charBudget: 800,
        keepRecentChars: 400,
      });
      const before = store.length;
      const r = await sum.maybeCompress(store);
      assert(r.summarized, "should summarize");
      assert(r.dropped > 0, "should drop messages");
      assert(store.length < before, "store shrunk");
      assertIncludes(sum.summary, "Silo");
      assertIncludes(sum.toSystemBlock(), "Conversation summary");
      // must not leave orphan tool at head
      const head = store.getMessages()[0];
      assert(head.role !== "tool", "no orphan tool after compress");
    } finally {
      restore();
    }
  });

  await test("soft-fails to stub summary if Ollama errors", async () => {
    const store = new ConversationStore();
    for (let i = 0; i < 15; i++) {
      store.pushUser("u" + i + " " + "z".repeat(80));
      store.pushAssistant("a" + i + " " + "z".repeat(80));
    }
    const restore = mockFetch(async () => jsonResponse(500, { error: "boom" }));
    try {
      const sum = new Summarizer({
        ollamaUrl: "http://127.0.0.1:11434",
        getModel: () => "ministral-3:8b",
        charBudget: 500,
        keepRecentChars: 200,
      });
      const r = await sum.maybeCompress(store);
      assert(r.summarized, "still reports summarized after trim");
      assertIncludes(sum.summary, "omitted");
    } finally {
      restore();
    }
  });

  return summary("Summarizer");
}

function assertEqualish(actual, expected) {
  assert(actual.summarized === expected.summarized, "summarized mismatch");
  assert(actual.dropped === expected.dropped, "dropped mismatch");
}
