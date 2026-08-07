import {
  assert,
  assertEqual,
  assertIncludes,
  test,
  summary,
  resetCounters,
} from "./helpers.mjs";
import { ConversationStore } from "../js/memory/conversation.js";

export async function runConversationTests() {
  resetCounters();
  console.log("\n== ConversationStore ==");

  await test("pushes user/assistant and checkpoints for edit", () => {
    const store = new ConversationStore();
    const cp0 = store.checkpoint();
    assertEqual(cp0, 0);
    store.pushUser("hello");
    const cp1 = store.checkpoint();
    store.pushAssistant("hi there");
    assertEqual(store.length, 2);
    assertEqual(store.userTurnCount(), 1);

    store.pushUser("follow-up");
    store.pushAssistant("answer 2");
    store.truncateTo(cp1); // edit from first user onward → keep only first user? 
    // cp1 was after first user, so truncate keeps [user hello]
    assertEqual(store.length, 1);
    assertEqual(store.getMessages()[0].content, "hello");
  });

  await test("keeps tool_calls + tool results for next turns", () => {
    const store = new ConversationStore();
    store.pushUser("search sci-fi");
    store.pushAssistant("", {
      tool_calls: [
        {
          function: { name: "web_search", arguments: { query: "sci-fi 2026" } },
        },
      ],
    });
    store.pushTool({
      tool_name: "web_search",
      content: "1. Silo\n   https://example.com\n   Vault drama",
    });
    store.pushAssistant("Silo returns in 2026.");

    const msgs = store.getMessages();
    assertEqual(msgs.length, 4);
    assertEqual(msgs[1].role, "assistant");
    assert(msgs[1].tool_calls?.length === 1, "tool_calls preserved");
    assertEqual(msgs[2].role, "tool");
    assertEqual(msgs[2].tool_name, "web_search");
    assertIncludes(msgs[2].content, "Silo");
    assertIncludes(msgs[3].content, "Silo returns");
  });

  await test("truncates oversized tool payloads", () => {
    const store = new ConversationStore({ maxToolContentChars: 40 });
    store.pushTool({
      tool_name: "web_search",
      content: "x".repeat(200),
    });
    const content = store.getMessages()[0].content;
    assert(content.length < 80, "tool content truncated");
    assertIncludes(content, "truncated");
  });

  await test("trimToBudget drops oldest and does not leave orphan tools", () => {
    const store = new ConversationStore();
    store.pushUser("u1");
    store.pushAssistant("a1");
    store.pushUser("u2");
    store.pushAssistant("", {
      tool_calls: [{ function: { name: "web_search", arguments: { query: "q" } } }],
    });
    store.pushTool({ tool_name: "web_search", content: "results ".repeat(50) });
    store.pushAssistant("final based on tools");

    const before = store.estimateChars();
    assert(before > 100, "fixture should be sizable");
    const dropped = store.trimToBudget(120);
    assert(dropped.length > 0, "should drop something");
    const msgs = store.getMessages();
    assert(msgs.length >= 1, "keeps something");
    assert(msgs[0].role !== "tool", "must not start on orphan tool");
    // newest assistant should remain if budget allows
    const roles = msgs.map((m) => m.role);
    assert(roles.includes("assistant") || roles.includes("user"), "keeps recent roles");
  });

  await test("toJSON/loadJSON round-trip preserves tools", () => {
    const store = new ConversationStore();
    store.pushUser("q");
    store.pushAssistant("…", {
      tool_calls: [{ function: { name: "remember_fact", arguments: { fact: "likes tea" } } }],
    });
    store.pushTool({ tool_name: "remember_fact", content: "Stored fact: likes tea" });
    store.pushAssistant("Got it.");

    const raw = store.toJSON();
    const other = new ConversationStore();
    other.loadJSON(raw);
    assertEqual(other.length, store.length);
    assertEqual(other.getMessages()[2].tool_name, "remember_fact");
    assertIncludes(other.getMessages()[2].content, "likes tea");
  });

  await test("appendMany imports a tool loop batch", () => {
    const store = new ConversationStore();
    store.appendMany([
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ function: { name: "web_search", arguments: { query: "x" } } }],
      },
      { role: "tool", tool_name: "web_search", content: "hit" },
      { role: "assistant", content: "done" },
    ]);
    assertEqual(store.length, 4);
    assertEqual(store.getMessages()[2].role, "tool");
  });

  return summary("ConversationStore");
}
