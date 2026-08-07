import {
  assert,
  assertEqual,
  assertIncludes,
  installLocalStorage,
  test,
  summary,
  resetCounters,
} from "./helpers.mjs";
import { FactsStore } from "../js/memory/facts.js";

export async function runFactsTests() {
  resetCounters();
  console.log("\n== FactsStore ==");
  const storage = installLocalStorage();

  await test("adds, de-dupes, and lists facts", () => {
    const facts = new FactsStore({ storageKey: "test.facts", maxFacts: 5 });
    facts.clear();
    facts.add(" Prefers French ");
    facts.add("prefers french"); // dup
    facts.add("Uses MacBook Air M5");
    assertEqual(facts.count(), 2);
    const block = facts.toSystemBlock();
    assertIncludes(block, "Durable memory");
    assertIncludes(block, "Prefers French");
    assertIncludes(block, "MacBook Air M5");
  });

  await test("persists across instances", () => {
    const a = new FactsStore({ storageKey: "test.facts.persist", maxFacts: 10 });
    a.clear();
    a.add("Remember my timezone is Europe/Paris");
    const b = new FactsStore({ storageKey: "test.facts.persist", maxFacts: 10 });
    assertEqual(b.count(), 1);
    assertIncludes(b.list()[0].text, "Europe/Paris");
  });

  await test("remove and clear", () => {
    const facts = new FactsStore({ storageKey: "test.facts.rm", maxFacts: 10 });
    facts.clear();
    const f = facts.add("temp");
    assert(f?.id, "id assigned");
    assert(facts.remove(f.id));
    assertEqual(facts.count(), 0);
    facts.add("a");
    facts.add("b");
    facts.clear();
    assertEqual(facts.count(), 0);
    assertEqual(storage.get("test.facts.rm"), "[]");
  });

  await test("respects maxFacts", () => {
    const facts = new FactsStore({ storageKey: "test.facts.max", maxFacts: 3 });
    facts.clear();
    facts.add("1");
    facts.add("2");
    facts.add("3");
    facts.add("4");
    assertEqual(facts.count(), 3);
    const texts = facts.list().map((x) => x.text);
    assert(!texts.includes("1"), "oldest dropped");
    assert(texts.includes("4"), "newest kept");
  });

  return summary("FactsStore");
}
