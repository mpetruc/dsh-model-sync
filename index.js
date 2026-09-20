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
 * Provenance is a per-entry `owner` marker: entries the plugin auto-added
 * carry `owner: 'model-sync'`; hand-entered entries omit the key. Markers
 * survive every write path (schemastery objects are open, and both the UI
 * and this plugin spread entries rather than rebuild them).
 *
 * Manual sync: every activation of the plugin — the first boot or a manual
 * re-enable of the `model-sync` row on the Plugins page — runs one sync pass,
 * so toggling the row off and back on refreshes the model lists on demand. A
 * positive `intervalMinutes` additionally repeats the pass on that cadence.
 * Each activation pass also logs a per-provider outcome summary: the model
 * ids it added or pruned, or `no models added or removed` when nothing
 * changed.
 *
 * Sync rules
 * - Adds: advertised ids that are not configured are appended with
 *   `owner: 'model-sync'` (plus name / contextWindow / maxTokens / input
 *   metadata when the listing reports it).
 * - Prune (config `prune: true`): entries owned by the plugin whose id is no
 *   longer advertised are removed. Hand-entered entries are never pruned.
 * - Rejected: when an owned id that is still advertised disappears between
 *   two consecutive syncs, the plugin treats it as a deliberate deletion and
 *   remembers it in the `model-sync` settings namespace so it is not
 *   re-added. The owner marker cannot remember a deleted entry — the entry
 *   is gone — so detection diffs the previous sync's owned ids (an in-memory
 *   baseline) against the current section, and only these bare id lists live
 *   in the namespace, never a duplicate of the models array. Manually
 *   re-adding a rejected id clears the rejection. Detection diffs consecutive
 *   syncs (in-memory baseline, refreshed at every run), so it stays live only
 *   with a positive `intervalMinutes`; with `intervalMinutes: 0` (activation
 *   sync only) a deletion is re-added at the next activation's sync.
 *
 * @module dsh-model-sync
 */

import z from '@deepseek-ai/schemastery'

/** llm-pi-ai settings namespace read and written by this plugin. */
const SETTINGS_NS = 'llm-pi-ai'

/** Namespace whose registered model discovery serves drafts. */
const DISCOVERY_NS = 'llm-pi-ai'

/** Namespace holding rejection memory per provider. */
const PROVENANCE_NS = 'model-sync'

/** Entry marker value for ids this plugin auto-added. */
const OWNER = 'model-sync'

/** Rejection section schema: bare id lists, nothing else. */
const PROVENANCE_SCHEMA = z.object({
  providers: z.dict(z.object({
    rejected: z.array(z.string()).default([]),
  })).default({}),
})

/** Settle grace before the activation sync (boot or manual re-enable). */
const ACTIVATION_SYNC_DELAY_MS = 1500

/** Whether one configured model entry was auto-added by this plugin. */
function isOwned(entry) {
  return entry.owner === OWNER
}

/** "model" or "models" for the outcome summary, by count. */
function countLabel(count) {
  return count === 1 ? 'model' : 'models'
}

