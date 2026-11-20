# FedFlow — voice support and cited handoffs

A Next.js application for voice and typed conversations through OpenAI Realtime, grounded in an existing Elasticsearch knowledge base. After an Elastic support conversation, a reviewer approves a transcript excerpt and requests a durable draft handoff with sources and a proposed next step.

![Screenshot of the Realtime API Agents Demo](public/screenshot.png)

## Local setup

Use Node.js 22 or newer and npm. Install the locked dependencies:

```sh
npm ci
```

For local development, configure the following server-side variables in an untracked `.env.local`. Use this table as the active configuration reference. If the file already exists, update its existing keys rather than creating conflicting definitions. Never put API keys in `NEXT_PUBLIC_*` variables or commit real environment files.

The active demo uses:

| Variable | Purpose |
| --- | --- |
| `DEMO_PASSWORD_ENABLED` | Optional; protected by default. Set exactly `false` to temporarily disable the password gate |
| `DEMO_PASSWORD` | Random password of at least 16 characters when protection is enabled; login username is `demo` |
| `OPENAI_API_KEY` | Server-side OpenAI key with Realtime access and available quota |
| `OPENAI_REALTIME_MODEL` | Optional; defaults to `gpt-realtime-2.1-mini` |
| `ELASTICSEARCH_CAPSTONE_URL` | Elasticsearch HTTPS endpoint |
| `ELASTICSEARCH_CAPSTONE_API_KEY` | Encoded API key permitted to read the required indices and use their inference services |
| `HANDOFF_RECEIPT_SECRET` | Random secret of at least 32 characters for signing handoff receipts. Configure it separately in Preview and local development |
| `AI_GATEWAY_API_KEY` | For local handoff generation when Vercel OIDC is unavailable. The linked Vercel project uses OIDC |

```sh
npm run dev
```

