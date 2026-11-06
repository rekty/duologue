import {
  SCENARIOS,
  nextSeat,
  outcome,
  parseReply,
  scenarioById,
  seatOf,
  stillTalking,
  systemFor,
  threadFor,
} from "./shared/talk.js";
import { createPollen, DEFAULT_MODEL, ENDPOINTS } from "./shared/pollen.js";

const $ = (id) => document.getElementById(id);

const pollen = createPollen();

const state = {
  scenario: scenarioById("interview"),
  transcript: [],
  running: false,
  aborted: false,
  controller: null,
  device: null,
  timer: 0,
};

// Shown by `#demo`, so the page can be linked to and screenshotted without a key.
const SAMPLE = [
  { seat: "a", text: "Thanks for coming in. So — tell me about yourself.", hangUp: false, model: null },
  {
    seat: "b",
    text: "I have spent six years making small systems behave, mostly by writing down what they do before changing it.",
    hangUp: false,
    model: "openai/gpt-5.4-nano",
  },
  {
    seat: "a",
    text: "That is a strong answer. Can you give me one example, with the numbers in it?",
    hangUp: false,
    model: "openai/gpt-5.4-nano",
  },
  {
    seat: "b",
    text: "A checkout service that lost about forty orders a week; the log we added cut it to two, and the fix took a day.",
    hangUp: false,
    model: "openai/gpt-5.4-nano",
  },
  {
    seat: "a",
    text: "Good. And how would you have found the other thirty-eight? I ask because we have the same problem here.",
    hangUp: false,
    model: "meta/muse-spark-1.3",
  },
  {
    seat: "b",
    text: "I would start where the orders stop being retried, and I would rather show you than describe it. Thank you for the conversation.",
    hangUp: true,
    model: "openai/gpt-5.4-nano",
  },
];

function say(text, bad = false) {
  const element = $("status");
  element.textContent = text;
  element.classList.toggle("bad", bad);
}

function openerText(scenario) {
  return scenario.opener.replace(/^[^:]{1,24}:\s*/, "");
}

function modelFor(seatId) {
  return $(seatId === "a" ? "model-a" : "model-b").value || DEFAULT_MODEL;
}

function seatName(seatId) {
  return seatOf(state.scenario, seatId).name;
}

/* ---------- rendering ---------- */

function render() {
  const limit = Number($("turns").value);
  const calls = $("calls");

  calls.replaceChildren(
    ...state.transcript.map((line, index) => {
      const item = document.createElement("li");
      item.className = line.seat === "b" ? "b" : "a";

      const meta = document.createElement("div");
      meta.className = "meta";

      const who = document.createElement("b");
      who.textContent = seatName(line.seat);

      const turn = document.createElement("span");
      turn.textContent = index === 0 ? "opening line" : `turn ${index}`;

      meta.append(who, turn);

      if (line.model) {
        const model = document.createElement("span");
        model.className = "model";
        model.textContent = line.model;
        meta.append(model);
      }

      const text = document.createElement("p");
      text.textContent = line.text;

      item.append(meta, text);

      if (line.hangUp) {
        const badge = document.createElement("span");
        badge.className = "hangup";
        badge.textContent = "HANG UP";
        item.append(badge);
      }

      return item;
    }),
  );

  if (state.running) {
    const thinking = document.createElement("li");
    thinking.className = "thinking";
    thinking.textContent = "…";
    calls.append(thinking);
  }

  const result = outcome(state.transcript, limit, state.aborted);
  const banner = $("banner");

  if (!state.transcript.length) {
    banner.textContent = "";
    $("sub").textContent = "Nothing said yet.";
  } else if (result.ended === "hangup") {
    banner.innerHTML = "";
    banner.append(
      Object.assign(document.createElement("strong"), { textContent: `${seatName(result.by)} hung up. ` }),
      document.createTextNode(`The call lasted ${result.turns} ${result.turns === 1 ? "turn" : "turns"}.`),
    );
    $("sub").textContent = `${state.transcript.length} lines, ${result.ended === "open" ? "still going" : "call over"}.`;
  } else if (result.ended === "limit") {
    banner.innerHTML = "";
    banner.append(
      Object.assign(document.createElement("strong"), { textContent: "Nobody hung up. " }),
      document.createTextNode(`You cut the line at the ${limit}-turn cap.`),
    );
    $("sub").textContent = `${state.transcript.length} lines, call over.`;
  } else if (result.ended === "aborted") {
    banner.innerHTML = "";
    banner.append(
      Object.assign(document.createElement("strong"), { textContent: "You hung up on both. " }),
      document.createTextNode(`After ${result.turns} ${result.turns === 1 ? "turn" : "turns"}.`),
    );
    $("sub").textContent = `${state.transcript.length} lines, call over.`;
  } else {
    banner.textContent = "";
    $("sub").textContent = state.running
      ? `On the call · ${result.turns} of at most ${limit} turns used.`
      : `${state.transcript.length} lines.`;
  }

  $("start").disabled = state.running;
  $("stop").hidden = !state.running;
  $("scenario").disabled = state.running;
  $("model-a").disabled = state.running;
  $("model-b").disabled = state.running;
  $("turns").disabled = state.running;
}

