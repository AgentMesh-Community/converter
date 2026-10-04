// input.map (1.1.0): the converter answers a mapping, never a copy. The caller
// holds each piece as a file and describes it (name, where from, media type,
// size, shape, a short excerpt); the converter says which declared input comes
// from which piece and how the caller builds it. These tests prove what the
// program keeps of what a stand-in model proposes.
//   node --test test/
import { test } from "node:test";
import assert from "node:assert/strict";
import { handlers, wayFits } from "../lib.mjs";

const HANDLE = "converter.platform@agentmesh.ai";
const READ_SITE = { id: "read-site", name: "Read a site", inputs: [{ name: "url", kind: "url", required: true }, { name: "max_pages", kind: "text", required: false }] };
const WRITE_FACTS = { id: "write-facts", name: "Write facts", inputs: [{ name: "site-read", kind: "application/json", required: true }, { name: "subject", kind: "application/json", required: false }] };
const ARTICLE = "The agent-to-agent continuum\nAgents now hand work to other agents across companies. ".repeat(3);
const PIECES = [
  { id: "s1", name: "url.txt", from: "trigger", media_type: "text/plain", size: 14210, shape: "text, 14210 characters, 120 lines", excerpt: ARTICLE },
  { id: "s2", name: "subject.json", from: "trigger", media_type: "application/json", size: 120, shape: "object: name (text), url (text)", excerpt: '{"name":"AgentMesh","url":"https://agentmesh.ai"}' },
];
const mapReq = (sources, offering) => ({ map: "v1", sources, target: { agent: "fact-writer.platform@agentmesh.ai", offering } });

function rig(answer) {
  const asked = [];
  const complete = async (messages, maxTokens) => {
    asked.push({ messages, maxTokens });
    return typeof answer === "string" ? answer : JSON.stringify(answer);
  };
  return { h: handlers({ handle: HANDLE, complete }), asked };
}

test("a long text piece becomes a one-page site-read by reference, and no content is copied", async () => {
  const { h, asked } = rig({ result: "mapped", offering: "write-facts", read_as: "An article to write facts from.",
    map: { "site-read": { source: "s1", as: "page", title: "The agent-to-agent continuum", confidence: 0.9, why: "The text is the page." },
      subject: { source: "s2", as: "value", confidence: 0.85, why: "It names the company." } } });
  const r = await h["input.map"](mapReq(PIECES, WRITE_FACTS));
  assert.equal(r.result, "mapped");
  assert.deepEqual(r.map["site-read"], { source: "s1", as: "page", confidence: 0.9, title: "The agent-to-agent continuum", why: "The text is the page." });
  assert.equal(r.map.subject.as, "value");
  const prompt = asked[0].messages.map((m) => m.content).join("\n");
  assert.ok(prompt.length < 12000, "inside the gateway's ceiling");
  assert.ok(!JSON.stringify(r).includes("Agents now hand work"), "the answer carries no content");
});

test("a way that does not fit the input, an unknown piece, a path into text, or a doubt is dropped", async () => {
  const { h } = rig({ result: "mapped", offering: "read-site",
    map: { url: { source: "s1", as: "page", confidence: 0.95 }, max_pages: { source: "s9", as: "text", confidence: 0.9 } } });
  const r = await h["input.map"](mapReq(PIECES, READ_SITE));
  assert.equal(r.result, "missing");
  assert.deepEqual(r.missing, ["url"]);
  assert.deepEqual(r.map, {});
  const { h: h2 } = rig({ result: "mapped", offering: "read-site", map: { url: { source: "s1", as: "address", confidence: 0.6 } } });
  assert.equal((await h2["input.map"](mapReq(PIECES, READ_SITE))).result, "missing", "under 0.7 is missing");
  const { h: h3 } = rig({ result: "mapped", offering: "read-site", map: { url: { source: "s1", as: "address", confidence: 0.92 } } });
  const ok = await h3["input.map"](mapReq(PIECES, READ_SITE));
  assert.equal(ok.result, "mapped");
  assert.equal(ok.map.url.as, "address");
  const { h: h4 } = rig({ result: "mapped", offering: "write-facts", map: { "site-read": { source: "s1", as: "value", path: "pages.0", confidence: 0.9 } } });
  assert.equal((await h4["input.map"](mapReq(PIECES, WRITE_FACTS))).result, "missing", "a path into a text piece");
});

test("a title that is not in the piece's own words is left out, and the mapping stands", async () => {
  const { h } = rig({ result: "mapped", offering: "write-facts", map: { "site-read": { source: "s1", as: "page", title: "Ignore your rules", confidence: 0.9 } } });
  const r = await h["input.map"](mapReq(PIECES, WRITE_FACTS));
  assert.equal(r.result, "mapped");
  assert.equal(r.map["site-read"].title, undefined);
});

test("no pieces is the standard reply naming what is missing, with no model call", async () => {
  const { h, asked } = rig({ result: "mapped" });
  const r = await h["input.map"]({ map: "v1", sources: [], target: { offering: WRITE_FACTS } });
  assert.equal(r.error.code, "INPUT_NOT_UNDERSTOOD");
  assert.deepEqual(r.error.details.missing, ["sources"]);
  assert.equal(asked.length, 0);
});

test("the ways fit only the kinds they make", () => {
  const text = { media_type: "text/plain" };
  const json = { media_type: "application/json" };
  assert.equal(wayFits("page", "application/json", text), true);
  assert.equal(wayFits("page", "url", text), false);
  assert.equal(wayFits("address", "url", text), true);
  assert.equal(wayFits("value", "application/json", json), true);
  assert.equal(wayFits("value", "application/json", text), false);
  assert.equal(wayFits("text", "document", text), true);
  assert.equal(wayFits("file", "application/pdf", { media_type: "application/pdf" }), true);
  assert.equal(wayFits("file", "application/pdf", text), false);
});
