/**
 * Intent: run one chat turn end-to-end (memory prep → tools → stream answer).
 * Architecture: factory `createChatRunner(deps)` closes over UI/memory callbacks;
 * talks to Ollama `/api/chat` and local `/api/search`; does not own DOM state.
 * Quality: 8/10 — streaming caret/is-generating wired; runChat still long
 */

import {
  OLLAMA,
  getSearchApi,
  MAX_TOOL_ROUNDS,
  WEB_SEARCH_TOOL,
} from "./config.js";
import {
  createThoughtBlock,
  extractThinkTags,
  setMarkdown,
  setWorkingPhase,
  stripThink,
} from "./markdown.js";
import { isAbortError, StoppedError } from "./util.js";

export async function localWebSearch(query, maxResults = 5, signal) {
  const res = await fetch(getSearchApi(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal,
    body: JSON.stringify({ query, max_results: maxResults }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Search failed (${res.status})`);
  return data.results || [];
}

export function formatSearchForModel(results) {
  if (!results.length) return "No results found.";
  return results
    .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`)
    .join("\n\n");
}

/**
 * @param {{
 *   memory: object,
 *   getChatModel: () => string,
 *   modelSupportsThink: (model?: string) => boolean,
 *   getThinkEnabled: () => boolean,
 *   getSearchEnabled: () => boolean,
 *   addBubble: Function,
 *   persistSession: Function,
 *   recordThread: Function,
 *   setStatus: Function,
 *   scrollThreadToBottom: Function,
 *   createMemoryCompactCard: Function,
 *   createToolUseCard: Function,
 *   refreshFactList: Function,
 * }} deps
 */
export function createChatRunner(deps) {
  const {
    memory,
    getChatModel,
    modelSupportsThink,
    getThinkEnabled,
    getSearchEnabled,
    addBubble,
    persistSession,
    recordThread,
    setStatus,
    scrollThreadToBottom,
    createMemoryCompactCard,
    createToolUseCard,
    refreshFactList,
  } = deps;

  async function chatOnce({ messages, tools, think, stream, signal }) {
    const payload = {
      model: getChatModel(),
      messages,
      stream: Boolean(stream),
      truncate: true,
      options: { temperature: 0.7, num_ctx: 8192 },
    };
    if (think && modelSupportsThink()) payload.think = true;
    if (tools) payload.tools = tools;

    const res = await fetch(`${OLLAMA}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal,
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(err || `Chat failed (${res.status})`);
    }
    return res;
  }

  async function runChat(prompt, signal) {
    const checkpoint = memory.conversation.checkpoint();
    memory.conversation.pushUser(prompt);
    const bot = addBubble("bot", "", {
      label: getChatModel(),
      persist: false,
      historyBefore: memory.conversation.length,
    });
    const wantThink = getThinkEnabled();
    const wantSearch = getSearchEnabled();
    const thought = wantThink ? createThoughtBlock() : null;
    if (thought) bot.appendChild(thought.el);
    const body = document.createElement("div");
    body.className = "md";
    bot.appendChild(body);
    bot.classList.add("is-generating");
    persistSession();

    const baseSystem = wantSearch
      ? "You are MyChat, a helpful local assistant. You can call web_search for up-to-date facts. Prefer clear Markdown. Be concise. Cite links from search results when useful."
      : "You are MyChat, a helpful local assistant. Prefer clear Markdown (headings, lists, fenced code) when it improves readability. Be concise unless asked for detail.";

    let fullContent = "";
    let fullThinking = "";
    let usedTools = false;

    try {
      let compactCard = null;
      if (memory.willLikelyCompress()) {
        setStatus("Compacting memory…", "busy");
        setWorkingPhase(body, "Compacting older turns into summary…");
        compactCard = createMemoryCompactCard({ beforeEl: body });
        compactCard.setRunning();
      } else {
        setStatus("Preparing memory…", "busy");
        setWorkingPhase(body, "Loading memory & context…");
      }

      const prepared = await memory.prepareTurn({
        prompt,
        baseSystem,
        signal,
      });
      /** @type {object[]} */
      const messages = prepared.messages;

      if (prepared.meta.summarized) {
        if (!compactCard) {
          compactCard = createMemoryCompactCard({ beforeEl: body });
        }
        compactCard.setDone({
          dropped: prepared.meta.dropped,
          summaryText: memory.summarizer.summary,
        });
        setStatus(
          `Compacted ${prepared.meta.dropped} older message${
            prepared.meta.dropped === 1 ? "" : "s"
          }`,
          "busy"
        );
        setWorkingPhase(body, "Memory compacted — continuing…");
      } else if (compactCard) {
        compactCard.remove();
      }

      if (prepared.meta.ragHits) {
        setStatus(`Memory: ${prepared.meta.ragHits} note(s) retrieved…`, "busy");
        setWorkingPhase(
          body,
          `Retrieved ${prepared.meta.ragHits} local note${
            prepared.meta.ragHits === 1 ? "" : "s"
          }…`
        );
      }

      const tools = [];
      if (wantSearch) tools.push(WEB_SEARCH_TOOL);
      if (memory.settings.rememberToolEnabled)
        tools.push(memory.rememberToolSchema());

      if (tools.length) {
        for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
          if (usedTools) {
            setStatus("Digesting tool results…", "busy");
            setWorkingPhase(body, "Reading tool results…");
            scrollThreadToBottom();
          } else {
            setStatus(round === 0 ? "Thinking…" : "Using tools…", "busy");
            if (round === 0) setWorkingPhase(body, "Planning next step…");
          }

          const res = await chatOnce({
            messages,
            tools,
            think: false,
            stream: false,
            signal,
          });
          const data = await res.json();
          const msg = data?.message || {};
          const toolCalls = msg.tool_calls || [];

          if (!toolCalls.length) {
            fullContent = msg.content || "";
            fullThinking = msg.thinking || "";
            break;
          }

          usedTools = true;
          const assistantToolMsg = {
            role: "assistant",
            content: msg.content || "",
            tool_calls: toolCalls,
          };
          messages.push(assistantToolMsg);
          memory.conversation.pushAssistant(assistantToolMsg.content, {
            tool_calls: toolCalls,
          });

          for (const call of toolCalls) {
            const fn = call.function || {};
            const name = fn.name || "";
            let args = fn.arguments || {};
            if (typeof args === "string") {
              try {
                args = JSON.parse(args);
              } catch {
                args = { query: args };
              }
            }

            if (name === "remember_fact") {
              const result = memory.executeRememberFact(args);
              refreshFactList();
              messages.push({
                role: "tool",
                tool_name: "remember_fact",
                content: result.content,
              });
              memory.conversation.pushTool({
                tool_name: "remember_fact",
                content: result.content,
              });
              continue;
            }

            if (name !== "web_search") {
              const content = `Unknown tool: ${name}`;
              messages.push({ role: "tool", tool_name: name, content });
              memory.conversation.pushTool({ tool_name: name, content });
              continue;
            }

            const query = String(args.query || "").trim();
            const maxResults = Number(args.max_results || 5);
            const card = createToolUseCard({
              name: "web_search",
              input: { query, max_results: maxResults },
              beforeEl: bot,
            });
            setStatus(`Searching: ${query}`, "busy");
            setWorkingPhase(body, "Waiting for search results…");
            scrollThreadToBottom();
            try {
              const results = await localWebSearch(query, maxResults, signal);
              card.setDone(results);
              const content = formatSearchForModel(results);
              messages.push({
                role: "tool",
                tool_name: "web_search",
                content,
              });
              memory.conversation.pushTool({
                tool_name: "web_search",
                content,
              });
            } catch (err) {
              if (isAbortError(err)) throw err;
              card.setError(String(err.message || err));
              const content = `Search error: ${err.message || err}`;
              messages.push({
                role: "tool",
                tool_name: "web_search",
                content,
              });
              memory.conversation.pushTool({
                tool_name: "web_search",
                content,
              });
            }
          }

          persistSession();
          setStatus("Digesting tool results…", "busy");
          setWorkingPhase(body, "Reading tool results…");
          scrollThreadToBottom();
        }
      }

      setStatus(
        usedTools ? "Writing answer from memory & results…" : "Answering…",
        "busy"
      );
      setWorkingPhase(
        body,
        usedTools
          ? wantThink
            ? "Digesting results & thinking…"
            : "Writing answer from results…"
          : wantThink
            ? "Thinking…"
            : "Writing answer…"
      );
      scrollThreadToBottom();
      fullContent = "";
      fullThinking = "";

      const res = await chatOnce({
        messages,
        tools: undefined,
        think: wantThink,
        stream: true,
        signal,
      });

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let lastPaint = 0;
      let clearedPhase = false;

      const paint = () => {
        const now = performance.now();
        if (now - lastPaint < 40) return;
        lastPaint = now;
        const tagged = extractThinkTags(fullContent);
        const thinking = wantThink
          ? [fullThinking, tagged.thinking].filter(Boolean).join("\n\n").trim()
          : "";
        const answer = wantThink ? tagged.content : stripThink(fullContent);
        if (thought) thought.update(thinking, { streaming: true });
        if (answer || thinking) {
          clearedPhase = true;
          bot.classList.add("is-generating");
          setMarkdown(body, answer || "_Thinking…_", { streaming: true });
        } else if (!clearedPhase) {
          bot.classList.add("is-generating");
          setWorkingPhase(
            body,
            usedTools
              ? wantThink
                ? "Digesting results & thinking…"
                : "Writing answer from results…"
              : wantThink
                ? "Thinking…"
                : "Writing answer…"
          );
        }
        scrollThreadToBottom();
      };

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (!line.trim()) continue;
          let chunk;
          try {
            chunk = JSON.parse(line);
          } catch {
            continue;
          }
          const msg = chunk?.message || {};
          if (wantThink && msg.thinking) fullThinking += msg.thinking;
          if (msg.content) fullContent += msg.content;
          if (msg.thinking || msg.content) paint();
          if (chunk?.error) throw new Error(chunk.error);
        }
      }

      const tagged = extractThinkTags(fullContent);
      const thinking = wantThink
        ? [fullThinking, tagged.thinking].filter(Boolean).join("\n\n").trim()
        : "";
      let answer = wantThink ? tagged.content : stripThink(fullContent);
      if (!answer.trim())
        answer = thinking ? "_(no final answer)_" : "_(empty reply)_";
      if (thought) thought.finish(thinking);
      bot.classList.remove("is-generating");
      setMarkdown(body, answer, { streaming: false });
      scrollThreadToBottom();
      memory.conversation.pushAssistant(answer);
      recordThread(
        {
          t: "bot",
          c: answer,
          label: getChatModel(),
          md: true,
          historyBefore: Number(bot.dataset.historyBefore) || 0,
        },
        bot
      );
      persistSession();
    } catch (err) {
      bot.classList.remove("is-generating");
      if (isAbortError(err)) {
        const tagged = extractThinkTags(fullContent);
        const thinking = wantThink
          ? [fullThinking, tagged.thinking].filter(Boolean).join("\n\n").trim()
          : "";
        const answer = wantThink ? tagged.content : stripThink(fullContent);
        if (thought) thought.finish(thinking);
        if (answer) {
          setMarkdown(body, `${answer}\n\n_(stopped)_`, { streaming: false });
          memory.conversation.pushAssistant(answer);
          recordThread(
            {
              t: "bot",
              c: `${answer}\n\n_(stopped)_`,
              label: getChatModel(),
              md: true,
              historyBefore: Number(bot.dataset.historyBefore) || 0,
            },
            bot
          );
          persistSession();
        } else {
          setMarkdown(body, "_(stopped)_", { streaming: false });
          memory.conversation.truncateTo(checkpoint);
          persistSession();
        }
        throw new StoppedError();
      }
      memory.conversation.truncateTo(checkpoint);
      persistSession();
      throw err;
    }
  }

  return { chatOnce, runChat, localWebSearch, formatSearchForModel };
}
