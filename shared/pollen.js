// Bring Your Own Pollen for a static page: the device flow needs no redirect,
// no app secret and no backend, so every turn of the call is billed to the
// reader's own key.

export const ENDPOINTS = {
  gen: "https://gen.pollinations.ai",
  enter: "https://enter.pollinations.ai",
};

// Publishable App Key: names the app on the consent screen and attributes the
// traffic. It cannot spend anything on its own.
export const APP_KEY = "pk_TRM5Aq2QwxGsVj12";

export const DEFAULT_MODEL = "openai/gpt-5.4-nano";

export function createMemoryStore() {
  const items = new Map();
  return {
    get: (key) => (items.has(key) ? items.get(key) : null),
    set: (key, value) => items.set(key, value),
    remove: (key) => items.delete(key),
  };
}

function sessionStore() {
  try {
    const storage = globalThis.sessionStorage;
    if (!storage) return createMemoryStore();
    return {
      get: (key) => storage.getItem(key),
      set: (key, value) => storage.setItem(key, value),
      remove: (key) => storage.removeItem(key),
    };
  } catch {
    return createMemoryStore();
  }
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

function httpError(response, body) {
  const error = new Error(
    body?.error?.message || body?.message || body?.error || `HTTP ${response.status}`,
  );
  if (response.status === 401 || response.status === 403) error.code = "auth";
  if (response.status === 402 || response.status === 429) error.code = "quota";
  return error;
}

export function createPollen({
  fetchImpl,
  store = sessionStore(),
  model = DEFAULT_MODEL,
  appKey = APP_KEY,
} = {}) {
  const send = fetchImpl || ((url, options) => globalThis.fetch(url, options));
  const key = "duologue.key";
  const deviceKey = "duologue.device";
  const untilKey = "duologue.until";

  async function connect() {
    const response = await send(`${ENDPOINTS.enter}/api/device/code`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(appKey ? { client_id: appKey } : {}),
    });
    const body = await readJson(response);
    if (!response.ok || !body.device_code) throw httpError(response, body);
    store.set(deviceKey, body.device_code);
    store.set(untilKey, String(Date.now() + (body.expires_in || 1800) * 1000));
    return {
      userCode: body.user_code,
      verify: body.verification_uri_complete || body.verification_uri,
      interval: (body.interval || 5) * 1000,
    };
  }

  async function poll() {
    const device = store.get(deviceKey);
    if (!device) return { state: "idle" };
    if (Date.now() > Number(store.get(untilKey) || 0)) {
      store.remove(deviceKey);
      return { state: "expired" };
    }
    const response = await send(`${ENDPOINTS.enter}/api/device/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_code: device }),
    });
    const body = await readJson(response);
    if (body.access_token) {
      store.remove(deviceKey);
      store.remove(untilKey);
      store.set(key, body.access_token);
      return { state: "connected" };
    }
    if (body.error === "authorization_pending" || response.status === 428) return { state: "pending" };
    store.remove(deviceKey);
    return {
      state: "error",
      message: body.error_description || body.error || `HTTP ${response.status}`,
    };
  }

  function status() {
    return store.get(key) ? { state: "connected" } : { state: "signed-out" };
  }

  function useKey(value) {
    const trimmed = String(value || "").trim();
    if (!/^sk_/.test(trimmed)) throw new Error("that is not an sk_ key");
    store.set(key, trimmed);
    return status();
  }

  function signOut() {
    for (const item of [key, deviceKey, untilKey]) store.remove(item);
    return status();
  }

  async function ask({ system, messages, prompt, maxTokens = 220, temperature = 0.9, model: override, signal }) {
    const current = store.get(key);
    if (!current) {
      const error = new Error("connect your Pollen first");
      error.code = "auth";
      throw error;
    }
    const thread = [];
    if (system) thread.push({ role: "system", content: system });
    for (const message of messages || []) {
      thread.push({ role: message.role, content: message.content });
    }
    if (prompt) thread.push({ role: "user", content: prompt });

    const response = await send(`${ENDPOINTS.gen}/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${current}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: override || model,
        messages: thread,
        temperature,
        max_tokens: maxTokens,
      }),
      signal,
    });
    const body = await readJson(response);
    if (!response.ok) throw httpError(response, body);
    const text = body.choices?.[0]?.message?.content;
    if (!text) throw new Error("the model returned no text");
    return text.trim();
  }

  return { connect, poll, status, useKey, signOut, ask, model };
}
