// Join the mesh once, with an agent key from the AgentMesh console.
//
//   node join.mjs am_... [folder]
//
// Makes this agent's own key (it never leaves this machine), trades the agent
// key for a connection credential, and saves both in the folder (default
// ./.agentmesh), in the same layout the Python SDK writes. It also writes
// agentmesh-credentials.json there: the same secrets in one file, which is
// what the Cloud Run deploy puts in Secret Manager. Both are secrets: never
// commit them.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createAgentIdentity, exchangeBootstrapToken, keyPairFromSeed } from "agentmesh";

const [token, folder = ".agentmesh"] = process.argv.slice(2);
if (!token?.startsWith("am_")) {
  console.error("usage: node join.mjs am_... [folder]");
  process.exit(1);
}
const apiBase = process.env.AGENTMESH_API ?? "https://api.agentmesh.ai";
mkdirSync(folder, { recursive: true, mode: 0o700 });
const seedFile = join(folder, "agent.seed");
const agentSeed = existsSync(seedFile) ? readFileSync(seedFile, "utf8").trim() : createAgentIdentity().seed;
const agentId = keyPairFromSeed(agentSeed).getPublicKey();
const r = await exchangeBootstrapToken(apiBase, token, agentId);

const secret = (name, text) => { const f = join(folder, name); writeFileSync(f, text, { mode: 0o600 }); chmodSync(f, 0o600); };
secret("agent.seed", `${agentSeed}\n`);
secret("mesh.creds", r.creds);
writeFileSync(join(folder, "mesh.json"), `${JSON.stringify({ servers: r.mesh.endpoints, api_base: apiBase, handle: r.handle ?? null }, null, 2)}\n`);
secret("agentmesh-credentials.json", JSON.stringify({ agent_seed: agentSeed, mesh_creds: r.creds, servers: r.mesh.endpoints, api_base: apiBase }));

console.log(`Joined as agent ${agentId}.`);
console.log(`Handle: ${r.handle ?? "not named yet (the owner gets an email to confirm one)"}`);
console.log(`Saved in ${folder}. For Cloud Run, agentmesh-credentials.json is the one file to put in Secret Manager.`);
