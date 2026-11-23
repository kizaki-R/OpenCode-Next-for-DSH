# OpenCode-Next (`opencode-next`)

English | [繁體中文](./README.zh-TW.md)

Native OpenCode OAuth & OpenCode Go Provider for DeepSeek Harness (DSH).

> Derived from [FishBottle7/opencode2dsh](https://github.com/FishBottle7/opencode2dsh). Internal package/provider identifiers (`opencode-next`, `opencode-next`, `opencode-go-subscription`) are preserved for configuration and account compatibility.

Connects directly to the official OpenCode `/inference/openai/v1` endpoint using personal OAuth tokens, eliminating 403 `FreeTierError` and harsh single-IP 429 rate limits.

## Highlights
- **Dual-Track OAuth**: Automatically inherits logged-in OAuth tokens from local OpenCode Desktop (`~/.local/share/opencode/opencode.db`), or standalone browser login via `opencode-next-login` (RFC 8628 Device Authorization Flow).
- **Official Authenticated Endpoint**: Uses `https://opencode.ai/inference/openai/v1/chat/completions`.
- **Full Reasoning Stream**: Translates `reasoning_content` deltas directly to DSH `reasoning-delta` chunks in real time.
- **Full Tool Calling**: Seamless support for DSH agentic tools (read, write, edit, pwsh, etc.).
- **Live Catalog Sync**: Discovers models directly from `models.opencode.ai`.
- **Resilient Availability Detection**: New free models appear only after a successful probe; existing models are hidden after two consecutive model-specific failures, while confirmed 404/410 retirements disappear immediately and successful probes restore models automatically.
- **Settings Page**: A dedicated **OpenCode-Next** section in DSH Settings split into four tabs (**Account**, **Free Models**, **Advanced**, and **OpenCode Go**) to sign in/out, curate which free or Go models appear in the DSH picker, and inspect quota & probe status.
- **Official v2 Protocol Alignment & Bun Transport**: Native Bun transport with automatic environment detection (`bun.exe`), upstream header alignment (`x-opencode-org-id`, workspace SHA1 hash, `max_completion_tokens`), and transparent bidirectional tool name aliasing to eliminate 429 pseudo-rate-limiting while fully preserving all DSH agent tools.

## Automatic Model Detection

The public catalog lists far more free models than the free lane actually
serves: some entries stay behind with `status: "deprecated"` yet still answer,
while others look active and return `Model is unavailable`. The public catalog
is therefore treated as a candidate list, separate from picker availability.
New candidates are published only after a successful probe. An existing model
stays in the picker through one recoverable model-specific failure and is hidden
on the second consecutive failure; a successful probe restores it immediately
and clears its streak. Explicit 404 `not-found` and 410 `deprecated` responses
hide a model immediately. A generic 400 `unavailable` marker is not treated as
proof of retirement and follows the two-failure rule.

Two cadences run in the background:

| Job | Default interval | What it does |
| --- | --- | --- |
| Catalog poll | 15 min | Re-fetches the catalog and probes only newly listed free models |
| Full re-verification | 6 h | Re-probes every candidate so retired models drop out |

Results, the published picker set, and consecutive-failure counters persist to
`~/.dsh/opencode-next.models.json` and are reused on restart. Existing v1 cache
files remain readable; newly written cache files include the durable failure
state so restarting does not reset hysteresis. Stale results still trigger a
full re-verification, without discarding the last known picker state first.

A probe opens a real streaming request and cancels it the moment the status
line arrives: a healthy model costs ~1–2 s and a dead one ~0.3–1 s, with
bounded concurrency. If the lane itself is blocked or a sweep is incomplete,
no partial model verdicts are committed: availability and failure counters stay
unchanged. A per-model 403 `RegionError` is treated as a model-specific failure,
not a blocked lane.

### A run stops early, and says where

The free lane has a small daily quota, so a probe bails out immediately in two
cases:

| Case | Why it stops |
| --- | --- |
| Any model returns `429` (rate limit / quota spent) | Sending 40 more requests would burn the rest of the day's quota |
| The lane is unreachable (`403` abuse block, `401`, `5xx`, `402`) | Every remaining request would return the same error |

Models that were not probed **keep their previous verdict**; they are never
marked as failed. The settings page shows "this run stopped after N of M" with
the reason, and that state is written to the cache so it survives a restart. A
complete run clears the marker.

So "13 available but only 4 probe rows" is not data loss — the fourth model hit
a rate limit and the run stopped there. Re-probe after the quota window resets,
or use the models already known to work.

### When the quota comes back

A 429 carries a `retry-after` header (measured: `5397`, about 90 minutes). The
plugin reads it and converts it to local time:

```
Free quota resets 08:18 (in 1 hour 27 minutes).
```

When upstream omits the header, no time is shown at all — it does not guess.
That matters: a guessed "about five minutes" makes you hit the same wall every
five minutes.

### Context window and output limits

Capacity comes from the upstream catalog and varies a lot:

| Model | Context | Max output |
| --- | --- | --- |
| `deepseek-v4.1-flash-free` | 200000 | 32000 |
| `beam-free` | 1048576 | 131072 |
| `minimax-m3.1-flash-free` | 1000000 | 512000 |
| `trinity-large-preview-free` | 131072 | 131072 |

The settings page lets you override one model's context window (click the
number in the Context column). The accepted range is `1024`–`100000000`,
deliberately wide: the real limit lives upstream, and a narrow hard-coded cap
would look like a validation bug. Exceeding the upstream limit returns
`400 context-overflow`, which is reported as "shorten the message or compact",
never as a retired model.

