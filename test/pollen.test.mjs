// The shipped BYOP client against a fake network: device flow, key handling and
// the shape of one turn. No Pollen spent.
import assert from "node:assert/strict";
import test from "node:test";

import { APP_KEY, createMemoryStore, createPollen } from "../shared/pollen.js";

function fakeNetwork(responses) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    const reply = responses(String(url), calls.length);
    return {
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      json: async () => reply.body,
    };
  };
  return { calls, fetchImpl };
}

const chat = (text) => ({ status: 200, body: { choices: [{ message: { content: text } }] } });

test("device flow: code, then approval", async () => {
  const { calls, fetchImpl } = fakeNetwork((url, call) => {
    if (url.endsWith("/api/device/code")) {
      return {
        status: 200,
        body: {
          device_code: "dev-1",
          user_code: "ABCD-9999",
          verification_uri_complete: "https://enter.pollinations.ai/device?user_code=ABCD-9999",
          expires_in: 1800,
          interval: 5,
        },
      };
    }
    return call === 2
      ? { status: 428, body: { error: "authorization_pending" } }
      : { status: 200, body: { access_token: "sk_user" } };
  });

  const pollen = createPollen({ fetchImpl, store: createMemoryStore() });
  const started = await pollen.connect();
  assert.equal(started.userCode, "ABCD-9999");
  assert.equal(JSON.parse(calls[0].options.body).client_id, APP_KEY);
  assert.equal(pollen.status().state, "signed-out");
  assert.equal((await pollen.poll()).state, "pending");
  assert.equal((await pollen.poll()).state, "connected");
});

test("a turn without a key never reaches the network", async () => {
  const { calls, fetchImpl } = fakeNetwork(() => chat("hi"));
  const pollen = createPollen({ fetchImpl, store: createMemoryStore() });
  await assert.rejects(() => pollen.ask({ prompt: "hello" }), (error) => error.code === "auth");
  assert.equal(calls.length, 0);
});

test("one turn sends the thread, the model and the temperature", async () => {
  const { calls, fetchImpl } = fakeNetwork(() => chat("Interviewer: one more question."));
  const pollen = createPollen({ fetchImpl, store: createMemoryStore() });
  pollen.useKey("sk_user");

  const reply = await pollen.ask({
    system: "you are the candidate",
    messages: [{ role: "assistant", content: "I am the candidate." }],
    prompt: "Tell me more.",
    maxTokens: 160,
  });
  assert.match(reply, /one more question/);

  const request = JSON.parse(calls[0].options.body);
  assert.equal(calls[0].url, "https://gen.pollinations.ai/v1/chat/completions");
  assert.equal(calls[0].options.headers.Authorization, "Bearer sk_user");
  assert.equal(request.model, "openai/gpt-5.4-nano");
  assert.equal(request.messages[0].role, "system");
  assert.equal(request.messages[1].role, "assistant");
  assert.equal(request.messages[2].role, "user");
  assert.equal(request.messages[2].content, "Tell me more.");
  assert.equal(request.max_tokens, 160);
  assert.equal(request.temperature, 0.9);
});

test("the abort signal is passed through so a call can be stopped", async () => {
  const { calls, fetchImpl } = fakeNetwork(() => chat("ok"));
  const pollen = createPollen({ fetchImpl, store: createMemoryStore() });
  pollen.useKey("sk_user");
  const controller = new AbortController();
  await pollen.ask({ prompt: "hi", signal: controller.signal });
  assert.ok(calls[0].options.signal, "signal should reach fetch");
});

test("each seat can use its own model", async () => {
  const { calls, fetchImpl } = fakeNetwork(() => chat("ok"));
  const pollen = createPollen({ fetchImpl, store: createMemoryStore() });
  pollen.useKey("sk_user");
  await pollen.ask({ prompt: "hi", model: "meta/muse-spark-1.3" });
  assert.equal(JSON.parse(calls[0].options.body).model, "meta/muse-spark-1.3");
});

test("a spent balance and a rejected key are reported apart", async () => {
  const quota = createPollen({
    fetchImpl: fakeNetwork(() => ({ status: 402, body: { error: { message: "not enough pollen" } } })).fetchImpl,
    store: createMemoryStore(),
  });
  quota.useKey("sk_user");
  await assert.rejects(() => quota.ask({ prompt: "hi" }), (error) => error.code === "quota");

  const auth = createPollen({
    fetchImpl: fakeNetwork(() => ({ status: 401, body: { error: "invalid key" } })).fetchImpl,
    store: createMemoryStore(),
  });
  auth.useKey("sk_user");
  await assert.rejects(() => auth.ask({ prompt: "hi" }), (error) => error.code === "auth");
});

test("keys are validated and signing out forgets them", () => {
  const { fetchImpl } = fakeNetwork(() => chat("ok"));
  const pollen = createPollen({ fetchImpl, store: createMemoryStore() });
  assert.throws(() => pollen.useKey("pk_nope"), /not an sk_ key/);
  pollen.useKey(" sk_user ");
  assert.equal(pollen.status().state, "connected");
  assert.equal(pollen.signOut().state, "signed-out");
});
