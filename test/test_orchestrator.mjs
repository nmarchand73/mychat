import {
  assert,
  assertEqual,
  assertIncludes,
  installLocalStorage,
  installLocation,
  mockFetch,
  jsonResponse,
  test,
  summary,
  resetCounters,
} from "./helpers.mjs";
import { createMemorySystem } from "../js/memory/orchestrator.js";

export async function runOrchestratorTests() {
  resetCounters();
  console.log("\n== MemoryOrchestrator ==");
  installLocalStorage();
  installLocation();

  await test("prepareTurn injects facts into system prompt", async () => {
    const restore = mockFetch(async (url) => {
      if (url.includes("/api/rag/query")) {
        return jsonResponse(200, { hits: [] });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    try {
      const mem = createMemorySystem({
        ollamaUrl: "http://127.0.0.1:11434",
        getModel: () => "ministral-3:8b",
        apiBase: "http://127.0.0.1:8765",
      });
      mem.settings.ragEnabled = false;
      mem.settings.summarizeEnabled = false;
      mem.settings.factsEnabled = true;
      mem.facts.clear();
      mem.facts.add("User prefers French answers");
      mem.conversation.pushUser("Bonjour");

      const { messages, meta } = await mem.prepareTurn({
        prompt: "Bonjour",
        baseSystem: "You are MyChat.",
      });

      assertEqual(messages[0].role, "system");
      assertIncludes(messages[0].content, "You are MyChat.");
      assertIncludes(messages[0].content, "prefers French");
      assertEqual(messages[1].role, "user");
      assertEqual(meta.facts, 1);
      assertEqual(meta.ragHits, 0);
    } finally {
      restore();
    }
  });

  await test("prepareTurn retrieves RAG hits when enabled", async () => {
    const restore = mockFetch(async (url) => {
      if (url.includes("/api/rag/query")) {
        return jsonResponse(200, {
          hits: [
            {
              text: "FLUX.2 Klein runs on Ollama 0.32.5",
              source: "notes",
              score: 0.81,
            },
          ],
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    try {
      const mem = createMemorySystem({
        ollamaUrl: "http://127.0.0.1:11434",
        getModel: () => "ministral-3:8b",
        apiBase: "http://127.0.0.1:8765",
      });
      mem.settings.ragEnabled = true;
      mem.settings.summarizeEnabled = false;
      mem.settings.factsEnabled = false;
      mem.rag.setEnabled(true);
      mem.conversation.clear();
      mem.conversation.pushUser("Which Ollama for Flux?");

      const { messages, meta } = await mem.prepareTurn({
        prompt: "Which Ollama for Flux?",
        baseSystem: "You are MyChat.",
      });

      assertIncludes(messages[0].content, "Retrieved notes");
      assertIncludes(messages[0].content, "0.32.5");
      assertEqual(meta.ragHits, 1);
    } finally {
      restore();
    }
  });

  await test("remember_fact tool stores durable memory", () => {
    const mem = createMemorySystem({
      ollamaUrl: "http://127.0.0.1:11434",
      getModel: () => "ministral-3:8b",
    });
    mem.facts.clear();
    const schema = mem.rememberToolSchema();
    assertEqual(schema.function.name, "remember_fact");
    const result = mem.executeRememberFact({ fact: "Name is Nico" });
    assert(result.ok, "remember ok");
    assertIncludes(result.content, "Nico");
    assertEqual(mem.facts.count(), 1);
  });

  await test("export/import keeps tool history + summary", () => {
    const mem = createMemorySystem({
      ollamaUrl: "http://127.0.0.1:11434",
      getModel: () => "ministral-3:8b",
    });
    mem.clearConversationMemory();
    mem.conversation.pushUser("search");
    mem.conversation.pushAssistant("", {
      tool_calls: [{ function: { name: "web_search", arguments: { query: "q" } } }],
    });
    mem.conversation.pushTool({ tool_name: "web_search", content: "result A" });
    mem.conversation.pushAssistant("Based on result A…");
    mem.summarizer.summary = "Prior: talked about result A";

    const snap = mem.exportState();
    const mem2 = createMemorySystem({
      ollamaUrl: "http://127.0.0.1:11434",
      getModel: () => "ministral-3:8b",
    });
    mem2.clearConversationMemory();
    mem2.importState(snap);
    assertEqual(mem2.conversation.length, 4);
    assertIncludes(mem2.conversation.getMessages()[2].content, "result A");
    assertIncludes(mem2.summarizer.summary, "result A");
  });

  await test("cross-turn: later prepareTurn still sees prior tool output", async () => {
    const restore = mockFetch(async (url) => {
      if (url.includes("/api/rag/query")) return jsonResponse(200, { hits: [] });
      throw new Error(`unexpected fetch ${url}`);
    });
    try {
      const mem = createMemorySystem({
        ollamaUrl: "http://127.0.0.1:11434",
        getModel: () => "ministral-3:8b",
        apiBase: "http://127.0.0.1:8765",
      });
      mem.settings.ragEnabled = false;
      mem.settings.summarizeEnabled = false;
      mem.settings.factsEnabled = false;
      mem.clearConversationMemory();

      // Turn 1 artifacts
      mem.conversation.pushUser("meilleure série SF juin 2026");
      mem.conversation.pushAssistant("", {
        tool_calls: [
          { function: { name: "web_search", arguments: { query: "SF juin 2026" } } },
        ],
      });
      mem.conversation.pushTool({
        tool_name: "web_search",
        content: "1. Silo\n   https://example.com/silo\n   Season notes",
      });
      mem.conversation.pushAssistant("Silo semble prometteuse.");

      // Turn 2
      mem.conversation.pushUser("donne le lien du 1er résultat");
      const { messages } = await mem.prepareTurn({
        prompt: "donne le lien du 1er résultat",
        baseSystem: "You are MyChat.",
      });

      const toolMsg = messages.find((m) => m.role === "tool");
      assert(toolMsg, "prior tool message still in context");
      assertIncludes(toolMsg.content, "https://example.com/silo");
      const last = messages[messages.length - 1];
      assertEqual(last.role, "user");
      assertIncludes(last.content, "lien");
    } finally {
      restore();
    }
  });

  await test("willLikelyCompress reflects budget", () => {
    const mem = createMemorySystem({
      ollamaUrl: "http://127.0.0.1:11434",
      getModel: () => "ministral-3:8b",
    });
    mem.settings.summarizeEnabled = true;
    mem.clearConversationMemory();
    assertEqual(mem.willLikelyCompress(), false);
    mem.summarizer.charBudget = 50;
    for (let i = 0; i < 5; i++) {
      mem.conversation.pushUser("q" + i + " ".repeat(20));
      mem.conversation.pushAssistant("a" + i + " ".repeat(20));
    }
    assert(mem.willLikelyCompress(), "should predict compact");
  });

  return summary("MemoryOrchestrator");
}
