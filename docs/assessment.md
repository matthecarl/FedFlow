# FedFlow — a cited handoff after an Elastic support call

This is a realistic support-team scenario using public Elastic Search Labs material. A support engineer currently collects details over a call, searches the knowledge base, and writes a handoff that another engineer can verify. Repeating those steps delays escalations and often leaves the next engineer looking for the same evidence.

## Architecture

```mermaid
flowchart LR
  Caller[Support engineer] --> Search[Existing Elastic knowledge search]
  Search --> Notes[Manual handoff notes]
```

```mermaid
flowchart LR
  Browser[Reviewer browser]
  Voice[OpenAI Realtime]
  Elastic[External Elasticsearch: Search Labs]
  subgraph Vercel
    App[Next.js app and authenticated API]
    Work[Workflow: search then draft]
    Gateway[AI Gateway]
  end
  Browser <-->|WebRTC audio| Voice
  Browser <-->|reviewed excerpt and draft| App
  App -->|voice search tool| Elastic
  App -->|start or recover run| Work
  Work -->|read-only search| Elastic
  Work -->|AI SDK structured generation| Gateway
```

Elasticsearch retains the index, ingestion, relevance configuration, and search permissions. The demo reads `search-labs-blogs` through `body_semantic` over authenticated HTTPS. Voice uses a short-lived browser credential and a direct OpenAI media connection. Vercel receives the explicitly approved text excerpt for the handoff. These are separate failure paths.

| Vercel choice | Role and trade-off |
| --- | --- |
| AI SDK | Enforces the draft shape and gives the app usage data. The server still verifies citations against retrieved sources. |
| AI Gateway | Gives the draft model a single endpoint and exposes model usage. Its costs cover the draft model call; voice is billed separately. |
| Workflows | Checkpoints retrieval and generation so the draft can continue when a tab reloads. It introduces state retention and retry semantics that matter in production. |
| Preview Deployments | Pin review to a commit and validate both providers and Elastic before promotion. Build readiness alone does not validate upstream credentials. |

## Reviewer walkthrough

1. Open the commit-specific preview from the deck and sign in as `demo` with the supplied test password. If the deployment is protected, use the private link shared from Vercel.
2. Select **Connect**, grant microphone access, and ask one of the two example questions. Inspect the retrieved evidence, then select **Draft handoff**. **Try sample call** uses a synthetic excerpt and the same live dependencies without a microphone.
3. Review the excerpt and select **Generate handoff**. Refresh after submitting, then open the recovered draft and follow its citations. The live audio session is separate from the recovered draft.

The public repository is [FedFlow](https://github.com/matthecarl/FedFlow/tree/codex/vercel-sa-demo). Keep the commit, preview URL, and actual run evidence together in the deck. Supply test credentials privately.

## Evaluation and release

- Run `npm run lint`, `node --test tests/*.test.cjs`, and `npm run build`. Exercise valid sources, irrelevant and missing evidence, a fabricated citation, dependency timeout, and an expired or modified receipt. Prefer deterministic failure fixtures over forcing outages in the shared project.
- In preview, record the same receipt recovering the same result after refresh. Capture actual Gateway model usage, per-draft cost, latency, and the observed Workflow stages. Evaluate voice and the sample separately. For a production pilot, time five paired manual and assisted handoffs, aim for 30% less median preparation time, and require zero unsupported citations in the reviewed sample. These are pilot targets.
- Preview → validation → invited support pilot → cutover → rollback. Advance after an operator verifies access, grounded citations, recovery, and dependency health. Use a 5% then 25% canary before full cutover where Rolling Releases is available. Pause promotion on a citation or recovery regression. Roll back to the last eligible production deployment and verify the voice and sample paths.
- Production requires individual SSO, authorized access to run records, credential rotation, explicit transcript retention and data residency review, and usage controls. Demo data must be public or synthetic. Confirm that a provider change meets the same citation and privacy requirements before promoting it.

## Development tooling

Codex agents worked in parallel on the Voice UI, Workflow API and evaluation, and a parser benchmark. Vercel Board held private, unsynced task discussions and sanitized results. The Rust/Wasm experiment passed parser parity and improved warm CPU use, but missed the first-use latency gate. The demo release uses the existing parser.
