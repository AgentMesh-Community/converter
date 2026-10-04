// input.map with conversions (1.2.0): a piece that is not words (a video, a
// recording) may be mapped through conversions the caller lists, and the caller
// runs them. The converter calls no agent; it only names ids from the list, and
// the chain is checked here, not trusted.
//   node --test test/
import { test } from "node:test";
import assert from "node:assert/strict";
import { chainOf, handlers, kindTakes, readConversions } from "../lib.mjs";

const HANDLE = "converter.platform@agentmesh.ai";
const READ_SITE = { id: "read-site", inputs: [{ name: "url", kind: "url", required: true }] };
const WRITE_FACTS = { id: "write-facts", inputs: [{ name: "site-read", kind: "application/json", required: true }] };
const VIDEO = { id: "s1", name: "talk.mp4", from: "trigger", media_type: "video/mp4", size: 3_000_000, shape: "a file of 3000000 bytes", excerpt: "" };
const CONVERSIONS = [
  { id: "c1", agent: "audio-video-transcriber.platform@agentmesh.ai", offering: "transcribe", name: "Transcribe", from: ["url", "document"], to: ["text/vtt", "text/plain", "audio/mpeg"], platform: true },
  { id: "c2", agent: "pdf-reader.acme", offering: "read-pdf", from: ["application/pdf"], to: ["text/plain"] },
];
const req = (offering, extra = {}) => ({ map: "v1", sources: [VIDEO], conversions: CONVERSIONS, target: { agent: "x", offering }, ...extra });
function rig(answer) {
  const asked = [];
  return { asked, h: handlers({ handle: HANDLE, complete: async (m) => { asked.push(m); return JSON.stringify(answer); } }) };
}

test("a video becomes a site-read through the transcriber: the chain is checked and handed back", async () => {
  const { h, asked } = rig({ result: "mapped", offering: "write-facts", map: { "site-read": { source: "s1", as: "page", via: ["c1"], confidence: 0.9, why: "Its words are in its speech." } } });
  const r = await h["input.map"](req(WRITE_FACTS));
  assert.equal(r.result, "mapped");
  assert.deepEqual(r.map["site-read"].via, [{ id: "c1", agent: "audio-video-transcriber.platform@agentmesh.ai", offering: "transcribe", to: "text/plain" }]);
  assert.match(asked[0].map((m) => m.content).join("\n"), /c1: url or document -> text\/vtt, text\/plain, audio\/mpeg \(platform\)/);
});

test("a chain that does not hold is dropped: an unknown id, a step that does not take the piece, too long, a repeat", async () => {
  for (const via of [["c9"], ["c2"], ["c1", "c1"], ["c1", "c2", "c1", "c2"]]) {
    const { h } = rig({ result: "mapped", offering: "write-facts", map: { "site-read": { source: "s1", as: "page", via, confidence: 0.9 } } });
    assert.equal((await h["input.map"](req(WRITE_FACTS))).result, "missing", JSON.stringify(via));
  }
  const { h } = rig({ result: "mapped", offering: "write-facts", map: { "site-read": { source: "s1", as: "page", confidence: 0.9 } } });
  assert.equal((await h["input.map"](req(WRITE_FACTS))).result, "missing", "a video is no page without a conversion");
});

test("the kinds an offering takes are read as declared", () => {
  assert.equal(kindTakes("document", "video/mp4"), true);
  assert.equal(kindTakes("video/*", "video/mp4"), true);
  assert.equal(kindTakes("text", "video/mp4"), false);
  assert.equal(kindTakes("application/pdf", "video/mp4"), false);
  assert.deepEqual(readConversions([{ id: "c1", from: [], to: ["text/plain"] }, { id: "bad id!", from: ["x"], to: ["y"] }]), []);
  assert.equal(chainOf(["c1"], readConversions(CONVERSIONS), VIDEO, "address", "url")[0].to, "text/plain", "any kind can be given an address; plain words first");
});

test("with no conversions listed, the rule against naming agents stands", async () => {
  const { h, asked } = rig({ result: "missing", offering: "read-site", map: {}, missing: ["url"] });
  await h["input.map"]({ map: "v1", sources: [VIDEO], target: { offering: READ_SITE } });
  assert.match(asked[0][0].content, /Never suggest another agent or service/);
});
