/**
 * dsh-cline-search — a Cline Pass web-search provider for the DeepSeek Harness.
 *
 * The built-in \`@deepseek-ai/dsh-web-search-deepseek\` speaks the Anthropic
 * Messages protocol (\`POST {baseURL}/messages\`), which the Cline Pass gateway
 * does not expose. This plugin registers a second provider on the web seam that
 * speaks the gateway's OpenAI-compatible protocol instead.
 *
 * Two gateway facts shape this implementation, both established by probing the
 * live endpoint rather than from documentation:
 *
 * 1. **Search is a tool type, and it is provider-specific.** The gateway forwards
 *    to Vercel, which rejects a bare \`{"type":"web_search"}\` with
 *    \`Invalid discriminator value ... param "tools.0.type"\`. The accepted search
 *    kinds are \`vercel:exa_search\`, \`vercel:parallel_search\`,
 *    \`vercel:perplexity_search\`, \`vercel:browserbase_search\` and
 *    \`vercel:tako_search\`. Many upstream models do accept \`web_search\` on their
 *    own route, so both families are attempted, Vercel first.
 *
 * 2. **Sources arrive as prose, not metadata.** Unlike the Anthropic provider,
 *    which reads structured \`url_citation\` annotations, this route returns no
 *    annotations at all. The model is therefore asked to end its answer with a
 *    machine-parseable \`SOURCES:\` block, and every URL in the body is kept as a
 *    fallback so a search never degrades to "no sources".
 *
 * The plugin imports nothing from \`@deepseek-ai/*\`: everything arrives through
 * \`ctx\`. That keeps it loadable from a profile with no peer-resolution graph.
 *
 * @module dsh-cline-search
 */

/** Stable Loader identity. */
export const name = 'cline-search'

/** The web seam; the credential plane is read with \`ctx.get\` at search time. */
export const inject = ['web']

/** Credential name the gateway key is read from when no account declares one. */
const DEFAULT_API_KEY_ENV = 'CLINE_PASS_API_KEY'
/** Gateway default, matching the Cline Pass provider. */
const DEFAULT_BASE_URL = 'https://api.cline.bot/api/v1'

/**
 * Search tool kinds attempted, in order, for each model.
 *
 * \`vercel:exa_search\` is first because it is what the subscription model used
 * here actually accepts; \`web_search\` is last because only some upstream routes
 * understand it and the gateway rejects it outright for the Vercel pipeline.
 */
const SEARCH_TOOL_TYPES = ['vercel:exa_search', 'vercel:parallel_search', 'web_search']

/**
 * Models tried, most preferred first.
 *
 * These are subscription ids (\`cline-pass/*\`), served from the account's Cline
 * Pass subscription. An upstream id such as \`deepseek/deepseek-v4.1-flash\` is
 * billed against Cline Credits instead, so a subscription-only account fails on
 * it with \`insufficient_credits\`.
 */
const FALLBACK_MODELS = ['cline-pass/deepseek-v4.1-flash']

/** The model tried first. */
const DEFAULT_MODEL = FALLBACK_MODELS[0]

/**
 * Provider id. Registered alongside the shipped DeepSeek provider, so a
 * deployment selects one explicitly through the \`web\` row's \`searchProvider\`.
 */
export const PROVIDER_ID = 'cline-pass'

/** The instruction that makes the answer's source list parseable. */
const SOURCE_INSTRUCTION =
  'Search the web and answer the question concisely and factually. ' +
  'Then end your reply with a line containing exactly "SOURCES:" followed by one ' +
  'line per page you actually used, each formatted as "- <url> | <title>". ' +
  'Never omit the SOURCES section, and list only pages you really retrieved.'

/** Strip a trailing slash so paths append literally. */
function trimBase(baseURL) {
  return String(baseURL ?? '').trim().replace(/\/+$/, '')
}

/** Combine a caller signal with a timeout signal. */
function withTimeout(signal, timeoutMs) {
  const signals = []
  if (Number.isFinite(timeoutMs) && timeoutMs > 0) signals.push(AbortSignal.timeout(timeoutMs))
  if (signal !== undefined && signal !== null) signals.push(signal)
  if (signals.length === 0) return undefined
  return signals.length === 1 ? signals[0] : AbortSignal.any(signals)
}