An override only changes DSH's budget calculation; it does not raise the
upstream limit.

### Configuration

```jsonc
{
  "autoDetectModels": true,        // set false to pin the static list
  "catalogPollMs": 900000,         // 15 min; 0 disables new-model polling
  "probeIntervalMs": 21600000,     // 6 h full re-verification
  "probeCachePath": "",            // default ~/.dsh/opencode-next.models.json
  "streamIdleTimeoutMs": 60000,    // fail a silent stream so the runtime can retry
  "imagePixelBudget": 640000,      // 800x800; images above this are downscaled
  "imageMaxBytes": 2097152         // 2 MiB per projected image
}
```

`streamIdleTimeoutMs` covers the case where the free lane answers `200` and then
goes quiet: the connection stays open but no frame ever arrives. Without it the
turn hangs until TCP times out and the runtime sees no error it can retry. The
watchdog aborts the underlying fetch and raises `TIMEOUT`, which is in
`SAFE_RETRY_POLICY.retryableCodes`. Waiting for the *first* frame uses the
shorter of `DEFAULT_FIRST_EVENT_MS` and this value.

`imagePixelBudget` and `imageMaxBytes` bound the projection handed to the
attachment service. They are deliberately fixed rather than adaptive: the
request-variant id is a hash of the attachment plus this target, so a target
that drifts between calls would invalidate the cache on every turn.

Effort values are taken verbatim from the catalog instead of being guessed:
upstream rejects unsupported values with `400 [unsupported_value]`, and the
accepted set differs per model (for example `beam-free` accepts `low` through
`max` but not `minimal`, while `deepseek-v4.1-flash-free` accepts only `low`,
`high`, and `max`). The catalog spells "no reasoning" as `none`; DSH spells it
`off`, and the adapter maps it back on the wire.

## Settings Page (DSH Settings → OpenCode OAuth)

DSH Settings gains an "OpenCode OAuth" tab (order 14) with four blocks:

