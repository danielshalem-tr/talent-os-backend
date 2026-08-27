# Voice Screening — one-time ElevenLabs + Coolify setup

Prerequisites (Daniel): the ElevenLabs API key (ConvAI read/write) and the test phone numbers
for the allowlist. Everything else is inventoried below.

## 0. Workspace inventory (verified live 2026-08-27)

Talento shares Daniel's existing ElevenLabs workspace with the **Triolla Scheduler**, which is
in production. Read this before touching anything:

| Thing | Value | Notes |
|---|---|---|
| Agent to duplicate | `agent_9701kv8qz65ne4v8zy671hhsjqzx` ("Triolla Scheduler") | Leave untouched |
| Israeli number | `phnum_6501kxam4mawe719zdtznxys5a9n` — `+972 3 382 5583` ("Telnyx IL") | `provider: sip_trunk`, `sip.telnyx.com`/TCP, outbound OK ⇒ `ELEVENLABS_TELEPHONY=sip` |
| US test number | `phnum_1401kx2z1ck4ejea2gk05tqwarxk` — `+1 948 259 4079` ("Telnyx US (test)") | also `sip_trunk` |
| Spare Twilio number | `phnum_8101kwhc4aphfs88gke4farjrk86` — `+1 941 239 7717` | `provider: twilio`, **unassigned**. Only number that would need `ELEVENLABS_TELEPHONY=twilio` |
| Workspace post-call webhook | `879db0ce372049ea88a8f07babbdb70e` → `https://scheduler.triolla.io/api/elevenlabs/webhook` | ⚠️ **LIVE SCHEDULER — never repoint this.** See step 2b |
| Workspace `send_audio` | `false` | Correct as-is; talento pulls audio from the API (D2) |

⚠️ **Both Telnyx numbers are currently `assigned_agent: Triolla Scheduler`.** That assignment
governs *inbound* routing; outbound passes `agentId` + `agentPhoneNumberId` explicitly per call,
so the Talento agent dialing out from the shared IL number is expected to work. The first
test-mode call (step 5) is what proves it. If ElevenLabs rejects the pairing, import a second
Israeli DID at Telnyx for talento rather than reassigning the Scheduler's number.

Note the duplicated agent inherits an **empty** `data_collection` / `evaluation` config (the
Scheduler agent has none) — step 2's analysis setup is therefore required, not optional.

## 1. Duplicate the working agent → "Talento Screening"

```bash
curl -s -X POST "https://api.elevenlabs.io/v1/convai/agents/agent_9701kv8qz65ne4v8zy671hhsjqzx/duplicate" \
  -H "xi-api-key: $ELEVENLABS_API_KEY" -H "Content-Type: application/json" \
  -d '{"name": "Talento Screening"}'
```

The response's `agent_id` is `ELEVENLABS_AGENT_ID`. The original agent is untouched.

## 2. Configure the new agent (ElevenLabs dashboard → Talento Screening)

**System prompt** (Agent tab) — paste:

```
You are {{company_name}}'s friendly AI recruiting assistant conducting a short phone
screening with {{candidate_name}} about the {{job_title}} position.

Rules:
- Confirm you are speaking with {{candidate_name}} and say the call takes about 5 minutes.
- Ask the following screening questions IN ORDER, ONE AT A TIME, waiting for a complete
  answer before moving on:
{{questions}}
- If asked something you don't know, say the recruiting team will follow up.
- If the candidate asks to be called back another time, apologize, note the request, end the call.
- Close by thanking them and saying the team will be in touch.
Keep every turn short and conversational.
```

**First message:**

```
Hi, is this {{candidate_name}}? I'm calling from {{company_name}} about the {{job_title}}
position you applied for — do you have five minutes for a few quick questions?
```

**Conversation behavior (Agent → Behavior / Advanced)** — production-tuned values carried
over from the Scheduler's working agent (`~/Triolla/Scheduler/config/elevenlabs-agent.md`);
the defaults are far too aggressive and make the agent talk over people:

| Setting | Value | Why |
|---|---|---|
| First message | must be SET (above) | empty ⇒ the LLM improvises a new greeting every call, inconsistent and over-casual |
| `turnTimeout` | `5` | seconds of silence before the agent re-engages; low values interrupt the caller (worst in Hebrew) |
| `turnEagerness` | `normal` | `patient` overcorrects into ~13s of dead air after short answers |
| `disableFirstMessageInterruptions` | `true` | stops a "hello?" from cutting off the opening line |

If the agent is configured to speak **Hebrew**: reuse the Scheduler's gendered-speech rules
(second-person "-ך" words are pronounced masculine by the TTS even with niqqud — rephrase
neutrally; gendered verbs need dual-form examples driven by a gender dynamic variable).
Talento does not store candidate gender in v1, so prefer gender-neutral phrasing throughout.

**Analysis → Data collection** (agent-level; per-call schemas are not supported):
- `answers` (String): "For each numbered question the agent asked (from the questions list),
  record the candidate's answer as '<number>. <answer>' on its own line."
- `callback_requested` (Boolean): "true if the candidate asked to be called back another time."
- `salary_expectation` (String): "the candidate's salary expectation if mentioned, else empty."

**Analysis → Evaluation criteria:**
- `call_completed`: "success if every screening question was asked and answered."

## 2b. Post-call webhook — NEW webhook + per-agent override (do NOT touch the workspace one)

