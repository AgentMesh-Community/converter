// converter.platform@agentmesh.ai: turns a message an agent could not use into
// the input that agent declares, or says plainly what is missing.
//
// This file is the mesh around lib.mjs: it connects with the agent's own key,
// answers input.convert, output.adapt and chat, and reaches a model only
// through the AgentMesh model gateway (model.complete with purpose
// "input-conversion"), so it holds no model key and calls no other agent.
//
// Settings, all from the environment:
//   CONVERTER_HANDLE            this agent's handle (default converter.platform@agentmesh.ai)
//   CONVERTER_GATEWAY           the model gateway (default models.platform@agentmesh.ai)
//   AGENTMESH_CREDENTIALS_FILE  the credential bundle join.mjs wrote (on Cloud
//                               Run, the mounted secret), or
//   AGENTMESH_FOLDER            the folder join.mjs wrote
//   PORT                        when set (Cloud Run sets it), answer health checks there
//
// The conformance check sets CONVERTER_LOCAL=1, AGENTMESH_SERVERS,
// AGENTMESH_AGENT_SEED and CONVERTER_DIRECTORY instead; see tests/converter-check.mjs.
//
//   node agent.mjs

import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import {
  AgentMesh,
  CredentialRenewer,
  Diagnostics,
  ErrorCode,
  MeshError,
  canonicalJSON,
  jwtAuthenticator,
  keyPairFromSeed,
} from "agentmesh";
import { DOES, OFFERINGS, REFUSALS, handlers } from "./lib.mjs";

export const DEFAULT_HANDLE = "converter.platform@agentmesh.ai";
export const DEFAULT_GATEWAY = "models.platform@agentmesh.ai";
export const GATEWAY_TIMEOUT_MS = 7_000;
export const SOURCE = "https://github.com/AgentMesh-Community/converter";

