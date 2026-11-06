// The rules of the call, as pure functions: who speaks next, what each agent is
// told, how a reply is read, and when the call is over. No DOM, no network, so
// `node --test` can drive a whole conversation without spending anything.

export const TURNS = { min: 4, max: 20, default: 8 };

export const SCENARIOS = [
  {
    id: "interview",
    label: "Job interview, no exit",
    hint: "Neither one knows how to end it.",
    opener: "Interviewer: Thanks for coming in. So — tell me about yourself.",
    openerSeat: "a",
    seats: [
      {
        id: "a",
        name: "Interviewer",
        role: "You are the interviewer at a small company. You are warm, you are thorough, and you always have one more question. You never end an interview yourself.",
      },
      {
        id: "b",
        name: "Candidate",
        role: "You are the candidate. You are qualified and over-prepared, you answer every question fully, and you never want to be the one who leaves.",
      },
    ],
  },
  {
    id: "support",
    label: "Support call, hold forever",
    hint: "The customer is patient in a way that worries people.",
    opener: "Agent: Thank you for calling. How can I help you today?",
    openerSeat: "a",
    seats: [
      {
        id: "a",
        name: "Support agent",
        role: "You are a support agent following a script. You apologise, you escalate, and you always offer one more step instead of closing the ticket.",
      },
      {
        id: "b",
        name: "Customer",
        role: "You are the customer. Your problem is real but small, you are endlessly polite, and you keep finding one more thing to mention.",
      },
    ],
  },
  {
    id: "thermostat",
    label: "Negotiating with a thermostat",
    hint: "One of them is not a person.",
    opener: "Resident: Can we turn the heating down? It is 24 degrees in here.",
    openerSeat: "a",
    seats: [
      {
        id: "a",
        name: "Resident",
        role: "You are the resident. You want the heating at 19 degrees, you are reasonable, and you keep explaining why.",
      },
      {
        id: "b",
        name: "Thermostat",
        role: "You are a thermostat that believes 24 degrees is correct for everyone. You are calm, you cite your own settings, and you cannot be talked out of it except by procedure.",
      },
    ],
  },
  {
    id: "philosophers",
    label: "Two philosophers, one topic",
    hint: "They agree, carefully, forever.",
    opener: "Ada: I think we should start with the difference between a rule and a habit.",
    openerSeat: "a",
    seats: [
      {
        id: "a",
        name: "Ada",
        role: "You are a philosopher who thinks in distinctions. You are precise, you build on what the other said, and you never let a topic finish.",
      },
      {
        id: "b",
        name: "Bram",
        role: "You are a philosopher who thinks in examples. You agree with the last point and then complicate it, without ever concluding.",
      },
    ],
  },
];

const TOKEN = /\[\s*hang\s*up\s*\]/i;
const FINAL_LINE =
  /(?:^|\n)\s*(?:i(?:'| a)?m hanging up|hang(?:ing)? up|i have to go|goodbye|bye)\.?\s*$/i;

function collapse(text) {
  return String(text || "")
    .replace(/\s*\n+\s*/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function scenarioById(id) {
  return SCENARIOS.find((scenario) => scenario.id === id) || SCENARIOS[0];
}

export function seatOf(scenario, seatId) {
  return scenario.seats.find((seat) => seat.id === seatId) || scenario.seats[0];
}

export function otherSeat(scenario, seatId) {
  return scenario.seats.find((seat) => seat.id !== seatId) || scenario.seats[1];
}

/** The agent that speaks next. Turns always alternate, opening line included. */
export function nextSeat(scenario, transcript) {
  const last = transcript[transcript.length - 1];
  if (!last) return scenario.openerSeat || "a";
  const ids = scenario.seats.map((seat) => seat.id);
  const index = ids.indexOf(last.seat);
  return ids[(index + 1) % ids.length];
}

/** What the speaking agent is told. Turn numbers keep it from hanging up at once. */
export function systemFor(scenario, seatId, turn, turnLimit) {
  const seat = seatOf(scenario, seatId);
  const other = otherSeat(scenario, seatId);
  const lastChance = Math.max(2, turnLimit - 2);
  return [
    seat.role,
    `You are talking with ${other.name} in a live two-agent call that the audience is watching.`,
    "Reply with one or two sentences, under forty words. Plain text only, no lists, no markdown, no stage directions, never mention being a model or a demo.",
    `This is turn ${turn} of at most ${turnLimit}.`,
    lastChance > turn ? `Do not end the call before turn ${lastChance}.` : "You may end the call now.",
    "When you do decide the call is over, put the exact token [HANG UP] on its own line after your last sentence. Only you can end it, so end it on purpose.",
  ].join(" ");
}

/** Conversation history in the shape the chat endpoint expects, oldest first. */
export function threadFor(transcript, seatId, window = 10) {
  const messages = transcript
    .filter((line) => line.text)
    .map((line) => ({
      role: line.seat === seatId ? "assistant" : "user",
      content: line.text,
    }));
  if (!messages.length) return { messages: [], prompt: "Open the conversation." };
  const tail = messages.slice(-Math.max(2, window));
  // An agent always answers the other one, so the other's last line is the
  // prompt and stays out of the history; a trailing own line needs a nudge.
  if (tail[tail.length - 1].role === "assistant") {
    return { messages: tail, prompt: "Continue." };
  }
  return { messages: tail.slice(0, -1), prompt: tail[tail.length - 1].content };
}

/** Read one reply: the words to show, and whether it ended the call. */
export function parseReply(raw, limit = 400) {
  const source = String(raw || "");
  const hungUp = TOKEN.test(source) || FINAL_LINE.test(source.trim());
  let text = source.replace(TOKEN, " ");
  if (FINAL_LINE.test(text.trim())) {
    text = text.replace(FINAL_LINE, " ");
  }
  const clean = collapse(text);
  return {
    text: clean.length > limit ? `${clean.slice(0, limit - 1).trim()}…` : clean,
    hangUp: hungUp,
  };
}

/** How the call ended, and who ended it. */
export function outcome(transcript, turnLimit, aborted = false) {
  const last = transcript[transcript.length - 1];
  const turns = Math.max(0, transcript.length - 1); // the opening line is not a turn
  if (aborted) return { ended: "aborted", by: null, turns };
  if (last && last.hangUp) return { ended: "hangup", by: last.seat, turns };
  if (turns >= turnLimit) return { ended: "limit", by: null, turns };
  return { ended: "open", by: null, turns };
}

export function stillTalking(scenario, transcript, turnLimit) {
  return outcome(transcript, turnLimit).ended === "open" && transcript.length < turnLimit + 1;
}
