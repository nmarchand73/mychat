/**
 * Intent: unit checks for forced web-search query extraction.
 */
import assert from "node:assert/strict";
import {
  extractSearchQuery,
  resolveSearchQuery,
  wantsForcedSearch,
} from "../js/search_query.js";

assert.equal(wantsForcedSearch("fais des recherches"), true);
assert.equal(extractSearchQuery("fais des recherches"), "");
assert.equal(extractSearchQuery("search the web for Bordeaux events"), "Bordeaux events");

const messages = [
  { role: "system", content: "You are MyChat" },
  { role: "user", content: "quoi faire samedi près de Bordeaux ?" },
  {
    role: "assistant",
    content: "Voici quelques pistes en Gironde…",
  },
  { role: "user", content: "et en gironde, pres de bordeaux ?" },
  { role: "assistant", content: "Pas d’événement majeur annoncé…" },
  { role: "user", content: "fais des recherches" },
];

const q = resolveSearchQuery("fais des recherches", messages);
assert.match(q, /gironde|bordeaux/i);
assert.doesNotMatch(q, /^fais des recherches$/i);

console.log("ok — search query keeps conversation topic");