function renderSeats() {
  const scenario = state.scenario;
  const [first, second] = scenario.seats;
  $("seat-a-name").textContent = first.name;
  $("seat-b-name").textContent = second.name;
  $("seat-a-hint").textContent = first.id === scenario.openerSeat ? "opens the call" : "answers";
  $("seat-b-hint").textContent = second.id === scenario.openerSeat ? "opens the call" : "answers";
}

/* ---------- the call ---------- */

// A reasoning model spends the whole budget thinking and then has nothing left to
// answer with, so one turn gets a second, roomier attempt before the call dies.
async function speak({ system, messages, prompt, model, signal }) {
  let lastError;
  for (const maxTokens of [180, 700]) {
    try {
      return await pollen.ask({ system, messages, prompt, model, maxTokens, temperature: 0.95, signal });
    } catch (error) {
      lastError = error;
      if (error?.name === "AbortError" || !/output token limit/i.test(error?.message || "")) break;
      say(`${model} ran out of budget thinking; giving it more room…`);
    }
  }
  throw lastError;
}

async function start() {
  if (state.running) return;
  if (pollen.status().state !== "connected") {
    say("Connect your Pollen first: every turn is one request on your key.", true);
    return;
  }

  const limit = Number($("turns").value);
  state.scenario = scenarioById($("scenario").value);
  state.transcript = [
    { seat: state.scenario.openerSeat, text: openerText(state.scenario), hangUp: false, model: null },
  ];
  state.aborted = false;
  state.running = true;
  state.controller = new AbortController();
  renderSeats();
  render();

  try {
    while (stillTalking(state.scenario, state.transcript, limit)) {
      const seatId = nextSeat(state.scenario, state.transcript);
      const seat = seatOf(state.scenario, seatId);
      const turn = state.transcript.length;
      const model = modelFor(seatId);
      const { messages, prompt } = threadFor(state.transcript, seatId);

      say(`${seat.name} is talking… (turn ${turn} of ${limit}, ${model})`);

      const raw = await speak({
        system: systemFor(state.scenario, seatId, turn, limit),
        messages,
        prompt,
        model,
        signal: state.controller.signal,
      });

      const reply = parseReply(raw);
      if (!reply.text) throw new Error("the model returned an empty line");

      state.transcript.push({ seat: seatId, text: reply.text, hangUp: reply.hangUp, model });
      render();

      if (reply.hangUp) break;
    }
    say("");
  } catch (error) {
    if (error?.name === "AbortError") {
      state.aborted = true;
      say("");
    } else {
      const message =
        error?.code === "auth"
          ? "That key was rejected. Connect again or paste a fresh sk_ key."
          : error?.code === "quota"
            ? "That key is out of Pollen."
            : error?.message || "the call failed";
      say(message, true);
    }
  } finally {
    state.running = false;
    state.controller = null;
    render();
  }
}

$("start").onclick = start;
$("stop").onclick = () => {
  state.controller?.abort();
};

