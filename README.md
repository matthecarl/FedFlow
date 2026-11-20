# FedFlow — voice support and cited handoffs

A Next.js application for voice and typed conversations through direct OpenAI Realtime and Vercel AI Gateway, grounded in an existing Elasticsearch knowledge base. After a BioGuide research conversation, a reviewer approves a transcript excerpt and requests a durable draft handoff with official congressional sources and a proposed next step.

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
| `OPENAI_REALTIME_MODEL` | Optional for direct OpenAI Realtime. Defaults to `gpt-realtime-2.1-mini` |
| `ELASTICSEARCH_CAPSTONE_URL` | Elasticsearch HTTPS endpoint |
| `ELASTICSEARCH_CAPSTONE_API_KEY` | Encoded API key permitted to read the required indices and use their inference services |
| `HANDOFF_RECEIPT_SECRET` | Random secret of at least 32 characters for signing handoff receipts. Configure it separately in Preview and local development |
| `AI_GATEWAY_REALTIME_API_KEY` | Server-side Gateway key for the four specialist voice routes. Store it in the intended Preview environment |
| `AI_GATEWAY_API_KEY` | Local fallback for Gateway voice and handoff generation. The deployed handoff uses Vercel OIDC |

```sh
npm run dev
```

Open [http://localhost:3000](http://localhost:3000), sign in as `demo` with your `DEMO_PASSWORD`, then select **Connect** and allow microphone access. The Greeter opens by default. Choose a specialist from **Agent** or ask the Greeter to transfer you. If the browser blocks audio autoplay, select **Enable audio**. Microphone access requires localhost or HTTPS. **Try sample call** opens the handoff form without starting a voice session.

Typed messages use the active voice session and currently require a working microphone. Denied/unavailable microphone access, or a connection timeout while waiting for the microphone, opens a recovery dialog. Allow access in browser/site and device settings, then use **Refresh and try again** or **I've enabled my microphone — reconnect**. Refreshing alone does not clear a saved permission denial. Use **Try sample call** to exercise the handoff without a microphone.

HTTP Basic authentication is on by default. The handoff API always requires the demo login. The framework-generated Workflow queue callback has its own authentication, so the Next.js proxy leaves that route to Workflow. User-facing API responses are private and uncached. Browsers remember Basic credentials. Use a private window for reviewer testing and close it after the demo. Rotating the password requires a new deployment. Older deployments retain their configuration and access settings.

## Voice models

| Agent | Model | Voice connection |
| --- | --- | --- |
| Greeter | `gpt-realtime-2.1-mini` | Direct OpenAI WebRTC |
| IRS | `elevenlabs/eleven-realtime-v1-max` | AI Gateway WebSocket |
| VA | `google/gemini-3.8-live` | AI Gateway WebSocket |
| Medicare | `spacexai/grok-voice-3.0` | AI Gateway WebSocket |
| BioGuide | `openai/gpt-realtime-2.1` | AI Gateway WebSocket |

The server selects the model and issues a short-lived session credential. The browser connects to the selected service with that credential. Push-to-talk uses the direct OpenAI path. Gateway specialists detect when the speaker finishes. The Elastic specialist also uses the direct OpenAI path.

The transcript stays visible during a specialist transfer. When the voice route changes, FedFlow starts a new session with the caller’s question and relevant conversation context. The outgoing agent announces an obvious transfer without asking for routing approval. The receiving specialist introduces itself, summarizes the question, and asks for confirmation before retrieving an answer. Its introductory response disables tool calls for that turn only. After confirmation or correction, it searches using the resolved question and context. Generated wording can vary.

## Assessment walkthrough

1. With BioGuide selected, ask “What congressional offices did John Quincy Adams hold, and when?”
2. Select **Draft handoff** and review the excerpt. Submit only demo material. Without a microphone, use **Try sample call** to supply a synthetic excerpt while using the same live search and model.
3. Open the sources in the completed draft and check the suggested next step against them. To test recovery, refresh while the draft is pending. The signed receipt in this browser tab restores the same Workflow run.

The browser submits the approved excerpt to the handoff workflow. Vercel Workflows checkpoints the post-call retrieval and generation steps. The AI SDK uses GPT-5 mini through AI Gateway and the application resolves citations to official Biographical Directory profiles from the existing `person` index. The live audio session is separate and ends when the page reloads. Drafts require human review before being used in a research brief.

See [assessment notes](docs/assessment.md) for architecture, evaluation, rollout, and the reviewer script.

## Vercel features in this demo

| Feature | Where it is used |
| --- | --- |
| AI SDK | Structured handoff generation and model usage data in `src/app/workflows/support-handoff.ts` |
| AI Gateway | Live WebSocket sessions for IRS, VA, Medicare, and BioGuide, plus the `openai/gpt-5-mini` handoff draft |
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
curl --user demo --fail-with-body 'http://localhost:3000/api/bioguide?q=John%20Quincy%20Adams'
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

1. Open the app, confirm the Greeter is selected, and select **Connect**. Check for **Live conversation**.
2. Select BioGuide and ask the question above. Confirm retrieval returns the correct member, an official congressional profile link, and a spoken answer.
3. Type a follow-up and confirm the transcript and audio complete.
4. Ask to switch to VA or another agent, then ask a relevant question. Check the answer and source links.
5. Interrupt an answer; exercise push-to-talk and audio playback controls.
6. Disconnect and reconnect. Confirm microphone capture stops after disconnect and no repeated automatic retries occur on errors.
7. Use **Try sample call**, generate a handoff, refresh while pending, and verify the recovered result and its citations.

The conversation transcript includes messages and expandable tool details. The agent selector changes the active agent; the event panel helps diagnose requests and responses. Keep diagnostic panels closed for the recording when they are not needed.

## Vercel deployment

Set the required environment variables on the intended Vercel project and environment. Preview and Production settings are separate. `NEXT_PUBLIC_*` settings are included at build time, so updating them requires a new deployment.

The assessment preview exports OpenTelemetry over HTTP/protobuf to Elastic APM. Configure `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS`, `OTEL_SERVICE_NAME`, and `ENABLE_OTEL=true` for the assessment branch. `TELEMETRY_CAPTURE_FULL_CONTENT=true` includes sanitized transcript text on the exported spans. Use public or synthetic conversation material in the preview.

Build and test a preview before promoting it. Verify the project, deployment URL, Git commit, domain alias, and runtime behavior; Vercel **Ready** means the deployment built, not that OpenAI or Elasticsearch requests work. This README describes configuration and validation, not the current deployment or cluster-upgrade status.

## Extending the agents

Agent prompts, tool schemas, and tool implementations live in [`src/app/agentConfigs`](src/app/agentConfigs). Start with [`bioguideAgent.ts`](src/app/agentConfigs/semanticSearch/bioguideAgent.ts). Retrieval routes live under `src/app/api`; the shared search implementation is [`utility.ts`](src/app/api/utility.ts).

The browser connects to OpenAI Realtime or AI Gateway using a short-lived credential. Tool calls run through the matching Next.js retrieval route to Elasticsearch. The handoff flow is approved excerpt → Next.js route → Workflow → Elasticsearch retrieval → AI Gateway generation → reviewed draft.

## Core contributors

- Noah MacCallum — [noahmacca](https://x.com/noahmacca)
- Ilan Bigio — [ibigio](https://github.com/ibigio)
- Matt Carl — application adaptations and Elastic integrations

The responsive conversation shell fills the available viewport height. Conversation and diagnostics scroll independently; the message composer and connection controls remain visible. Logs use a side panel on wide screens and a dedicated view on narrow screens (toggle Logs off to return). Input autofocus is disabled so a phone keyboard only opens when requested.