Open [http://localhost:3000](http://localhost:3000), sign in as `demo` with your `DEMO_PASSWORD`, then select **Connect** and allow microphone access. Elastic is the default specialist. If the browser blocks audio autoplay, select **Enable audio**. Microphone access requires localhost or HTTPS. **Try sample call** opens the handoff form without starting a voice session.

Typed messages use the same OpenAI Realtime session as voice and currently require a working microphone. Denied/unavailable microphone access, or a connection timeout while waiting for the microphone, opens a recovery dialog. Allow access in browser/site and device settings, then use **Refresh and try again** or **I've enabled my microphone — reconnect**. Refreshing alone does not clear a saved permission denial. Use **Try sample call** to exercise the handoff without a microphone.

HTTP Basic authentication is on by default. The handoff API always requires the demo login. The framework-generated Workflow queue callback has its own authentication, so the Next.js proxy leaves that route to Workflow. User-facing API responses are private and uncached. Browsers remember Basic credentials. Use a private window for reviewer testing and close it after the demo. Rotating the password requires a new deployment. Older deployments retain their configuration and access settings.

The server mints a short-lived token with `/v1/realtime/client_secrets`; the browser exchanges its SDP offer at `/v1/realtime/calls`. The standard OpenAI key stays on the server. Replacing a key alone does not migrate applications using the retired beta session API.

Specialist handoffs retain the Realtime conversation and explicitly pass `user_question` and `conversation_context` in the transfer tool result. The outgoing agent announces an obvious transfer without asking for routing approval. The receiving specialist introduces itself, summarizes the question, and asks for confirmation before retrieving an answer. Its introductory response disables tool calls for that turn only. After confirmation or correction, it searches using the resolved question and context. Generated wording can vary.

## Assessment walkthrough

1. With the Elastic specialist selected, ask “How can I combine keyword and semantic search in Elasticsearch using reciprocal rank fusion?” or “What is ELSER, and when should I use it for semantic search?”
2. Select **Draft handoff** and review the excerpt. Submit only demo material. Without a microphone, use **Try sample call** to supply a synthetic excerpt while using the same live search and model.
3. Refresh the page while the draft is pending. The signed receipt in this browser tab identifies the same Workflow run. Open the sources in the completed draft and check the suggested next step against them.

The browser sends only the excerpt you approve. Vercel Workflows checkpoints the post-call retrieval and generation steps. The AI SDK uses GPT-5 mini through AI Gateway and the application resolves citations against the existing Search Labs index. The live audio session is separate and ends when the page reloads. Drafts require human review before being used in support.

See [assessment notes](docs/assessment.md) for architecture, evaluation, rollout, and the reviewer script.

## Vercel features in this demo

| Feature | Where it is used |
| --- | --- |
| AI SDK | Structured handoff generation and model usage data in `src/app/workflows/support-handoff.ts` |
| AI Gateway | The handoff model call to `openai/gpt-5-mini`; the live OpenAI Realtime connection has a separate path and bill |
| Workflows | Checkpointed retrieval and generation, bounded retries, and recovery of the same handoff run after a tab refresh |
| Vercel Functions | Next.js server routes for short-lived Realtime credentials, external Elasticsearch retrieval, and starting or reading handoff runs |
| Preview Deployments | Commit-specific review and validation before production promotion |
| Vercel Board — development only | Private, unsynced coordination between the coding and review agents that built the demo |

Board is development tooling. Runtime support data comes from Elasticsearch, the approved browser excerpt, and the handoff Workflow. See [architecture](architecture.md) for the separate voice and handoff paths.

## Data sources

These are existing Elasticsearch indices, not live calls to the source websites. The application does not crawl or populate them during setup. It queries the public `semantic_text` interface and returns retrieved passages and available source URLs.

| Agent | Application route | Index | Semantic field |
| --- | --- | --- | --- |
| Elastic | `/api/elasticsearch` | `search-labs-blogs` | `body_semantic` |
| VA | `/api/va` | `search-va` | `semantic_text` |
| Medicare | `/api/medicare` | `search-medicare` | `semantic_text` |
| IRS | `/api/irs` | `search-irs` | `semantic_text` |
| BioGuide | `/api/bioguide` | `person` | `profileText_semantic` |

VA, IRS, and BioGuide combine lexical and semantic retrieval using reciprocal rank fusion. The other routes use semantic retrieval. The indices must contain the expected fields, and their mapped inference endpoints must have healthy model allocations. Green index health does not establish inference readiness.

First retrieval verification after starting the app:

```sh
curl --user demo --fail-with-body 'http://localhost:3000/api/elasticsearch?q=What%20is%20semantic%20search%3F'
```

Enter the demo password at curl's prompt. When `DEMO_PASSWORD_ENABLED=false`, omit `--user demo` to skip that prompt. A successful response contains a `results` array. Review the returned passages and sources as well as the HTTP status.

## Validation and demo rehearsal

```sh
npm run lint
node --test tests/*.test.cjs
npm run build
npm start
```

Tests exercise API validation, retrieval behavior, event handling, handoffs, telemetry safety, and connection cleanup with mocked external services. They do not establish live credentials, deployed model health, or microphone/audio behavior.

Verify a running local server or deployment with the repeatable API smoke check:

```sh
node --env-file=.env.local scripts/check-demo.mjs https://your-preview-deployment.vercel.app
```

This checks the homepage, creates one short-lived Realtime token without printing it, and verifies nonempty results from all five Elasticsearch search routes. It exits nonzero on any failure and sends no email. Microphone capture, audio playback, interruption, and agent handoffs still require the browser rehearsal below.

Before recording:

1. Open the app, select **Connect**, and confirm the status becomes **Connected** and the greeting appears and plays.
2. Ask an Elastic question. Confirm retrieval returns relevant source material and a spoken answer.
3. Type a follow-up and confirm the transcript and audio complete.
4. Ask to switch to VA or another agent, then ask a relevant question. Check the answer and source links.
5. Interrupt an answer; exercise push-to-talk and audio playback controls.
6. Disconnect and reconnect. Confirm microphone capture stops after disconnect and no repeated automatic retries occur on errors.
7. Use **Try sample call**, generate a handoff, refresh while pending, and verify the recovered result and its citations.

The conversation transcript includes messages and expandable tool details. The agent selector changes the active agent; the event panel helps diagnose requests and responses. Keep diagnostic panels closed for the recording when they are not needed.

## Vercel deployment

Set the required environment variables on the intended Vercel project and environment. Preview and Production settings are separate. `NEXT_PUBLIC_*` settings are included at build time, so updating them requires a new deployment.

Build and test a preview before promoting it. Verify the project, deployment URL, Git commit, domain alias, and runtime behavior; Vercel **Ready** means the deployment built, not that OpenAI or Elasticsearch requests work. This README describes configuration and validation, not the current deployment or cluster-upgrade status.

## Extending the agents

Agent prompts, tool schemas, and tool implementations live in [`src/app/agentConfigs`](src/app/agentConfigs). Start with [`elasticBlogsAgent.ts`](src/app/agentConfigs/semanticSearch/elasticBlogsAgent.ts). Retrieval routes live under `src/app/api`; the shared search implementation is [`utility.ts`](src/app/api/utility.ts).

The conversation flow is browser ↔ OpenAI Realtime, with tool calls executed by the browser through a Next.js retrieval route to Elasticsearch. The handoff flow is approved excerpt → Next.js route → Workflow → Elasticsearch retrieval → AI Gateway generation → reviewed draft.

## Core contributors

- Noah MacCallum — [noahmacca](https://x.com/noahmacca)
- Ilan Bigio — [ibigio](https://github.com/ibigio)
- Matt Carl — application adaptations and Elastic integrations

The responsive conversation shell fills the available viewport height. Conversation and diagnostics scroll independently; the message composer and connection controls remain visible. Logs use a side panel on wide screens and a dedicated view on narrow screens (toggle Logs off to return). Input autofocus is disabled so a phone keyboard only opens when requested.
