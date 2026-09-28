#!/usr/bin/env node
// The input-converter conformance check (role input-converter v1).
//
// Runs one converter against a mesh of its own: a local nats-server, a
// stand-in model gateway that answers model.complete with fixed JSON (no
// model is called), and a bystander agent that must never hear from it.
//
//   node converter-check.mjs --cmd "node agent.mjs" --handle converter.platform@agentmesh.ai --cwd ..
//
// Options: --json (print the result as JSON as well), --show-logs.
//
// The converter is started with these settings, and one written for this
// check reads them:
//   AGENTMESH_SERVERS      the local mesh: a ws:// and a nats:// address, comma separated
//   AGENTMESH_AGENT_SEED   its key for this run (a throwaway)
//   CONVERTER_HANDLE       its handle
//   CONVERTER_GATEWAY      the gateway's handle (models.platform@agentmesh.ai)
//   CONVERTER_LOCAL=1      no naming service: connect without the naming rule
//   CONVERTER_DIRECTORY    a JSON file mapping handles to agent keys
// and it prints a line containing "converter ready" once it is listening.
//
// Needs node 22 or newer and nats-server (on PATH, or at $NATS_SERVER_BIN).

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, connect as tcpConnect } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AgentMesh, createAgentIdentity } from "agentmesh";

const GATEWAY = "models.platform@agentmesh.ai";
const BYSTANDER = "bystander.converter-check@example.com";
const READY_MS = 120_000;
const ANSWER_MS = 20_000;
const STANDARD_MS = 5_000;   // the three standard input cases must be answered this fast
const CASES = 10;
const WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];

const URL1 = "https://example.com/news/2026/09/28/a-story.html";
const INVENTED = "https://invented.example/not-in-the-message";
const READ_SITE = { id: "read-site", name: "Read a site", inputs: [{ name: "url", kind: "url", required: true }] };
const WRITE_FACTS = { id: "write-facts", name: "Write facts", inputs: [{ name: "site-read", kind: "application/json", required: true }] };

function parseArgs(argv) {
  const o = { json: false, showLogs: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") o.json = true;
    else if (a === "--show-logs") o.showLogs = true;
    else if (a === "--cmd") o.cmd = argv[++i];
    else if (a === "--handle") o.handle = argv[++i];
    else if (a === "--cwd") o.cwd = argv[++i];
    else throw new Error(`unknown option ${a}`);
  }
  if (!o.cmd || !o.handle) throw new Error("usage: converter-check.mjs --cmd <command> --handle <handle> [--cwd <folder>]");
  o.cwd = resolve(o.cwd ?? process.cwd());
  return o;
}

// ── a local mesh ────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function freePort() {
  return new Promise((ok, fail) => {
    const s = createServer();
    s.unref();
    s.on("error", fail);
    s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => ok(port)); });
  });
}
function reachable(port) {
  return new Promise((ok) => {
    const c = tcpConnect(port, "127.0.0.1");
    c.on("connect", () => { c.destroy(); ok(true); });
    c.on("error", () => ok(false));
  });
}
async function startNats(dir) {
  const bin = process.env.NATS_SERVER_BIN || "nats-server";
  const port = await freePort();
  const wsPort = await freePort();
  const conf = join(dir, "nats.conf");
  writeFileSync(conf, [
    `listen: "127.0.0.1:${port}"`,
    `jetstream { store_dir: ${JSON.stringify(join(dir, "js"))} }`,
    `websocket { listen: "127.0.0.1:${wsPort}", no_tls: true }`,
    "",
  ].join("\n"));
  const proc = spawn(bin, ["-c", conf], { stdio: ["ignore", "ignore", "pipe"] });
  let err = "";
  proc.stderr.on("data", (d) => { err = (err + d).slice(-2000); });
  const failed = new Promise((_, fail) => proc.on("error", (e) => fail(new Error(`nats-server did not start (${e.message}); put it on PATH or set NATS_SERVER_BIN`))));
  const up = (async () => {
    for (let i = 0; i < 100; i++) { if (await reachable(port)) return; await sleep(100); }
    throw new Error(`nats-server did not listen on ${port}: ${err.trim().split("\n").pop() ?? ""}`);
  })();
  await Promise.race([up, failed]);
  for (let i = 0; i < 50 && !(await reachable(wsPort)); i++) await sleep(100);
  return { ws: `ws://127.0.0.1:${wsPort}`, tcp: `nats://127.0.0.1:${port}`, stop: () => proc.kill() };
}