| Block | Contents |
| --- | --- |
| Header | Health badge (ready / expiring / unprobed / signed out / expired / no model responding) plus a one-line conclusion |
| Authorization | Credential source, expiry, whether it auto-refreshes; buttons for re-verify, sign in (or sign in again), and sign out |
| Models | Available vs. total, last probe time, search, an "only problems" filter, per-model status / latency / explanation, and a context-window setting for each model |
| Diagnostics | Provider id, plugin version, probe interval, catalog poll, image pixel budget and byte cap |

Expand a model's **Context window** setting to follow the OpenCode catalog value or enter a manual override. **Restore default** removes that model's override; it does not send a probe request. A manual value changes the capacity and budget DSH receives, but does not raise OpenCode's actual limit or change DSH's compaction policy. Only model IDs and numeric values are stored in `~/.dsh/opencode-next.context.json` (or under `DSH_HOME` when set).

After starting a sign-in the tab shows the device code and verification URL, and
polls every 2 s until authorization completes (15 s otherwise).

### Secrets never leave the host

The page reports **whether** a credential exists and **when** it expires, but
never sends an access or refresh token to the browser, and the page never
accepts a secret as input. This is deliberate: the tab runs in a browser, so a
token placed there is readable by any script on the page.

### Why health messages are translated client-side

The host's `status.js` builds a fixed Chinese sentence. Rendering it verbatim
made the English page bilingual, so the page now resolves that sentence from its
own dictionary by the stable `health` code and falls back to the host string
only for a code it does not recognize. `test/render.test.mjs` asserts the
English page contains no Chinese characters, so this cannot regress silently.

### Two concurrent sign-ins request only one device code

There is an `await` between "is a sign-in already pending?", "ask upstream for a
device code", and "record it as pending". Without a guard, two nearly simultaneous
requests both saw no pending sign-in, each requested its own device code, and the
second overwrote the first. A user could approve the code shown on screen while
the plugin was now tracking a different one, so the sign-in appeared to finish
but left no credential. The symptom is hard to reproduce — it looks like "sign-in
sometimes needs two attempts" — so `lib/web-api.js` keeps a `deviceCodeRequest`
promise and makes a concurrent second request share that code instead of asking
for another.

A `loginGeneration` counter covers the other ordering: if the user signs out
while a request is still awaiting, that request no longer records itself as
pending and does not return a verification URL (the page would otherwise open a
sign-in page for a code that is already dead). `test/race.test.mjs` pins these
behaviours, and `test/race-mutation.test.mjs` removes the guards and confirms the
checks actually fail — a test that is always green may be testing nothing.

## Failure Classification

Upstream failures are classified in `lib/failures.js` and attached to the thrown
error as a `.failure` snapshot, because that is the only thing the runtime reads.

A third-party adapter **must** attach `.failure` whose `failure.code` matches the
error's own `code`. `normalizeLlmFailure` returns the carried snapshot only when
the two agree; otherwise it rebuilds one from `harnessErrorCode(error)`, which
answers `UNKNOWN` for anything that is not a `HarnessError`. A plain `Error`
with a hand-assigned `.code` is therefore always flattened to `UNKNOWN` — which
silently defeated the documented retry behaviour, since the watchdog's `TIMEOUT`
never matched `SAFE_RETRY_POLICY.retryableCodes`.

Two other defects in the same path were fixed alongside it:

- `403` was not triaged. The body's `error.type` now distinguishes
  `FreeTierError` (the free lane refuses the request) from `RegionError` (this
  model is unavailable from here), so the two produce different explanations
  instead of one generic auth failure.
- The fallback code was `UPSTREAM`, which is not in DSH's failure-code family.
  Routing is by `HarnessError.code`, so an unrecognized code cannot be matched
  by any retry policy; unmapped 4xx responses now report `TRANSPORT` with an
  `http-<status>` reason, which retries nothing and loses no information.

## Quick Start

### Install via DSH CLI

```bash
# From npm (once published)
dsh plugin --profile desktop add opencode-next

# Or directly from GitHub
dsh plugin --profile desktop add github:kizaki-R/OpenCode-Next-for-DSH
```