/** Build the settings `models` entry for one discovered model. */
function toEntry(model) {
  const entry = { id: model.id, owner: OWNER }
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
  // Owned ids observed at the previous sync, per provider. The `owner` marker
  // lives on entries, so a deleted entry is invisible to the current section;
  // diffing against this baseline is what detects a deliberate deletion.
  const lastOwned = new Map()

  const syncOnce = async (scope, reason) => {
    if (running) return
    running = true
    try {
      await syncProviders(ctx, wanted, prune, scope, lastOwned, reason)
    } catch (error) {
      ctx.logger.warn('[dsh-model-sync] %s sync failed: %s', reason,
        error instanceof Error ? error.message : String(error))
    } finally {
      running = false
    }
  }

  // Each activation — the first boot or a manual re-enable from the Plugins
  // page — runs one sync once services are up.
  ctx.inject(['llm', 'settings'], (sctx) => {
    const scope = sctx.settings.register(PROVENANCE_NS, PROVENANCE_SCHEMA)
    const run = (reason) => syncOnce(scope, reason)
    const first = sctx.effect(() => {
      const timer = setTimeout(() => run('activation'), ACTIVATION_SYNC_DELAY_MS)
      return () => clearTimeout(timer)
    })
    const repeat = intervalMinutes > 0
      ? sctx.effect(() => {
        const timer = setInterval(() => run('interval'), intervalMinutes * 60_000)
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
 * @param prune - whether to remove owned ids no longer advertised.
 * @param scope - the model-sync rejection namespace scope.
 * @param lastOwned - owned ids seen at the previous sync, per provider.
 * @param reason - which trigger ran this pass ('activation' | 'interval').
 */
async function syncProviders(ctx, wanted, prune, scope, lastOwned, reason) {
  const llm = ctx.get('llm')
  const settings = ctx.get('settings')
  const section = settings.get(SETTINGS_NS)
  if (typeof section !== 'object' || section === null
    || typeof section.providers !== 'object' || section.providers === null) {
    ctx.logger.info('[dsh-model-sync] %s sync: no llm-pi-ai providers configured; nothing to sync', reason)
    return
  }
  const work = structuredClone(section)
  const provenance = structuredClone(scope.get() ?? {})
  const providerState = typeof provenance.providers === 'object' && provenance.providers !== null
    ? provenance.providers
    : {}
  const notes = []
  const summaries = []
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
    const ownedNow = new Set(existing.filter(isOwned).map(model => model.id))
    const state = providerState[name] ?? { rejected: [] }
    let stateChanged = false
    // Model ids this pass appended or pruned, for the activation summary.
    const added = []
    const deleted = []

    // Track deliberate deletions via the baseline: an id owned at the
    // previous sync that is gone now, while still advertised, was removed by
    // hand — remember not to re-add it. A vanished id is not advertised, so a
    // prune never lands here.
    for (const id of lastOwned.get(name) ?? []) {
      if (!ownedNow.has(id) && discoveredIds.has(id) && !state.rejected.includes(id)) {
        state.rejected.push(id)
        stateChanged = true
      }
    }

    // Forget rejections the user manually re-added (the id is configured
    // again, so its rejection no longer means anything).
    const rejectionCount = state.rejected.length
    state.rejected = state.rejected.filter(id => !existingIds.has(id))
    if (state.rejected.length !== rejectionCount) stateChanged = true

    // Prune owned entries that vanished from the listing (opt-in).
    if (prune) {
      const removals = existing.filter(model => isOwned(model) && !discoveredIds.has(model.id))
      if (removals.length > 0) {
        existing = existing.filter(model => !removals.includes(model))
        modelsChanged = true
        deleted.push(...removals.map(model => model.id))
        notes.push(`${name}: pruned ${removals.length} (${removals.map(model => model.id).join(', ')})`)
      }
    }

    // Add ids advertised but not configured and not rejected.
    const fresh = discovered.filter(model => !existingIds.has(model.id) && !state.rejected.includes(model.id))
    if (fresh.length > 0) {
      existing = [...existing, ...fresh.map(toEntry)]
      modelsChanged = true
      added.push(...fresh.map(model => model.id))
      notes.push(`${name}: +${fresh.length} models (${existing.length - fresh.length} → ${existing.length})`)
    } else {
      notes.push(`${name}: up to date (${existing.length} models)`)
    }

    if (stateChanged) {
      providerState[name] = { rejected: state.rejected }
      provenanceChanged = true
    }
    if (modelsChanged && Array.isArray(profile.models)) {
      work.providers[name] = { ...profile, models: existing }
    }
    // Outcome summary for this provider, printed once per activation pass.
    const parts = []
    if (added.length > 0) parts.push(`+${added.length} ${countLabel(added.length)}: ${added.join(', ')}`)
    if (deleted.length > 0) parts.push(`-${deleted.length} ${countLabel(deleted.length)}: ${deleted.join(', ')}`)
    summaries.push(parts.length > 0 ? `${name}: ${parts.join('; ')}` : `${name}: no models added or removed`)
    // Baseline for the next sync = the owned set as it stands AFTER this
    // sync's prune/add, so ids added now are tracked from the next run on.
    lastOwned.set(name, new Set(existing.filter(isOwned).map(model => model.id)))
  }
  if (notes.length > 0) ctx.logger.info('[dsh-model-sync] %s sync: %s', reason, notes.join('; '))
  if (reason === 'activation' && summaries.length > 0) {
    ctx.logger.info('[dsh-model-sync] %s summary: %s', reason, summaries.join('; '))
  }
  if (modelsChanged) {
    await settings.replace(SETTINGS_NS, work)
  }
  if (provenanceChanged) {
    await scope.update({ providers: providerState })
  }
}