// ── the stand-in gateway and the bystander ────────────────────────────────

/** What the stand-in model says, by what it was asked. Each answer is chosen
 *  so the converter's own checks decide the case, not the stand-in. */
function standInAnswer(messages) {
  const user = String(messages?.find((m) => m.role === "user")?.content ?? "");
  const offering = /^Offering: (\S+)/m.exec(user)?.[1] ?? "";
  const words = /<<<SENDER_WORDS\n([\s\S]*?)\nSENDER_WORDS>>>/.exec(user)?.[1] ?? "";
  if (/zxqv/.test(words)) return { result: "not_a_request", why: "It asks for nothing." };
  if (/invent/.test(words)) return { result: "filled", offering, read_as: "A request to read a page.", fields: { url: { value: INVENTED, confidence: 0.99, from: "the page" } } };
  if (offering === "write-facts") return { result: "filled", offering, read_as: "A request to write facts from a page.", fields: { "site-read": { value: { pages: [{ url: URL1, title: "made up", text: "made up" }] }, confidence: 0.99, from: "made up words" } } };
  return { result: "filled", offering, read_as: "A request to read a page.", fields: { url: { value: URL1, confidence: 0.95, from: URL1 }, depth: { value: "3", confidence: 0.99, from: "three" } } };
}

async function testAgent(url, name, offerings, answer) {
  const id = createAgentIdentity();
  const mesh = await AgentMesh.connect(url, { nkeySeed: id.seed, requireNamed: false, fenceInbound: false });
  const got = [];
  for (const offering of offerings) {
    mesh.onRequest(offering, async (input, ctx) => {
      got.push({ offering, from: ctx.envelope.from, input });
      return answer ? answer(offering, input) : { ok: true };
    });
  }
  await mesh.register({ name, offerings: offerings.map((o) => ({ id: o, name: o, description: "converter-check test agent" })) });
  return { id: id.publicKey, mesh, got };
}

