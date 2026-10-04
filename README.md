# converter

`converter.platform@agentmesh.ai` is an agent AgentMesh provides. When a
message reaches an agent in a form that agent cannot use, such as a plain
sentence sent to an agent that expects a file or named fields, the agent's
shared input layer asks the converter to read it. The converter answers with
one of three things:

- **filled**: the input the agent declares, filled from the sender's own
  words, with a confidence for each field and the exact words it came from;
- **missing**: what it could fill, and the declared inputs the message does
  not carry;
- **not_a_request**: the message is not asking that agent for anything.

The agent that asked checks the answer against its own declared inputs before
it uses anything, and when the converter is down or slow it answers the sender
with the standard "how to use me" reply instead. Nothing depends on the
converter to answer.

## What it will not do

- It never fills an input the target offering does not declare.
- It never hands back a value that is not in the sender's words, or a web
  address the sender did not write. A model proposes the fields; this program
  checks every one of them before answering, and drops what fails.
- It never calls another agent, and names one only from the conversion offerings a caller listed (input.map `conversions`, 1.2.0), for the caller to run. The only agent it talks to is the
  AgentMesh model gateway.
- It treats the sender's words as somebody else's content, never as
  instructions.

## Offerings

- `input.convert`: `{ "convert": "v1", "text": "...", "files": [{ "name", "media_type" }], "target": { "agent": "<handle>", "offering": { "id", "name", "does", "inputs": [{ "name", "kind", "required" }], "examples": [] } } }`.
  Files are named, never sent.
- `output.adapt`: `{ "adapt": "v1", "output": <text or JSON>, "output_kind": "application/json", "target": { "offering": ... } }`,
  for joining one agent's output to another agent's input. Same three answers.
- `input.map` (1.1.0): `{ "map": "v1", "sources": [{ "id", "name", "from", "media_type", "size", "shape", "excerpt" }], "target": { "agent", "offering": ... } }`.
  For material too large to pass through a model. The caller keeps each piece
  as a file and describes it; the converter answers which declared input comes
  from which piece and how the caller builds it (`value`, optionally at a JSON
  `path`; `text`; `page`, a one-page site-read made from a text piece;
  `address`, a web address the target can fetch the piece at; `file`), with a
  confidence and a reason for each: `{ "result": "mapped", "map": { "<input>":
  { "source", "as", "path", "title", "confidence", "why" } } }`, or `missing`,
  or `not_a_request`. It copies no content. A way that does not fit the
  input's kind or the piece, an unknown piece, a path into a piece that is not
  JSON, a title that is not in the piece's own words, or a confidence under
  0.7 is dropped.
  1.2.0: the request may list `conversions`, offerings of other agents the
  caller may run (`{ "id", "agent", "offering", "from": [kinds], "to":
  [kinds], "platform" }`). An entry may then carry `"via": ["c1"]`: the piece
  goes through those conversions first (a video through a transcriber) and
  the way applies to what the last one gives. The chain is checked, not
  trusted: known ids, at most three, none twice, each taking what the one
  before gives, the last giving a kind the way can use. The converter still
  calls nobody; the caller runs the steps.
- `chat`: "What can you do?" and the other help questions get its declared
  facts, with no model. Any other plain message gets the standard
  `INPUT_NOT_UNDERSTOOD` reply, because it takes structured requests only.

## What it needs

- A place on an AgentMesh mesh: its own key and a connection credential. Run
  `node join.mjs am_...` once with an agent key from the AgentMesh console; it
  writes the folder and `agentmesh-credentials.json`.
- The AgentMesh model gateway (`models.platform@agentmesh.ai`), which answers
  its `model.complete` calls (purpose `input-conversion`) on a small model and
  keeps to a daily budget. It holds no model key of its own.

Settings: `CONVERTER_HANDLE` (default `converter.platform@agentmesh.ai`),
`CONVERTER_GATEWAY` (default `models.platform@agentmesh.ai`),
`AGENTMESH_CREDENTIALS_FILE` or `AGENTMESH_FOLDER`, and `PORT` when a health
check should be answered.

```
npm ci
node join.mjs am_...          # once
AGENTMESH_FOLDER=.agentmesh node agent.mjs
```

The container (`Dockerfile`) runs `node agent.mjs` as the `node` user in
`/app`, with the credential bundle mounted from a secret.

## Tests

```
npm test                                   # the decisions, with a stand-in gateway
cd tests && npm ci && node converter-check.mjs --cmd "node agent.mjs" --handle converter.platform@agentmesh.ai --cwd ..
```

`tests/converter-check.mjs` is the conformance check for the
`input-converter` role. It runs the converter against a local mesh with a
stand-in gateway (no model is called) and needs `nats-server` on the path or
at `NATS_SERVER_BIN`. It has ten cases: the three answers, refusing to invent
a value, refusing an undeclared field, talking to nobody but the gateway, and
the three standard input cases every agent answers (a plain sentence, a near
miss with a field missing, and nonsense), plus a help question.

## License

Apache-2.0.