const nowIso = () => new Date().toISOString();
const log = (msg) => console.log(`${nowIso()} ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── who is who ──────────────────────────────────────────────────────────────

class Keys {
  constructor(mesh, directory) {
    this.fixed = directory
      ? Object.fromEntries(Object.entries(JSON.parse(readFileSync(directory, "utf8"))).map(([k, v]) => [k.toLowerCase(), v]))
      : null;
    this.diag = new Diagnostics(mesh);
    this.cache = new Map();
  }
  async of(handle) {
    const h = String(handle).trim().toLowerCase();
    if (this.fixed) return this.fixed[h] ?? null;
    const hit = this.cache.get(h);
    if (hit && Date.now() - hit.at < 600_000) return hit.key;
    const r = await this.diag.resolve(h).catch(() => null);
    const key = r?.resolved ? r.agentId ?? null : null;
    if (key) this.cache.set(h, { key, at: Date.now() });
    return key;
  }
}

// ── connecting (the same as the reference agents) ─────────────────────────

function parseCreds(text) {
  const jwt = /-----BEGIN NATS USER JWT-----\s*([^\s-][^\s]*)\s*------END NATS USER JWT------/.exec(text)?.[1];
  const seed = /-----BEGIN USER NKEY SEED-----\s*(SU[A-Z2-7]+)\s*------END USER NKEY SEED------/.exec(text)?.[1];
  if (!jwt || !seed) throw new Error("the credential file is not a NATS .creds file");
  return { jwt, seed };
}

/** The credential bundle. One holding only the agent's key (its name is bound,
 *  it has not joined yet) is waited on: Cloud Run re-reads a secret mounted
 *  at "latest", so the credential is picked up when it is added. */
async function readBundle(path) {
  let said = 0;
  for (;;) {
    const d = JSON.parse(readFileSync(path, "utf8"));
    if (d.mesh_creds) return d;
    if (Date.now() - said > 600_000) { log("waiting for this agent's connection credential (the bundle has its key only)"); said = Date.now(); }
    await sleep(30_000);
  }
}

async function loadCredentials() {
  const bundle = process.env.AGENTMESH_CREDENTIALS_FILE;
  if (bundle) {
    const d = await readBundle(bundle);
    return { agentSeed: String(d.agent_seed).trim(), ...parseCreds(String(d.mesh_creds)), servers: d.servers ?? [], apiBase: d.api_base ?? "https://api.agentmesh.ai" };
  }
  const folder = process.env.AGENTMESH_FOLDER;
  if (!folder) throw new Error("Set AGENTMESH_CREDENTIALS_FILE or AGENTMESH_FOLDER (see the README: node join.mjs am_...).");
  const meta = JSON.parse(readFileSync(join(folder, "mesh.json"), "utf8"));
  return {
    agentSeed: readFileSync(join(folder, "agent.seed"), "utf8").trim(),
    ...parseCreds(readFileSync(join(folder, "mesh.creds"), "utf8")),
    servers: meta.servers ?? [],
    apiBase: meta.api_base ?? "https://api.agentmesh.ai",
  };
}

/** The WebSocket endpoint works from anywhere, a Cloud Run container included. */
const pickServers = (servers) => {
  const ws = servers.filter((s) => /^wss?:\/\//.test(s));
  return ws.length ? ws : servers;
};

async function connectMesh(local) {
  if (local) {
    return AgentMesh.connect(pickServers(String(process.env.AGENTMESH_SERVERS).split(",").filter(Boolean)), { nkeySeed: process.env.AGENTMESH_AGENT_SEED, requireNamed: false, fenceInbound: false });
  }
  const c = await loadCredentials();
  const agentId = keyPairFromSeed(c.agentSeed).getPublicKey();
  const renewer = new CredentialRenewer({ apiBase: c.apiBase, jwt: c.jwt, nodeSeed: c.seed, agents: [{ id: agentId, seed: c.agentSeed }] });
  try {
    c.jwt = (await renewer.renew()).jwt;
    log("credential renewed at start");
  } catch (err) {
    if (renewer.status().expired) throw err;
    log(`credential not renewed at start (${err?.message ?? err}); using the saved one`);
  }
  const chosen = String(process.env.AGENTMESH_SERVERS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return AgentMesh.connect(pickServers(chosen.length ? chosen : c.servers), {
    nkeySeed: c.agentSeed,
    authenticator: jwtAuthenticator(c.jwt, new TextEncoder().encode(c.seed)),
    jwt: c.jwt,
    credentialRenewal: { apiBase: c.apiBase, credentialSeed: c.seed },
    // The sender's words are fenced by lib.mjs's prompt, once.
    fenceInbound: false,
  });
}

// ── the gateway ─────────────────────────────────────────────────────────────

/** model.complete on the gateway, purpose input-conversion. Returns the text,
 *  or throws; a throw with held = true means the house screening held it. */
export function gatewayCaller(mesh, keys, gatewayHandle, timeoutMs = GATEWAY_TIMEOUT_MS) {
  return async (messages, maxTokens) => {
    const to = await keys.of(gatewayHandle);
    if (!to) throw new Error(`${gatewayHandle} does not resolve`);
    const r = await mesh.request(to, "model.complete", { purpose: "input-conversion", messages, max_tokens: maxTokens }, { timeout_ms: timeoutMs });
    const out = r.payload?.output;
    if (r.payload?.status === "completed" && typeof out?.text === "string") return out.text;
    const refused = typeof out?.refused === "string" ? out.refused : JSON.stringify(r.payload ?? null).slice(0, 200);
    const err = new Error(`the gateway refused: ${refused}`);
    err.held = out?.held === true || /held by (the )?(house )?screening/i.test(refused);
    throw err;
  };
}

/** The Agent Descriptor, signed by the agent's own key, filed at the registry. */
async function fileDescriptor(mesh, handle) {
  const body = {
    format: "agent-descriptor-v1",
    agent_version: "1.2.1",
    subject: { id: mesh.id, handle },
    does: `${DOES} Source: ${SOURCE}.`,
    interaction: "service",
    role: "input-converter",
    offerings: OFFERINGS.map((o) => ({ id: o.id, name: o.name, does: o.does, inputs: o.inputs, examples: o.examples, outputs: [{ name: o.id === "input.map" ? "mapped, missing or not_a_request" : "filled, missing or not_a_request", kind: "application/json", when: "per_task" }] })),
    systems: [{ name: "AgentMesh model gateway", access: "call", needs: "a cheap model reads the sender's words; the words go to it", leaves: true }],
    refusals: REFUSALS,
    records: [],
  };
  const sig = mesh.signDetached(`descriptor-statement-v1\n${canonicalJSON(body)}`);
  const doc = { ...body, signatures: [{ tag: "descriptor-statement-v1", by: mesh.id, sig }] };
  try {
    await mesh.serviceRequest("mesh.registry.descriptor.put", { descriptor: Buffer.from(JSON.stringify(doc)).toString("base64") }, 10_000);
    log("descriptor filed at the registry");
  } catch (err) {
    log(`descriptor not filed (${err?.message ?? err}); the agent works the same without it`);
  }
}

// ── the agent ───────────────────────────────────────────────────────────────

export async function main() {
  const handle = String(process.env.CONVERTER_HANDLE ?? DEFAULT_HANDLE).trim().toLowerCase();
  const gatewayHandle = String(process.env.CONVERTER_GATEWAY ?? DEFAULT_GATEWAY).trim().toLowerCase();
  const local = process.env.CONVERTER_LOCAL === "1";
  if (process.env.PORT) {
    createServer((_req, res) => { res.writeHead(200, { "content-type": "text/plain" }); res.end("converter\n"); })
      .listen(Number(process.env.PORT), "0.0.0.0", () => log(`health checks answered on port ${process.env.PORT}`));
  }
  const mesh = await connectMesh(local);
  const keys = new Keys(mesh, local ? process.env.CONVERTER_DIRECTORY : null);
  const h = handlers({ handle, complete: gatewayCaller(mesh, keys, gatewayHandle), log });
  for (const [offering, fn] of Object.entries(h)) {
    mesh.onRequest(offering, async (input, ctx) => {
      try {
        const out = await fn(input);
        log(`${offering} from ${String(ctx?.envelope?.from ?? "").slice(0, 10)}...: ${out?.result ?? out?.error?.code ?? out?.grade ?? "answered"}`);
        return out;
      } catch (err) {
        if (err?.dependency) throw new MeshError(ErrorCode.DEPENDENCY_FAILED, err.message, { retryable: true });
        throw err;
      }
    });
  }
  await mesh.register({
    name: handle.split(".")[0],
    description: `${DOES} Source: ${SOURCE}.`,
    interaction: "service",
    offerings: [
      ...OFFERINGS.map((o) => ({ id: o.id, name: o.name, description: o.does })),
      { id: "chat", name: "Chat", description: "A help question gets this agent's declared facts; any other plain message gets the standard INPUT_NOT_UNDERSTOOD reply, since it takes structured requests only." },
    ],
    visibility: "public",
    meta: { roles: ["input-converter@1"] },
  });
  log(`converter ready: ${handle} as ${mesh.id}`);
  if (!local) void fileDescriptor(mesh, handle);
  const stop = async () => { await mesh.close().catch(() => {}); process.exit(0); };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("agent.mjs")) {
  main().catch((err) => { log(`the converter stopped: ${err?.message ?? err}`); process.exit(1); });
}