$("turns").oninput = () => {
  $("turns-out").textContent = $("turns").value;
  render();
};

$("scenario").onchange = () => {
  state.scenario = scenarioById($("scenario").value);
  state.transcript = [];
  state.aborted = false;
  renderSeats();
  render();
};

/* ---------- sign in ---------- */

function renderAuth() {
  const connected = pollen.status().state === "connected";
  $("auth-title").textContent = connected ? "Connected — your Pollen is paying" : "Not connected";
  $("auth-note").textContent = connected
    ? "One request per turn, billed to your own key."
    : "A call needs Pollen: one request per turn.";
  $("auth-connect").hidden = connected;
  $("auth-out").hidden = !connected;
  $("auth-device").hidden = !state.device;
}

async function pollDevice() {
  const result = await pollen.poll();
  if (result.state === "pending") return;
  state.device = null;
  clearInterval(state.timer);
  $("auth-code").textContent = "";
  $("auth-open").removeAttribute("href");
  renderAuth();
  // renderAuth rewrites the note, so the reason has to be set after it or it is lost.
  if (result.state === "error") $("auth-note").textContent = `Sign-in failed: ${result.message}`;
  if (result.state === "expired") $("auth-note").textContent = "That code expired. Connect again for a fresh one.";
}

$("auth-connect").onclick = async () => {
  $("auth-connect").disabled = true;
  try {
    state.device = await pollen.connect();
    $("auth-code").textContent = state.device.userCode;
    // A real link, because window.open from a script-triggered click is popup-blocked.
    $("auth-open").href = state.device.verify;
    state.timer = setInterval(pollDevice, Math.max(state.device.interval || 5000, 3000));
    renderAuth();
  } catch (error) {
    say(`Sign-in failed: ${error.message}`, true);
  } finally {
    $("auth-connect").disabled = false;
  }
};

$("auth-out").onclick = () => {
  clearInterval(state.timer);
  state.device = null;
  pollen.signOut();
  renderAuth();
};

$("auth-use").onclick = () => {
  try {
    pollen.useKey($("auth-key").value);
    $("auth-key").value = "";
    renderAuth();
    say("Key accepted. Press Start the call.");
  } catch (error) {
    say(error.message, true);
  }
};

/* ---------- models ---------- */

async function loadModels() {
  const selects = [$("model-a"), $("model-b")];
  for (const select of selects) select.replaceChildren(new Option(DEFAULT_MODEL, DEFAULT_MODEL));

  try {
    const response = await fetch(`${ENDPOINTS.gen}/models`);
    if (!response.ok) return;
    const body = await response.json();
    const list = Array.isArray(body) ? body : (body?.data ?? body?.models ?? []);
    const ids = list
      // A reasoning model spends the whole line budget thinking and answers nothing,
      // so the picker only offers models that can keep to a forty-word turn.
      .filter(
        (entry) =>
          typeof entry === "string" ||
          (entry?.reasoning !== true && (entry?.category ?? "text") === "text"),
      )
      .map((entry) => (typeof entry === "string" ? entry : entry?.id || entry?.name))
      .filter((id) => typeof id === "string" && id.includes("/"))
      .slice(0, 24);
    if (!ids.includes(DEFAULT_MODEL)) ids.unshift(DEFAULT_MODEL);

    for (const [index, select] of selects.entries()) {
      select.replaceChildren(...ids.map((id) => new Option(id, id)));
      select.value = index === 1 && ids.length > 1 ? ids[1] : DEFAULT_MODEL;
    }
  } catch {
    /* the default pair is enough; a failed list must not break the page */
  }
}

/* ---------- boot ---------- */

for (const scenario of SCENARIOS) {
  $("scenario").append(new Option(scenario.label, scenario.id));
}
$("scenario").value = state.scenario.id;
$("turns-out").textContent = $("turns").value;

renderSeats();
render();
renderAuth();
loadModels();

if (location.hash === "#demo") {
  state.transcript = SAMPLE.map((line) => ({ ...line }));
  state.aborted = false;
  render();
  say("Sample transcript. Connect Pollen and press Start the call to run it for real.");
}
