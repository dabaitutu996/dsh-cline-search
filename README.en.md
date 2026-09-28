# dsh-cline-search

[简体中文](./README.md) | **English**

A **Cline Pass** web-search provider for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`).

It makes the native `web_search` tool work on a Cline Pass subscription key, using the subscription quota instead of Cline Credits.

## The problem

dsh ships `@deepseek-ai/dsh-web-search-deepseek`, which speaks the **Anthropic Messages** protocol:

```
POST {baseURL}/messages     + tool: web_search_20250305
```

The Cline Pass gateway exposes only the **OpenAI-compatible** `POST {baseURL}/chat/completions`. Pointing the built-in provider at Cline Pass returns **404** — the route does not exist — so `web_search` cannot work at all.

## What this plugin does

It registers a second provider on the dsh web seam that speaks the gateway's own protocol and maps the answer back onto the seam's portable result shape.

```
ctx.web.registerSearchProvider({ id: 'cline-pass', available, search })
```

## Gateway quirks this handles

All three were established by probing the live endpoint, not from documentation.

### 1. Use a subscription model id

The model must come from the `cline-pass/*` namespace published by the gateway's recommended-models catalog. An upstream id such as `deepseek/deepseek-v4.1-flash` is billed against **Cline Credits** and fails on a subscription-only account with `insufficient_credits`.

```
GET https://api.cline.bot/api/v1/ai/cline/recommended-models
```

### 2. The search tool kind is provider-specific

The gateway forwards to **Vercel**, which rejects a bare `{"type":"web_search"}`:

```json
{
  "error": {
    "message": "Invalid discriminator value. Expected 'function' | 'custom' | 'vercel:browserbase_search' | 'vercel:exa_search' | 'vercel:parallel_search' | 'vercel:perplexity_search' | 'vercel:tako_search'",
    "param": "tools.0.type"
  }
}
```

This plugin tries `vercel:exa_search` first, then `vercel:parallel_search`, then `web_search`.

### 3. Sources come back as prose

Unlike the Anthropic route, this one returns **no structured `url_citation` annotations**. The provider therefore asks the model to end its answer with a machine-parseable `SOURCES:` block and parses it, falling back to scanning every URL in the body so a malformed block never yields an empty result.

```
SOURCES:
- https://github.com/deepseek-ai/deepseek-harness | DeepSeek Harness: Everything is a Plugin.
- https://www.deepseek.com/harness/en/ | DeepSeek Harness developer preview
```

## Performance note

Search is a **full model call that also performs retrieval**, so it takes roughly 8–25 seconds and consumes model tokens. It is not a cheap metadata lookup. Model choice matters: on the authors' account `cline-pass/deepseek-v4.1-flash` works well, while several other subscription ids currently fail upstream with HTTP 500.

## Requirements

- dsh (DeepSeek Harness)
- A Cline Pass API key in the `CLINE_PASS_API_KEY` credential

## Install

The plugin is **dependency-free** — it imports nothing from `@deepseek-ai/*` and reads everything through `ctx`. That is deliberate: a profile plugin's peer dependencies do not resolve from its own location, so a dependency-free plugin is the only shape that reliably loads.

1. Copy the package into your profile's `node_modules`:

```sh
cp -r dsh-cline-search "$DSH_HOME/profiles/web/node_modules/"
```

2. Add it to the profile bundle list in `$DSH_HOME/profiles/web/package.json`:

```json
{
  "dependencies": { "dsh-cline-search": "0.1.0" },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-cline-search"
      ]
    }
  }
}
```

3. Select it in `$DSH_HOME/profiles/web/cordis.patch.yml`:

```yaml
- id: web
  config:
    searchProvider: cline-pass
    fetchProvider: http
```

4. Restart dsh. The bundle and selection are read once at launch.

## Configuration

Override in the profile's `cordis.patch.yml`:

```yaml
- id: cline-search
  config:
    apiKeyEnv: CLINE_PASS_API_KEY
    baseURL: https://api.cline.bot/api/v1
    models:
      - cline-pass/deepseek-v4.1-flash
    maxTokens: 2500
    timeoutMs: 150000
```

| Key | Default | Meaning |
| --- | --- | --- |
| `apiKeyEnv` | `CLINE_PASS_API_KEY` | Credential reference resolved per search |
| `baseURL` | `https://api.cline.bot/api/v1` | Gateway base URL |
| `models` | `[cline-pass/deepseek-v4.1-flash]` | Subscription model ids, tried in order |
| `model` | — | Single-model shorthand; the rest of the defaults follow it |
| `maxTokens` | `2500` | Answer budget; too small truncates the `SOURCES:` block |
| `timeoutMs` | `150000` | Per-request timeout |

The API key is **never** stored in configuration. It is resolved through the dsh credential seam on every search, so rotating it needs no config change.

## Uninstall

Remove the bundle from `package.json`, or just drop the `- id: web` override in `cordis.patch.yml` to fall back to the shipped provider.

## Compatibility

Built and verified against dsh on the `web` profile. It registers only on the web seam (`inject: ['web']`) and touches no other service.

## License

MIT
