#!/usr/bin/env node
/**
 * Run all MyChat history/memory tests.
 *   node test/run.mjs
 *   node test/run.mjs --js-only
 */

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { runConversationTests } from "./test_conversation.mjs";
import { runFactsTests } from "./test_facts.mjs";
import { runSummarizerTests } from "./test_summarizer.mjs";
import { runRagClientTests } from "./test_rag_client.mjs";
import { runOrchestratorTests } from "./test_orchestrator.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const jsOnly = process.argv.includes("--js-only");

async function main() {
  console.log("MyChat history / memory validation\n");

  const results = [];
  results.push(await runConversationTests());
  results.push(await runFactsTests());
  results.push(await runSummarizerTests());
  results.push(await runRagClientTests());
  results.push(await runOrchestratorTests());

  let pyFailed = 0;
  if (!jsOnly) {
    console.log("\n== rag_store (Python) ==");
    const py = path.join(root, ".venv", "bin", "python");
    const r = spawnSync(py, ["-m", "unittest", "discover", "-s", "test", "-p", "test_rag_store.py", "-v"], {
      cwd: root,
      encoding: "utf8",
    });
    if (r.stdout) process.stdout.write(r.stdout);
    if (r.stderr) process.stderr.write(r.stderr);
    if (r.status !== 0) {
      pyFailed = 1;
      console.error("Python rag_store tests failed");
    } else {
      console.log("  ✓ rag_store unittest suite");
    }
  }

  const jsFailed = results.reduce((n, r) => n + r.failed, 0);
  const jsPassed = results.reduce((n, r) => n + r.passed, 0);
  console.log("\n────────────────────────────");
  console.log(`JS: ${jsPassed} passed, ${jsFailed} failed`);
  if (!jsOnly) console.log(`Python: ${pyFailed ? "FAILED" : "passed"}`);

  if (jsFailed || pyFailed) process.exit(1);
  console.log("\nAll history features validated.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
