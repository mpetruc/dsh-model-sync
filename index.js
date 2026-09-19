/**
 * dsh-model-sync — mirror the llm-pi-ai providers' advertised model lists.
 *
 * For every configured llm-pi-ai provider (all of them by default, or only
 * the ones listed in `config.providers`) this plugin asks the llm service to
 * discover the provider's advertised models (`GET {baseURL}/models` for
 * OpenAI-compatible routes, the installed catalog for catalog routes) and
 * keeps the provider's `models` array in the llm-pi-ai settings section in
 * sync with that listing. The Settings → Models surface and any model
 * dropdown reading that section then show the provider's full model list
 * without hand-entry.
 *
 * Sync rules
 * - Adds: discovered ids that are not configured yet are appended (with
 *   name / contextWindow / maxTokens / input metadata when the listing
 *   reports them). Existing entries are never rewritten.
 * - Prune (config `prune: true`): ids the plugin previously auto-added and
 *   that are no longer advertised are removed. Hand-entered entries are
 *   never pruned.
 * - Rejected: when a tracked id that is still advertised disappears from
 *   the configured list, the plugin treats it as a deliberate deletion,
 *   records it, and does not re-add it. Manually re-adding a rejected id
 *   clears the rejection. Untracked (pre-existing) entries are always
 *   re-added while advertised.
 *
 * Provenance — which ids were auto-added — lives in the `model-sync`
 * settings namespace: `providers.<name>.added` / `.rejected`. Entries
 * configured before this version never had provenance and are treated as
 * hand-entered; deleting them and letting the plugin rebuild the list gives
 * every entry full tracking.
 *
 * @module dsh-model-sync
 */

import z from '@deepseek-ai/schemastery'

/** llm-pi-ai settings namespace read and written by this plugin. */
const SETTINGS_NS = 'llm-pi-ai'

/** Namespace whose registered model discovery serves drafts. */
const DISCOVERY_NS = 'llm-pi-ai'

/** Namespace holding auto-add provenance per provider. */
const PROVENANCE_NS = 'model-sync'

/** Provenance section schema: one entry per provider, ids only. */
const PROVENANCE_SCHEMA = z.object({
  providers: z.dict(z.object({
    added: z.array(z.string()).default([]),
    rejected: z.array(z.string()).default([]),
  })).default({}),
})

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
 * @param config - composition entry (intervalMinutes, prune, providers).
 */
export function apply(ctx, config = {}) {
  const intervalMinutes = Number(config.intervalMinutes ?? 0)
  const prune = config.prune === true
  const wanted = Array.isArray(config.providers) && config.providers.length > 0
    ? new Set(config.providers)
    : null
  let running = false

  const syncOnce = async (scope) => {
    if (running) return
    running = true
    try {
      await syncProviders(ctx, wanted, prune, scope)
    } catch (error) {
      ctx.logger.warn('[dsh-model-sync] sync failed: %s',
        error instanceof Error ? error.message : String(error))
    } finally {
      running = false
    }
  }

  // Run once services are up; the settings sections are fully composed then.
  ctx.inject(['llm', 'settings'], (sctx) => {
    const scope = sctx.settings.register(PROVENANCE_NS, PROVENANCE_SCHEMA)
    const run = () => syncOnce(scope)
    const first = sctx.effect(() => {
      const timer = setTimeout(run, FIRST_SYNC_DELAY_MS)
      return () => clearTimeout(timer)
    })
    const repeat = intervalMinutes > 0
      ? sctx.effect(() => {
        const timer = setInterval(run, intervalMinutes * 60_000)
        return () => clearInterval(timer)
      })
      : undefined
    return () => { first(); if (repeat) repeat() }
  })
}

/**
 * One discovery-and-sync pass: merge adds, optional prune, and rejection
 * bookkeeping for each selected provider. Namespaces are written only when
 * their section actually changed.
 * @param ctx - host context carrying llm / settings services.
 * @param wanted - provider name filter, or null for every provider.
 * @param prune - whether to remove auto-added ids no longer advertised.
 * @param scope - the model-sync provenance namespace scope.
 */
async function syncProviders(ctx, wanted, prune, scope) {
  const llm = ctx.get('llm')
  const settings = ctx.get('settings')
  const section = settings.get(SETTINGS_NS)
  if (typeof section !== 'object' || section === null
    || typeof section.providers !== 'object' || section.providers === null) {
    ctx.logger.info('[dsh-model-sync] no llm-pi-ai providers configured; nothing to sync')
    return
  }
  const work = structuredClone(section)
  const provenance = structuredClone(scope.get() ?? {})
  const providerState = typeof provenance.providers === 'object' && provenance.providers !== null
    ? provenance.providers
    : {}
  const notes = []
  let modelsChanged = false
  let provenanceChanged = false
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
    let existing = Array.isArray(profile.models)
      ? profile.models.filter(m => m !== null && typeof m === 'object' && typeof m.id === 'string')
      : []
    const existingIds = new Set(existing.map(model => model.id))
    const discoveredIds = new Set(discovered.map(model => model.id))
    const state = providerState[name] ?? { added: [], rejected: [] }
    let stateChanged = false

    // Track deliberate deletions: a tracked id that is still advertised but
    // no longer configured was removed by hand — remember not to re-add it.
    for (const id of state.added) {
      if (!existingIds.has(id) && discoveredIds.has(id) && !state.rejected.includes(id)) {
        state.rejected.push(id)
        stateChanged = true
      }
    }

    // Forget rejections the user manually re-added.
    const rejectionCount = state.rejected.length
    state.rejected = state.rejected.filter(id => existingIds.has(id))
    if (state.rejected.length !== rejectionCount) stateChanged = true

    // Prune tracked ids that vanished from the listing (opt-in).
    if (prune) {
      const removals = state.added.filter(id => existingIds.has(id) && !discoveredIds.has(id))
      if (removals.length > 0) {
        existing = existing.filter(model => !removals.includes(model.id))
        state.added = state.added.filter(id => !removals.includes(id))
        modelsChanged = true
        stateChanged = true
        notes.push(`${name}: pruned ${removals.length} (${removals.join(', ')})`)
      }
    }

    // Add ids advertised but not configured and not rejected.
    const fresh = discovered.filter(model => !existingIds.has(model.id) && !state.rejected.includes(model.id))
    if (fresh.length > 0) {
      existing = [...existing, ...fresh.map(toEntry)]
      for (const model of fresh) {
        if (!state.added.includes(model.id)) state.added.push(model.id)
      }
      modelsChanged = true
      stateChanged = true
      notes.push(`${name}: +${fresh.length} models (${existing.length - fresh.length} → ${existing.length})`)
    } else {
      notes.push(`${name}: up to date (${existing.length} models)`)
    }

    if (stateChanged) {
      providerState[name] = { added: state.added, rejected: state.rejected }
      provenanceChanged = true
    }
    if (modelsChanged && Array.isArray(profile.models)) {
      work.providers[name] = { ...profile, models: existing }
    }
  }
  if (notes.length > 0) ctx.logger.info('[dsh-model-sync] %s', notes.join('; '))
  if (modelsChanged) {
    await settings.replace(SETTINGS_NS, work)
  }
  if (provenanceChanged) {
    await scope.update({ providers: providerState })
  }
}
