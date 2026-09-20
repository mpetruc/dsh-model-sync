/**
 * Adversarial edge-case tests for dsh-model-sync's manual on-demand sync
 * path: the disable→re-enable toggle in the Plugins UI disposes the old fiber
 * and runs `apply` again, which re-schedules one activation sync per fiber.
 * These tests probe lifecycle corners the happy-path suite does not: disposal
 * before the settle timer fires, disposal mid-sync, rapid toggles, the
 * per-activation deletion baseline, interval cleanup, and partial provider
 * failures. Mirrors the fake-harness approach of index.test.js.
 */

import { dirname, join } from 'node:path'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { apply } from './index.js'

/** Drain the event loop so fake-timer callbacks' async work settles. */
const flush = async () => {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve))
}

/** One sync pass settle delay, mirrored from the plugin's internal constant. */
const ACTIVATION_DELAY_MS = 1500

/**
 * Build a fake host context, same shape as index.test.js, parameterized by a
 * `discover` function so tests can hang or fail discovery per call.
 * @param section - initial llm-pi-ai section, or undefined for none.
 * @param discover - async (opts) => advertised model list.
 */
function harness(section, discover) {
  const store = new Map()
  if (section !== undefined) store.set('llm-pi-ai', section)
  const root = mkdtempSync(join(tmpdir(), 'dsh-model-sync-'))
  const stateFile = join(root, 'storages', 'model-sync', 'state.json')
  mkdirSync(dirname(stateFile), { recursive: true })
  const calls = { discover: 0, replace: 0, update: 0, logs: [] }
  const disposers = []
  const settings = {
    register(ns) {
      return {
        get: () => store.get(ns),
        update: async (patch) => {
          store.set(ns, { ...(store.get(ns) ?? {}), ...patch })
          calls.update += 1
        },
        replace: async (section) => {
          store.set(ns, section)
          calls.update += 1
        },
      }
    },
    get: (ns) => store.get(ns),
    replace: async (ns, value) => {
      store.set(ns, value)
      calls.replace += 1
    },
  }
  const llm = {
    discoverModels: async (ns, opts) => {
      calls.discover += 1
      return discover(opts)
    },
  }
  const context = {
    logger: {
      info: (...args) => calls.logs.push(args),
      warn: (...args) => calls.logs.push(args),
    },
    get: (name) => (name === 'settings' ? settings
      : name === 'llm' ? llm
      : name === 'dshHomePath' ? (relative) => join(root, relative)
      : undefined),
    inject(deps, callback) {
      const result = callback({
        settings,
        effect(callback) {
          const disposer = callback()
          disposers.push(disposer)
          return disposer
        },
      })
      if (typeof result === 'function') disposers.push(result)
      return result
    },
  }
  const dispose = () => {
    while (disposers.length > 0) disposers.pop()()
    rmSync(root, { recursive: true, force: true })
  }
  return { context, store, calls, dispose, stateFile }
}

test('dispose before the settle timer fires suppresses the sync; re-enable runs exactly one', async (t) => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  t.after(() => mock.timers.reset())
  const h = harness(
    { providers: { p1: { baseURL: 'http://x/v1', models: [] } } },
    async () => [{ id: 'a' }],
  )
  apply(h.context, { intervalMinutes: 0 })
  await mock.timers.tick(ACTIVATION_DELAY_MS - 500)
  await flush()
  assert.equal(h.calls.discover, 0, 'no sync before the settle delay elapses')
  h.dispose() // disable before the activation timer fires
  await mock.timers.tick(5000)
  await flush()
  assert.equal(h.calls.discover, 0, 'disposed fiber schedules nothing')

  apply(h.context, { intervalMinutes: 0 }) // re-enable
  await mock.timers.tick(ACTIVATION_DELAY_MS)
  await flush()
  assert.equal(h.calls.discover, 1, 're-enable runs exactly one activation sync')
  h.dispose()
})

test('dispose mid-sync: old fiber finishes writing, new fiber syncs, final state consistent', async (t) => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  t.after(() => mock.timers.reset())
  let resolveGate
  const gate = new Promise((resolve) => { resolveGate = resolve })
  let call = 0
  const h = harness(
    { providers: { p1: { baseURL: 'http://x/v1', models: [] } } },
    async () => {
      call += 1
      if (call === 1) return gate // first (old) fiber hangs mid-discovery
      return [{ id: 'a' }]
    },
  )
  apply(h.context, { intervalMinutes: 0 })
  await mock.timers.tick(ACTIVATION_DELAY_MS)
  await flush()
  assert.equal(h.calls.discover, 1, 'old fiber sync started and is awaiting discovery')
  h.dispose() // user disables while the sync is in flight

  apply(h.context, { intervalMinutes: 0 }) // re-enable
  await mock.timers.tick(ACTIVATION_DELAY_MS)
  await flush()
  assert.equal(h.calls.discover, 2, 'new fiber started its own sync')
  assert.equal(h.calls.replace, 1, 'new fiber wrote its result first')

  resolveGate([{ id: 'a' }]) // old fiber's discovery finally resolves
  await flush()
  assert.equal(h.calls.replace, 2, 'old fiber write lands afterwards without error')
  const models = h.store.get('llm-pi-ai').providers.p1.models
  assert.deepEqual(models.map((model) => model.id), ['a'])
  assert.equal(models[0].owner, 'model-sync')
  h.dispose()
})