/** Collapse whitespace and bound one text fragment. */
function clean(text, max = 400) {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}

/** HTTP success without depending on a global \`Response\` type. */
function responseOk(status) {
  return typeof status === 'number' && status >= 200 && status < 300
}

/**
 * Pull citeable sources out of an answer.
 *
 * Two passes: the explicit \`SOURCES:\` block when the model honored the format,
 * then every remaining URL in the body. Results are deduped by URL in first-seen
 * order, so a URL named in both passes appears once.
 *
 * @param content - the assistant's answer text.
 * @returns the parsed sources, and the answer with the source block removed.
 */
function parseSources(content) {
  const text = String(content ?? '')
  const marker = text.search(/^\s*SOURCES:\s*$/im)
  const answer = marker === -1 ? text : text.slice(0, marker)
  const block = marker === -1 ? '' : text.slice(marker)

  const seen = new Set()
  const sources = []
  const add = (url, title) => {
    const cleaned = String(url ?? '').replace(/[.,;:]+$/, '')
    if (cleaned.length === 0 || seen.has(cleaned)) return
    seen.add(cleaned)
    const label = clean(title, 200)
    sources.push({ url: cleaned, ...(label.length > 0 ? { title: label } : {}) })
  }

  // Pass 1: the explicit source block, one "- url | title" per line.
  for (const line of block.split(/\r?\n/)) {
    const entry = /^\s*[-*\u2022]?\s*(https?:\/\/\S+)\s*(?:\|\s*(.*))?$/.exec(line)
    if (entry !== null) add(entry[1], entry[2])
  }

  // Pass 2: any other URL in the answer, so a malformed block still yields sources.
  for (const match of answer.matchAll(/https?:\/\/[^\s)\]>"'`]+/g)) add(match[0], '')

  return { answer: answer.trim(), sources }
}

/**
 * Map one gateway response onto the seam's portable result shape.
 *
 * @param body - the parsed chat-completions response.
 * @returns the normalized result, or `undefined` when no answer was present.
 */
function mapGatewayResponse(body) {
  const message = body?.data?.choices?.[0]?.message
  if (message === undefined || message === null) return undefined
  const parsed = parseSources(message.content)
  const content = parsed.answer.length > 0 ? parsed.answer : undefined
  return { content, sources: parsed.sources, truncated: false }
}

/**
 * Render a gateway failure, naming the two causes that are configuration facts
 * rather than transient faults.
 *
 * @param body - the parsed error response, when one could be decoded.
 * @param status - the HTTP status.
 * @returns a one-line diagnostic.
 */
function describeGatewayError(body, status) {
  const raw = body?.error
  const code = raw !== null && typeof raw === 'object' ? raw.code : undefined
  const message = raw !== null && typeof raw === 'object' ? raw.message : typeof raw === 'string' ? raw : undefined
  if (code === 'insufficient_credits') {
    return (
      'insufficient Cline Credits - this model is billed as usage rather than served from the subscription; ' +
      'configure a cline-pass/* subscription model'
    )
  }
  if (typeof message === 'string' && message.length > 0) return clean(message, 200)
  return 'HTTP ' + String(status)
}

/** A local error carrying a seam-routable code without importing the seam's class. */
class SearchError extends Error {
  /**
   * @param message - human-readable cause.
   * @param code - the routable web error code.
   */
  constructor(message, code) {
    super(message)
    this.name = 'WebError'
    this.code = code
  }
}

/** One search-capable provider over the Cline Pass gateway. */
class ClineSearchProvider {
  id = PROVIDER_ID

  #resolveOptions

  /**
   * @param resolveOptions - thunk returning the current key, endpoint, model and limits.
   */
  constructor(resolveOptions) {
    this.#resolveOptions = resolveOptions
  }

  /**
   * Cheap local usability check: an endpoint that parses and a key that resolves.
   * Must not touch the network.
   */
  available() {
    const options = this.#resolveOptions()
    return options.resolveApiKey !== undefined && URL.canParse(options.baseURL)
  }

  /**
   * Run one search. For each candidate model the gateway's search tool kinds are
   * tried in order, and the first response that yields sources wins; a model that
   * answers without any source is treated as a failure so a silent no-search
   * response never reads as an empty result set.
   *
   * @param request - the query and optional result bound.
   * @param signal - optional cancellation signal.
   * @returns the normalized result.
   * @throws when no model and tool combination produced sources.
   */
  async search(request, signal) {
    const options = this.#resolveOptions()
    const apiKey = await options.resolveApiKey()
    if (typeof apiKey !== 'string' || apiKey.length === 0) {
      throw new SearchError(
        'Cline Pass search has no API key; configure the ' + options.apiKeyEnv + ' credential',
        'WEB_PROVIDER_ERROR',
      )
    }
    const url = trimBase(options.baseURL) + '/chat/completions'
    const notes = []
    for (const model of options.models) {
      for (const toolType of SEARCH_TOOL_TYPES) {
        let status = 0
        let body
        try {
          const response = await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: 'Bearer ' + apiKey },
            body: JSON.stringify({
              model,
              max_tokens: options.maxTokens,
              messages: [
                { role: 'system', content: SOURCE_INSTRUCTION },
                { role: 'user', content: request.query },
              ],
              tools: [{ type: toolType }],
            }),
            signal: withTimeout(signal, options.timeoutMs),
          })
          status = response.status
          body = await response.json().catch(() => undefined)
        } catch (error) {
          if (signal?.aborted === true) throw new SearchError('the search was cancelled', 'WEB_ABORTED')
          notes.push(model + '/' + toolType + ': ' + clean(error?.message ?? error, 120))
          continue
        }
        const mapped = mapGatewayResponse(body)
        if (!responseOk(status) || mapped === undefined) {
          notes.push(model + '/' + toolType + ': ' + describeGatewayError(body, status))
          continue
        }
        if (mapped.sources.length === 0) {
          notes.push(model + '/' + toolType + ': no sources found in the answer')
          continue
        }
        if (request.maxResults !== undefined && mapped.sources.length > request.maxResults) {
          mapped.sources = mapped.sources.slice(0, request.maxResults)
        }
        return mapped
      }
    }
    throw new SearchError('Cline Pass search failed for every model and tool tried. ' + notes.join('; '), 'WEB_PROVIDER_ERROR')
  }
}