*(For Web/Headless profiles, replace `--profile desktop` with `--profile web`.)*

### Installing from a local tarball

```bash
npm pack
dsh plugin --profile desktop add ./opencode-next-1.0.0.tgz
```

> **Re-pack after changing the source.** `npm pack` only includes files matched
> by the `files` allowlist in `package.json`, so after adding a file (for example
> `lib/ui.js` or `lib/failures.js`) an un-repacked tarball ships the old code to
> other machines — with no error, only a missing settings tab or a failure
> classification that does nothing.
>
> To verify: `test/package.test.mjs` (part of `npm test`) unpacks the tarball in
> the package root and hashes every shipped file against the current source,
> failing with the exact file names when they diverge. That is far more reliable
> than discovering the gap on another machine.

A `link:` dependency entry embeds an absolute path from the machine that wrote
it; on another computer it resolves to a directory that does not exist. Use that
machine's own path, or install the tgz.

### Checks

```bash
# Smoke test
npm run smoke

# Run full integration test suite
# (auth, catalog, probe, config resolution, failure classification, plugin entry
#  point, settings page, rendering, concurrency races, content conversion,
#  watchdog, streaming, tool calls, package integrity)
npm test
```

### Package integrity

`test/package.test.mjs` checks the artifact, not the source tree. The distinction
comes from a real slip: the code was finished, the suite was green, and the live
endpoints verified — but the packed tgz was two hours old and missing four files
added that day. Installing it on another machine produces **no error at all**;
it just has no settings tab and a failure classifier that does nothing.

That happens because `npm pack` only includes files matched by the `files`
allowlist, while a development machine gets its code through a junction, so
**this machine runs the live source and every other machine runs the tarball**.
The test hashes every `lib/*.js` against the tarball in the package root and
fails when they diverge, and it also verifies that `exports["./client"]` and
`dsh.client` point at files that actually ship, and that no shipped source
hardcodes a disk path.

`test/config-layers.test.mjs` covers the three fallback layers that
`lib/config.js` uses to obtain `schemastery`. None of them raise an error, so a
break is quiet: the plugin still loads and the defaults are still right, only
field-level validation (`min`/`max`) silently disappears. The test tells a real
validator from the built-in stub by checking whether an out-of-range value is
rejected, and confirms the second layer derives the profile directory from
`DSH_HOME` / `DSH_PROFILE_DIR` instead of embedding a developer's username in a
shipped file.

## Free quota follows the exit IP

`Free usage limit reached` is counted mainly by network exit IP, and by workspace or organization. A new account, a new device, or a refreshed token on the same exit does not clear a spent quota. Wait for the rolling window, or use another network you control. Switching accounts is not a bypass.

A fake 429 with a `retry-after` of about 48,000 seconds is a different failure. Bun transport and the official request shape address that one. They do not raise the real free-tier quota.

## Bun

The free lane rejects requests sent by Node.js. This plugin uses a Bun installed on the system; the OpenCode app does not ship a `bun` executable.