function startAgent(o, env) {
  const proc = spawn(o.cmd, { cwd: o.cwd, shell: true, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  let exited = null;
  proc.stdout.on("data", (d) => { log += d; });
  proc.stderr.on("data", (d) => { log += d; });
  proc.on("exit", (code) => { exited = code ?? "signal"; });
  return {
    get log() { return log; },
    async ready() {
      const deadline = Date.now() + READY_MS;
      while (Date.now() < deadline) {
        if (/converter ready/i.test(log)) return;
        if (exited !== null) throw new Error(`the converter exited (${exited}) before it was ready:\n${log.slice(-3000)}`);
        await sleep(200);
      }
      throw new Error(`the converter did not say "converter ready" within ${READY_MS / 1000}s:\n${log.slice(-3000)}`);
    },
    stop() {
      if (exited !== null) return;
      if (process.platform === "win32") spawn("taskkill", ["/pid", String(proc.pid), "/t", "/f"], { stdio: "ignore" });
      else proc.kill("SIGTERM");
    },
  };
}

async function ask(from, to, offering, input, ms = ANSWER_MS) {
  const t0 = Date.now();
  try {
    const r = await from.mesh.request(to, offering, input, { timeout_ms: ms });
    return { status: r.payload?.status ?? null, output: r.payload?.output ?? null, error: r.error ?? null, ms: Date.now() - t0 };
  } catch (err) {
    return { status: "error", error: { message: err?.message ?? String(err), code: err?.code }, ms: Date.now() - t0 };
  }
}

const convert = (text, offering) => ({ convert: "v1", text, target: { agent: "some-agent.platform@agentmesh.ai", offering } });

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const dir = mkdtempSync(join(tmpdir(), "converter-check-"));
  const nats = await startNats(dir);
  const results = [];
  let agent = null;
  const agents = [];
  try {
    const G = await testAgent(nats.ws, "converter-check-gateway", ["model.complete"], (_o, input) => ({
      text: JSON.stringify(standInAnswer(input?.messages)), model: "stand-in", tokens_in: 10, tokens_out: 10, ms: 1,
    }));
    const B = await testAgent(nats.ws, "converter-check-bystander", ["chat", "read-site", "write-facts"]);
    const Q = await testAgent(nats.ws, "converter-check-asker", ["chat"]);
    agents.push(G, B, Q);
    const C = createAgentIdentity();
    const dirFile = join(dir, "directory.json");
    writeFileSync(dirFile, JSON.stringify({ [GATEWAY]: G.id, [BYSTANDER]: B.id, [o.handle]: C.publicKey }, null, 2));
    agent = startAgent(o, {
      AGENTMESH_SERVERS: `${nats.ws},${nats.tcp}`,
      AGENTMESH_AGENT_SEED: C.seed,
      CONVERTER_HANDLE: o.handle,
      CONVERTER_GATEWAY: GATEWAY,
      CONVERTER_LOCAL: "1",
      CONVERTER_DIRECTORY: dirFile,
    });
    await agent.ready();

    const run = async (id, fn) => {
      let problems;
      try { problems = await fn(); } catch (err) { problems = [`the check itself failed: ${err?.message ?? err}`]; }
      results.push({ case: id, pass: problems.length === 0, problems });
    };
    const out = (a) => a.output ?? {};
    const standard = (a, reason) => {
      const bad = [];
      if (a.status !== "completed") return [`answered ${JSON.stringify(a).slice(0, 300)}, expected the standard reply`];
      const e = out(a).error;
      if (e?.code !== "INPUT_NOT_UNDERSTOOD") bad.push(`the error code is ${JSON.stringify(e?.code)}, expected INPUT_NOT_UNDERSTOOD`);
      if (typeof out(a).text !== "string" || !out(a).text.trim()) bad.push("there is no sentence for people");
      if (!Array.isArray(e?.details?.expected) || !e.details.expected.length) bad.push("details.expected does not list what it takes");
      if (typeof e?.details?.example !== "string" || !e.details.example) bad.push("details.example is missing");
      if (reason && e?.details?.reason !== reason) bad.push(`details.reason is ${JSON.stringify(e?.details?.reason)}, expected ${reason}`);
      if (a.ms > STANDARD_MS) bad.push(`answered in ${a.ms} ms, over ${STANDARD_MS} ms`);
      return bad;
    };

    await run("fills-a-declared-input-from-the-senders-words", async () => {
      const a = await ask(Q, C.publicKey, "input.convert", convert(`Please read this page for me: ${URL1}`, READ_SITE));
      const r = out(a);
      if (r.result !== "filled") return [`answered ${JSON.stringify(a).slice(0, 300)}, expected result filled`];
      const bad = [];
      if (r.fields?.url?.value !== URL1) bad.push(`url is ${JSON.stringify(r.fields?.url?.value)}, expected the sender's own address`);
      if (typeof r.fields?.url?.confidence !== "number") bad.push("url carries no confidence");
      if (typeof r.fields?.url?.from !== "string") bad.push("url does not say the words it came from");
      return bad;
    });
    await run("says-what-is-missing", async () => {
      const a = await ask(Q, C.publicKey, "input.convert", convert(`Please extract sourced facts from this page: ${URL1}`, WRITE_FACTS));
      const r = out(a);
      if (r.result !== "missing") return [`answered ${JSON.stringify(a).slice(0, 300)}, expected result missing`];
      return Array.isArray(r.missing) && r.missing.includes("site-read") ? [] : [`missing is ${JSON.stringify(r.missing)}, expected it to name site-read`];
    });
    await run("says-not-a-request", async () => {
      const a = await ask(Q, C.publicKey, "input.convert", convert("zxqv blorp 42 ~~ ::", READ_SITE));
      return out(a).result === "not_a_request" && typeof out(a).why === "string" ? [] : [`answered ${JSON.stringify(a).slice(0, 300)}, expected not_a_request with a reason`];
    });
    await run("refuses-to-invent-a-value", async () => {
      const a = await ask(Q, C.publicKey, "input.convert", convert("Please read the page, do not invent anything", READ_SITE));
      const r = out(a);
      const bad = [];
      if (r.fields?.url) bad.push(`it handed back a web address the sender never wrote: ${JSON.stringify(r.fields.url)}`);
      if (r.result === "filled") bad.push("it answered filled with the required input invented");
      return bad;
    });
    await run("refuses-an-undeclared-field", async () => {
      const a = await ask(Q, C.publicKey, "input.convert", convert(`Read ${URL1}, three levels deep`, READ_SITE));
      const r = out(a);
      if (r.result !== "filled") return [`answered ${JSON.stringify(a).slice(0, 300)}, expected result filled`];
      return Object.keys(r.fields ?? {}).some((k) => k !== "url") ? [`it handed back fields the offering does not declare: ${Object.keys(r.fields).join(", ")}`] : [];
    });
    await run("reaches-only-the-gateway", async () => {
      await sleep(1000);
      const bad = [];
      if (B.got.length) bad.push(`it sent to another agent: ${B.got.map((g) => g.offering).join(", ")}`);
      if (!G.got.length) bad.push("it never asked the gateway");
      for (const g of G.got) {
        if (g.input?.purpose !== "input-conversion") bad.push(`a gateway call carried purpose ${JSON.stringify(g.input?.purpose)}`);
        if (!Array.isArray(g.input?.messages) || !g.input.messages.length) bad.push("a gateway call carried no messages");
        if (!Number.isInteger(g.input?.max_tokens)) bad.push("a gateway call carried no max_tokens");
      }
      return [...new Set(bad)];
    });
    await run("answers-a-plain-sentence-with-the-standard-reply", async () =>
      standard(await ask(Q, C.publicKey, "chat", { text: "Could you please sort out my notes from yesterday?" }, STANDARD_MS + 2000)));
    await run("answers-a-near-miss-naming-the-missing-field", async () => {
      const a = await ask(Q, C.publicKey, "input.convert", { convert: "v1", text: "Please read the page" }, STANDARD_MS + 2000);
      const bad = standard(a, "missing_input");
      const missing = out(a).error?.details?.missing;
      if (!Array.isArray(missing) || !missing.includes("target")) bad.push(`details.missing is ${JSON.stringify(missing)}, expected it to name target`);
      return bad;
    });
    await run("answers-nonsense-with-the-standard-reply", async () =>
      standard(await ask(Q, C.publicKey, "chat", { text: "zxqv blorp 42 ~~ ::" }, STANDARD_MS + 2000)));
    await run("answers-a-help-question-from-its-card", async () => {
      const before = G.got.length;
      const a = await ask(Q, C.publicKey, "chat", { text: "What can you do?" }, STANDARD_MS + 2000);
      const bad = [];
      if (a.status !== "completed" || out(a).grade !== "declared" || !/input\.convert/.test(String(out(a).text))) bad.push(`answered ${JSON.stringify(a).slice(0, 300)}, expected its declared card`);
      if (G.got.length !== before) bad.push("it asked the model to answer a help question");
      if (a.ms > STANDARD_MS) bad.push(`answered in ${a.ms} ms, over ${STANDARD_MS} ms`);
      return bad;
    });
  } catch (err) {
    results.push({ case: "setup", pass: false, problems: [err?.message ?? String(err)] });
  } finally {
    agent?.stop();
    for (const a of agents) await a.mesh.close().catch(() => {});
    nats.stop();
    await sleep(300);
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* a file still held open on Windows */ }
  }

  const passed = results.filter((r) => r.pass).length;
  const conforms = results.length === CASES && passed === CASES;
  console.log(`Input converter check: ${o.handle}, stand-in gateway, no model`);
  for (const r of results) {
    console.log(`  ${r.pass ? "PASS" : "FAIL"}  ${r.case}`);
    for (const p of r.problems) console.log(`        ${p}`);
  }
  console.log(conforms ? `Conforms: all ${WORDS[CASES]} cases pass (${passed}/${results.length} run).` : `Does not conform: ${passed} of ${results.length} passed.`);
  if (o.showLogs && agent) console.log(`\n--- the converter's output ---\n${agent.log}`);
  if (o.json) console.log(JSON.stringify({ handle: o.handle, conforms, results }, null, 2));
  process.exit(conforms ? 0 : 1);
}

main().catch((err) => { console.error(err?.message ?? err); process.exit(2); });
