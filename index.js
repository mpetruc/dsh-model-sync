/**
 * dsh-model-sync — auto-populate the llm-pi-ai models list from the providers
 * themselves.
 *
 * For every configured llm-pi-ai provider (all of them by default, or only
 * the ones listed in `config.providers`) this plugin asks the llm service to
 * discover the provider's advertised models (`GET {baseURL}/models` for
 * OpenAI-compatible routes, the installed catalog for catalog routes) and
 * merges ids that are not yet configured into the provider's `models` array
 * in the llm-pi-ai settings section. The Settings → Models surface and any
 * model dropdown reading that section then show the provider's full model
 * list without hand-entry.
 *
 * Existing entries are kept untouched — ids, order, and any manually entered
 * capacities (contextWindow, maxTokens, input, reasoningEfforts, compat) are
 * preserved. Discovery metadata (name / contextWindow / maxTokens / input
 * modalities) is attached only to freshly added entries.
 *
 * @module dsh-model-sync
 */

/** Settings namespace read and written by this plugin. */
const SETTINGS_NS = 'llm-pi-ai'

/** Namespace whose registered model discovery serves drafts. */
const DISCOVERY_NS = 'llm-pi-ai'

/** Boot settle grace before the first sync. */
const FIRST_SYNC_DELAY_MS = 1500

/** Build the settings `models` entry for one discovered model. */
function toEntry(model) {
  const entry = { id: model.id }
  if (typeof model.name === 'string' && model.name.length > 0) entry.name = model.name
  if (typeof model.contextWindow === 'number') entry.contextWindow = model.contextWindow
  if (typeof model.maxTokens === 'number') entry.maxTokens = model.maxTokens
  // The pi-ai settings schema spells input modalities as `input`.
  if (Array.isArray(model.inputModalities) && model.inputModalities.length > 0) {
    entry.input = model.inputModalities
  }
  return entry
}

/**
 * Plugin body.
 * @param ctx - host context carrying llm / settings services.
 * @param config - composition entry (intervalMinutes, providers).
 */
export function apply(ctx, config = {}) {
  const intervalMinutes = Number(config.intervalMinutes ?? 0)
  const wanted = Array.isArray(config.providers) && config.providers.length > 0
    ? new Set(config.providers)
    : null
  let running = false

  const syncOnce = async () => {
    if (running) return
    running = true
    try {
      await syncProviders(ctx, wanted)
    } catch (error) {
      ctx.logger.warn('[dsh-model-sync] sync failed: %s',
        error instanceof Error ? error.message : String(error))
    } finally {
      running = false
    }
  }

  // Run once services are up; the settings section is fully composed by then.
  ctx.inject(['llm', 'settings'], (sctx) => {
    const first = sctx.effect(() => {
      const timer = setTimeout(() => { void syncOnce() }, FIRST_SYNC_DELAY_MS)
      return () => clearTimeout(timer)
    })
    const repeat = intervalMinutes > 0
      ? sctx.effect(() => {
        const timer = setInterval(() => { void syncOnce() }, intervalMinutes * 60_000)
        return () => clearInterval(timer)
      })
      : undefined
    return () => { first(); if (repeat) repeat() }
  })
}

/**
 * One discovery-and-merge pass. Reads the whole llm-pi-ai section, merges
 * freshly discovered ids into each selected provider's models list, and
 * writes the section back only when something changed.
 * @param ctx - host context carrying llm / settings services.
 * @param wanted - provider name filter, or null for every provider.
 */
async function syncProviders(ctx, wanted) {
  const llm = ctx.get('llm')
  const settings = ctx.get('settings')
  const section = settings.get(SETTINGS_NS)
  if (typeof section !== 'object' || section === null
    || typeof section.providers !== 'object' || section.providers === null) {
    ctx.logger.info('[dsh-model-sync] no llm-pi-ai providers configured; nothing to sync')
    return
  }
  const work = structuredClone(section)
  const notes = []
  for (const [name, profile] of Object.entries(section.providers)) {
    if (wanted !== null && !wanted.has(name)) continue
    if (typeof profile !== 'object' || profile === null) continue
    const baseURL = typeof profile.baseURL === 'string' && profile.baseURL.length > 0
      ? profile.baseURL
      : undefined
    if (baseURL === undefined) {
      notes.push(`${name}: no baseURL, skipped`)
      continue
    }
    const api = typeof profile.api === 'string' && profile.api.length > 0
      ? profile.api
      : 'openai-completions'
    let discovered
    try {
      discovered = await llm.discoverModels(DISCOVERY_NS, { provider: name, baseURL, api })
    } catch (error) {
      notes.push(`${name}: discovery failed (${error instanceof Error ? error.message : String(error)})`)
      continue
    }
    const existing = Array.isArray(profile.models)
      ? profile.models.filter(m => m !== null && typeof m === 'object' && typeof m.id === 'string')
      : []
    const existingIds = new Set(existing.map(model => model.id))
    const fresh = discovered.filter(model => !existingIds.has(model.id))
    if (fresh.length === 0) {
      notes.push(`${name}: up to date (${existing.length} models)`)
      continue
    }
    work.providers[name] = { ...profile, models: [...existing, ...fresh.map(toEntry)] }
    notes.push(`${name}: +${fresh.length} models (${existing.length} → ${existing.length + fresh.length})`)
  }
  if (notes.length > 0) ctx.logger.info('[dsh-model-sync] %s', notes.join('; '))
  if (work.providers !== section.providers) {
    await settings.replace(SETTINGS_NS, work)
  }
}