⚠️ The workspace-level ConvAI post-call webhook currently delivers to
`https://scheduler.triolla.io/api/elevenlabs/webhook`. **Changing it would break the live
Scheduler** — its calls would never finalize and would strand at `FAILED`/`timeout`.

Instead, in the ElevenLabs dashboard (**Settings → Webhooks**) create a **new** webhook:
- URL `https://<talento-api-domain>/api/webhooks/elevenlabs`
- Auth type **HMAC** → save the generated signing secret as talento's own
  `ELEVENLABS_WEBHOOK_SECRET` (a different secret from the Scheduler's — do not share one).
- Note its `webhook_id`.

Then bind it to the Talento agent only (**Agent → Analysis/Webhook settings**, the per-agent
"override workspace webhook" control), or via the API:

```bash
curl -s -X PATCH "https://api.elevenlabs.io/v1/convai/agents/$TALENTO_AGENT_ID" \
  -H "xi-api-key: $ELEVENLABS_API_KEY" -H "Content-Type: application/json" \
  -d '{"platform_settings":{"workspace_overrides":{"webhooks":{
        "post_call_webhook_id":"<NEW_WEBHOOK_ID>",
        "events":["transcript"],"transcript_format":"json","send_audio":false}}}}'
```

Verify afterwards that the Talento agent reports the new id and the **Scheduler agent still
reports `post_call_webhook_id: null`** (inheriting the workspace default):

```bash
for A in "$TALENTO_AGENT_ID" agent_9701kv8qz65ne4v8zy671hhsjqzx; do
  curl -s "https://api.elevenlabs.io/v1/convai/agents/$A" -H "xi-api-key: $ELEVENLABS_API_KEY" \
    | python3 -c "import json,sys;d=json.load(sys.stdin);print(d['name'],'->',d['platform_settings']['workspace_overrides']['webhooks']['post_call_webhook_id'])"
done
```

**Leave "Send audio data" OFF** (already the workspace default) — the worker pulls audio from
the API instead (D2).

## 3. Phone number id + telephony type

Already inventoried in step 0 — for Israeli candidates use the Telnyx IL number:

```bash
ELEVENLABS_AGENT_PHONE_NUMBER_ID=phnum_6501kxam4mawe719zdtznxys5a9n   # +972 3 382 5583
ELEVENLABS_TELEPHONY=sip                                              # provider: sip_trunk (Telnyx)
```

To re-verify or pick a different number:

```bash
curl -s "https://api.elevenlabs.io/v1/convai/phone-numbers" -H "xi-api-key: $ELEVENLABS_API_KEY"
```

Set `ELEVENLABS_TELEPHONY` to match the chosen number's `provider` field: `sip_trunk` → `sip`,
`twilio` → `twilio`. A mismatch fails at dial time with a provider error — it cannot mis-dial,
only error out. To provision a fresh Israeli DID instead of sharing the Scheduler's, add it at
Telnyx and import it into ElevenLabs as a SIP-trunk number (`sip.telnyx.com`, TCP).

## 4. Coolify (production)

1. Env vars on **talent-os-api**: all seven (`ELEVENLABS_API_KEY`, `ELEVENLABS_AGENT_ID`,
   `ELEVENLABS_AGENT_PHONE_NUMBER_ID`, `ELEVENLABS_WEBHOOK_SECRET`, `ELEVENLABS_TELEPHONY`,
   `VOICE_CALL_MODE=test`, `VOICE_CALL_ALLOWLIST=<Daniel's numbers>`).
2. Env vars on **talent-os-worker**: the same minus `ELEVENLABS_WEBHOOK_SECRET`.
   ⚠️ Coolify is plain HTTP — set secrets accordingly (known limitation).
3. **watch_paths**: talent-os-api deploys on every push (watch_paths cleared 2026-08-27).
   talent-os-worker is still per-module — ADD `src/voice/**` to its watch_paths (and verify
   `src/config/**` + `prisma/**` are covered), or the worker will silently skip deploys that
   only touch the voice module.
4. Deploy backend (API runs the migration on boot; the worker's migration gate waits for it),
   then the client.

## 5. Test-mode validation (production is the only environment)

1. Confirm `GET /api/voice-control/status` shows `"mode": "test"`, `"configured": true`,
   and the right `allowlist_size`.
2. AI Agents page → enable the Voice Screening Agent (tenant switch).
3. Pick one job → Screening tab → enable "Voice screening call" (threshold 70).
4. Send a test CV whose phone is in the allowlist → expect a real call to that number in the
   business window, then summary/Q&A/transcript/audio on the candidate page. **This first call
   also proves the two open workspace questions:** (a) the Talento agent can dial out from the
   IL number that is `assigned_agent: Triolla Scheduler` — a provider/permission error here
   means importing a second Telnyx DID for talento; (b) the per-agent webhook override
   delivers to talento (if the transcript never arrives but the watchdog finalizes the row
   ~30 min later, the override didn't take — recheck step 2b).
5. Real candidates arriving meanwhile produce `blocked` rows only — verify one on a candidate
   page ("Call blocked (test mode)").
5b. **Regression-check the Scheduler**: place one Scheduler call and confirm it still finalizes
   (status leaves `IN_PROGRESS`) — proof the workspace webhook was left intact.
6. Only after sign-off: flip `VOICE_CALL_MODE=live` in Coolify (both apps), restart, and
   enable the toggle on one pilot job. Monitor the first live calls (cost + quality).