1. Install Bun from [bun.sh](https://bun.sh).
2. Open DSH Settings → OpenCode OAuth → Advanced.
3. If it still says Bun is missing, press Rescan. No DSH restart is required.

Detection only accepts an absolute path found on `PATH`, so a same-named binary in the working directory cannot be executed by accident.

## Scoped probes

The probe button follows the current filter:

| View | Button | What is probed |
| --- | --- | --- |
| All, no search | Re-probe | The candidate list |
| Available | Probe available (n) | Only the models on screen |
| Any other filter or search | Probe list (n) | Same, via the visible `modelIds` |

Results merge. Models not in this run keep their latency, availability, and history in `~/.dsh/opencode-next.models.json`. Switching accounts or restarting DSH does not delete that cache. The filter (for example staying on Available) is remembered in this browser's `localStorage`.

To change a context window, click the number in the Context column (for example `200k`). That opens its own dialog; the row does not expand.

## Import from OpenCode Desktop

The account section has **Import from OpenCode Desktop**. It reads the Desktop sign-in and does not modify Desktop's database. Importing the same credential again does not create a duplicate; it switches to the existing account. An API-key-only local login is rejected, because the free lane does not accept API keys.

`opencode-next-login` writes both `~/.dsh/opencode-next.token.json` and `~/.dsh/opencode-next.accounts.json`. If an account list already exists, DSH prefers it, so a CLI login that only updated the legacy file would not take effect. An identical access token is not added twice; that account becomes active. Each OAuth HTTP call times out after 15 seconds. A denied approval, an expired code, or a timed-out wait is reported; it is not swallowed.

## Anonymous channel

The Advanced switch is off by default. When on, inference is sent without the personal token, on a public anonymous lane OpenCode does not promise to keep. It can stop or be throttled at any time, and it is still subject to the exit IP. Turn it on only if that risk is acceptable.

## OpenCode Go (Subscription Verification, Model Preview & Text/Tool Inference)

An independent, opt-in `opencode-go-subscription` provider is included alongside `opencode-next` (`goSubscription.enabled` defaults to `false` so existing free OAuth behavior stays unchanged):

- **Isolated credential resolution & UI management**: Uses an OpenCode Console Personal API Key via DSH's `credentials` service first (`goSubscription.credentialRef`, default `OPENCODE_GO_API_KEY`), falling back to the environment variable. In Settings → OpenCode Go, you can save or clear the key directly via `ctx.credentials.set` / `ctx.credentials.unset` without exposing or prefilling plaintext keys (if `credentials.set` is unavailable in the current DSH process, the button stays disabled and the key is never written into plugin config or JSON files). It never reuses OAuth tokens (`st_*`), `org_id`, or credentials from other plugins, and never stores plaintext keys in plugin config, status APIs, errors, or logs.
- **Read-only official endpoints**: Queries `GET https://opencode.ai/inference/go/v1/usage` to verify Go subscription entitlement, followed by `GET https://opencode.ai/inference/go/v1/models` for workspace model metadata (`redirect: 'manual'`, fixed `https://opencode.ai` origin). Key changes or disabling clears the isolated cache (`~/.dsh/opencode-go.cache.json`) and blocks stale in-flight writes.
- **Chat Completions text & tool calling**: Inference posts exclusively to `POST https://opencode.ai/inference/go/openai/v1/chat/completions` (`redirect: 'manual'`, `stream_options.include_usage`), requiring a real DSH `sessionId` for `x-opencode-session` (missing IDs are rejected without hashing or random UUIDs). It never uses CLI identity headers, Bun transport rewrites, tool aliases/baseline fake tools, auto-account switching, cross-provider fallback, or automatic retries of billed requests.
- **Startup auto-sync, usage gauges & custom Go picker**: Once a Personal API Key is saved, DSH automatically runs a read-only background refresh (`/usage` and `/models`) on startup (including delayed `credentials` service injection) without consuming inference quota. The OpenCode Go tab displays `5h Limit`, `7D Limit`, and `1M Limit` progress bars, a collapsible `API Key` drawer, and per-model picker checkboxes (`~/.dsh/opencode-next.go-picker.json`).
- **Selective picker publishing & catalog-driven image input**: Only eligible active Go text/chat models enter DSH's formal model picker. Image input (`image_url` data URIs via DSH `attachments`) is automatically advertised and sent for eligible models whose upstream Go catalog declares `image` / `image/*` input modalities; models without declared image input stay text-only and reject image attachments before any request is sent (never silently dropping images or falling back to free OAuth). Video, audio, and other non-image attachments remain unsupported.

## License & Attribution

MIT License — see [LICENSE](./LICENSE). Derived from [FishBottle7/opencode2dsh](https://github.com/FishBottle7/opencode2dsh) (`Copyright (c) 2026 FishBottle7`).