/**
 * Register the provider with the web seam.
 *
 * @param ctx - the plugin context; `ctx.web` is the seam.
 * @param config - the resolved plugin config.
 */
export function apply(ctx, config) {
  const configuredModels = Array.isArray(config?.models) && config.models.length > 0
    ? config.models.filter((m) => typeof m === 'string' && m.length > 0)
    : typeof config?.model === 'string' && config.model.length > 0
      ? [config.model, ...FALLBACK_MODELS.filter((m) => m !== config.model)]
      : FALLBACK_MODELS
  const resolved = {
    apiKeyEnv: typeof config?.apiKeyEnv === 'string' && config.apiKeyEnv.length > 0 ? config.apiKeyEnv : DEFAULT_API_KEY_ENV,
    baseURL: typeof config?.baseURL === 'string' && config.baseURL.length > 0 ? config.baseURL : DEFAULT_BASE_URL,
    models: configuredModels.length > 0 ? configuredModels : [DEFAULT_MODEL],
    maxTokens: Number.isFinite(config?.maxTokens) ? config.maxTokens : 2500,
    timeoutMs: Number.isFinite(config?.timeoutMs) ? config.timeoutMs : 150000,
  }
  const provider = new ClineSearchProvider(() => ({
    apiKeyEnv: resolved.apiKeyEnv,
    baseURL: resolved.baseURL,
    models: resolved.models,
    maxTokens: resolved.maxTokens,
    timeoutMs: resolved.timeoutMs,
    resolveApiKey: async () => {
      const credentials = ctx.get('credentials')
      if (credentials !== undefined) {
        try {
          const found = await credentials.resolve(resolved.apiKeyEnv)
          if (found?.value !== undefined && found.value.length > 0) return found.value
        } catch {
          /* fall through to the ambient plane */
        }
      }
      const ambient = process.env[resolved.apiKeyEnv]
      return typeof ambient === 'string' && ambient.length > 0 ? ambient : undefined
    },
  }))
  ctx.web.registerSearchProvider(provider)
  ctx.logger?.info('[cline-search] registered "%s" with models %s', PROVIDER_ID, resolved.models.join(', '))
}
