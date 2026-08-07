/**
 * Tiny test helpers for MyChat memory suites (no external deps).
 */

let passed = 0;
let failed = 0;
const failures = [];

export function installLocalStorage() {
  const map = new Map();
  globalThis.localStorage = {
    getItem(key) {
      return map.has(key) ? map.get(key) : null;
    },
    setItem(key, value) {
      map.set(String(key), String(value));
    },
    removeItem(key) {
      map.delete(String(key));
    },
    clear() {
      map.clear();
    },
  };
  return map;
}

export function installLocation(origin = "http://127.0.0.1:8765") {
  globalThis.location = { origin };
}

export function assert(cond, message) {
  if (!cond) throw new Error(message || "assertion failed");
}

export function assertEqual(actual, expected, message) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`${message || "assertEqual"}\n  expected: ${e}\n  actual:   ${a}`);
  }
}

export function assertIncludes(haystack, needle, message) {
  if (!String(haystack).includes(String(needle))) {
    throw new Error(`${message || "assertIncludes"}: missing ${JSON.stringify(needle)}`);
  }
}

export async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed += 1;
    failures.push({ name, err });
    console.error(`  ✗ ${name}`);
    console.error(`    ${err?.stack || err}`);
  }
}

export function summary(suite) {
  console.log(`\n${suite}: ${passed} passed, ${failed} failed`);
  return { passed, failed, failures };
}

export function resetCounters() {
  passed = 0;
  failed = 0;
  failures.length = 0;
}

/** Mock fetch with a queue of handlers or a single router function. */
export function mockFetch(router) {
  const prev = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => router(String(url), init);
  return () => {
    globalThis.fetch = prev;
  };
}

export function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
    async text() {
      return typeof body === "string" ? body : JSON.stringify(body);
    },
  };
}
