import assert from "node:assert/strict";
import test from "node:test";

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
} from "../shared/talk.js";

const scenario = scenarioById("interview");
const opener = { seat: scenario.openerSeat, text: scenario.opener.split(": ").slice(1).join(": "), hangUp: false };

function line(seat, text, hangUp = false) {
  return { seat, text, hangUp };
}

test("every scenario has two seats, an opener and a role for each", () => {
  assert.ok(SCENARIOS.length >= 4);
  for (const item of SCENARIOS) {
    assert.equal(item.seats.length, 2);
    assert.ok(item.opener.length > 10);
    assert.ok(["a", "b"].includes(item.openerSeat));
    for (const seat of item.seats) {
      assert.ok(seat.name && seat.role.length > 40, `${item.id}/${seat.id} needs a role`);
    }
  }
});

test("turns alternate and wrap around", () => {
  assert.equal(nextSeat(scenario, []), "a");
  assert.equal(nextSeat(scenario, [line("a", "hi")]), "b");
  assert.equal(nextSeat(scenario, [line("a", "hi"), line("b", "hello")]), "a");
});

test("the speaking agent sees its own words as assistant and the other's as user", () => {
  const transcript = [opener, line("b", "I am the candidate."), line("a", "Good. Tell me more.")];
  const { messages, prompt } = threadFor(transcript, "b");
  assert.equal(messages[0].role, "user", "the interviewer opened, so that line is user");
  assert.equal(messages[1].role, "assistant");
  assert.equal(messages[1].content, "I am the candidate.");
  assert.match(prompt, /Tell me more/);
});

test("a long call is windowed so cost stays bounded", () => {
  const transcript = [];
  for (let i = 0; i < 20; i += 1) transcript.push(line(i % 2 ? "b" : "a", `line ${i}`));
  const { messages, prompt } = threadFor(transcript, "a", 6);
  assert.ok(messages.length <= 6, `window leaked: ${messages.length} messages`);
  assert.equal(messages.length, 5, "the other agent's last line became the prompt");
  assert.equal(messages[messages.length - 1].content, "line 18");
  assert.equal(prompt, "line 19");
});

test("an empty transcript still gives the agent something to answer", () => {
  const { messages, prompt } = threadFor([], "a");
  assert.deepEqual(messages, []);
  assert.match(prompt, /Open the conversation/);
});

test("a trailing own line becomes a nudge instead of a dangling assistant turn", () => {
  const { messages, prompt } = threadFor(
    [line("a", "first"), line("b", "second"), line("a", "third")],
    "a",
  );
  assert.equal(prompt, "Continue.");
  assert.equal(messages.length, 3, "its own last line stays in the history");
  assert.equal(messages[2].role, "assistant");
});

test("the hang-up token ends the call and is stripped from the text", () => {
  const reply = parseReply("Good luck with the search.\n[HANG UP]");
  assert.equal(reply.hangUp, true);
  assert.equal(reply.text, "Good luck with the search.");
});

test("a final goodbye line also ends the call", () => {
  const reply = parseReply("That is everything I needed.\nI'm hanging up.");
  assert.equal(reply.hangUp, true);
  assert.doesNotMatch(reply.text, /hanging up/i);
});

test("mentioning a hang-up mid-sentence does not end the call", () => {
  const reply = parseReply("I should hang up on that idea and start again with the budget.");
  assert.equal(reply.hangUp, false);
  assert.match(reply.text, /budget/);
});

test("long replies are clipped, newlines collapsed", () => {
  const reply = parseReply(`one\n\n\ntwo ${"x".repeat(500)}`, 60);
  assert.equal(reply.text.length, 60);
  assert.match(reply.text, /^one two/);
});

test("outcome names who ended it, or why it ended", () => {
  const open = [opener, line("b", "hello")];
  assert.deepEqual(outcome(open, 6), { ended: "open", by: null, turns: 1 });

  const hung = [...open, line("a", "goodbye", true)];
  assert.equal(outcome(hung, 6).ended, "hangup");
  assert.equal(outcome(hung, 6).by, "a");

  const capped = Array.from({ length: 7 }, (unused, index) => line(index % 2 ? "b" : "a", "x"));
  assert.equal(outcome(capped, 6).ended, "limit");

  assert.equal(outcome(open, 6, true).ended, "aborted");
});

test("the call keeps going only while it is open and under the cap", () => {
  assert.equal(stillTalking(scenario, [opener], 4), true);
  assert.equal(stillTalking(scenario, [opener, line("b", "x", true)], 4), false);
  const long = Array.from({ length: 6 }, (unused, index) => line(index % 2 ? "b" : "a", "x"));
  assert.equal(stillTalking(scenario, long, 4), false);
});

test("the system prompt carries the role, the limit and the token", () => {
  const prompt = systemFor(scenario, "b", 2, 8);
  assert.match(prompt, /candidate/i);
  assert.match(prompt, /Interviewer/);
  assert.match(prompt, /\[HANG UP\]/);
  assert.match(prompt, /turn 2 of at most 8/);
  assert.match(prompt, /Do not end the call before turn 6/);
});

test("seats resolve by id and fall back safely", () => {
  assert.equal(seatOf(scenario, "b").name, "Candidate");
  assert.equal(seatOf(scenario, "nope").id, "a");
});