test('rapid toggle within the settle window yields exactly one sync, from the final fiber', async (t) => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  t.after(() => mock.timers.reset())
  const h = harness(
    { providers: { p1: { baseURL: 'http://x/v1', models: [] } } },
    async () => [{ id: 'a' }],
  )
  apply(h.context, { intervalMinutes: 0 })
  await mock.timers.tick(100)
  h.dispose()
  apply(h.context, { intervalMinutes: 0 })
  await mock.timers.tick(ACTIVATION_DELAY_MS)
  await flush()
  assert.equal(h.calls.discover, 1, 'only the surviving fiber syncs once')
  assert.equal(h.calls.replace, 1)
  h.dispose()
})

test('re-enable resets the deletion baseline: a deleted owned id is re-added, not rejected', async (t) => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  t.after(() => mock.timers.reset())
  const h = harness(
    { providers: { p1: { baseURL: 'http://x/v1', models: [] } } },
    async () => [{ id: 'a' }, { id: 'b' }],
  )
  apply(h.context, { intervalMinutes: 0 })
  await mock.timers.tick(ACTIVATION_DELAY_MS)
  await flush()
  h.dispose()

  // While off, the user deletes one owned id by hand.
  h.store.get('llm-pi-ai').providers.p1.models =
    h.store.get('llm-pi-ai').providers.p1.models.filter((model) => model.id !== 'a')

  apply(h.context, { intervalMinutes: 0 }) // re-enable
  await mock.timers.tick(ACTIVATION_DELAY_MS)
  await flush()

  const models = h.store.get('llm-pi-ai').providers.p1.models
  const ids = models.map((model) => model.id)
  assert.ok(ids.includes('a'), 'deleted id is re-added after a fresh activation')
  assert.equal(ids.length, 2)
  // Fresh baseline means no rejection memory was recorded; the namespace
  // carries only the lastSync outcome for the UI, never a providers key.
  const provenance = h.store.get('model-sync')
  assert.ok(!('providers' in provenance), 'settings namespace stays free of sync bookkeeping')
  h.dispose()
})

test('intervalMinutes>0: disposal clears the interval; re-enabled fiber runs activation then interval', async (t) => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  t.after(() => mock.timers.reset())
  const h = harness(
    { providers: { p1: { baseURL: 'http://x/v1', models: [] } } },
    async () => [{ id: 'a' }],
  )
  apply(h.context, { intervalMinutes: 5 })
  await mock.timers.tick(ACTIVATION_DELAY_MS)
  await flush()
  assert.equal(h.calls.discover, 1)
  h.dispose()
  await mock.timers.tick(5 * 60_000)
  await flush()
  assert.equal(h.calls.discover, 1, 'disposed fiber cleared its interval')

  apply(h.context, { intervalMinutes: 5 }) // re-enable
  await mock.timers.tick(ACTIVATION_DELAY_MS)
  await flush()
  await mock.timers.tick(5 * 60_000)
  await flush()
  assert.equal(h.calls.discover, 3, 're-enabled fiber: activation + interval syncs')
  h.dispose()
})

test('one failing provider never rejects the pass; the healthy provider still syncs', async (t) => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  t.after(() => mock.timers.reset())
  const h = harness(
    {
      providers: {
        ok: { baseURL: 'http://ok/v1', models: [] },
        bad: { baseURL: 'http://bad/v1', models: [] },
      },
    },
    async (opts) => {
      if (opts.provider === 'bad') throw new Error('boom')
      return [{ id: 'a' }]
    },
  )
  apply(h.context, { intervalMinutes: 0 })
  await mock.timers.tick(ACTIVATION_DELAY_MS)
  await flush()

  const section = h.store.get('llm-pi-ai')
  assert.deepEqual(section.providers.ok.models.map((model) => model.id), ['a'])
  assert.deepEqual(section.providers.bad.models, [], 'failed provider untouched')
  assert.ok(h.calls.logs.some((entry) =>
    entry[0] === '[dsh-model-sync] %s sync: %s' && String(entry[2]).includes('discovery failed')))
  h.dispose()
})
