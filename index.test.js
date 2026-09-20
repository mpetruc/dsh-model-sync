/**
 * Behavior tests for dsh-model-sync, focused on the manual on-demand sync
 * path: every activation — first boot or a plugin re-enable from the Plugins
 * surface — runs one sync pass, and interval repeats are distinct.
 *
 * Runs with `node --test`; the plugin's only scheduler needs are setTimeout /
 * setInterval, which the test replaces with controlled fake timers.
 */

import { dirname, join } from 'node:path'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
 * Build a fake host context: `llm` answers one fixed advertised list, and
 * `settings` keeps registered namespaces in an in-memory store. The plugin's
 * rejection-baseline state file lands under a per-test temp directory
 * (`dshHomePath` routes it there) and is wiped on dispose. `inject` runs
 * its callback immediately as a mini fiber whose effect disposers and
 * callback return value are collected, mirroring how the real loader owns
 * them; `dispose` tears that fiber down so a re-enable can start a new one.
 * @param section - initial llm-pi-ai section, or undefined for none.
 * @param models - the advertised model list `discoverModels` returns.
 */
function harness(section, models) {
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
    discoverModels: async () => {
      calls.discover += 1
      return models
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

test('boot activation sync discovers models and writes them once', async (t) => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  t.after(() => mock.timers.reset())
  const h = harness(
    { providers: { p1: { baseURL: 'http://x/v1', models: [] } } },
    [{ id: 'a' }, { id: 'b', name: 'B', contextWindow: 128 }],
  )
  apply(h.context, { intervalMinutes: 0 })
  await mock.timers.tick(ACTIVATION_DELAY_MS)
  await flush()

  const models = h.store.get('llm-pi-ai').providers.p1.models
  assert.deepEqual(models.map((model) => model.id), ['a', 'b'])
  assert.equal(models[0].owner, 'model-sync')
  assert.equal(models[1].owner, 'model-sync')
  assert.equal(h.calls.discover, 1)
  assert.equal(h.calls.replace, 1)
  assert.ok(h.calls.logs.some((entry) =>
    entry[0] === '[dsh-model-sync] %s sync: %s' && entry[1] === 'activation'))
  h.dispose()
})

test('re-enable after disable runs a fresh activation sync (manual toggle)', async (t) => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  t.after(() => mock.timers.reset())
  const h = harness(
    { providers: { p1: { baseURL: 'http://x/v1', models: [] } } },
    [{ id: 'a' }],
  )
  apply(h.context, { intervalMinutes: 0 })
  await mock.timers.tick(ACTIVATION_DELAY_MS)
  await flush()
  assert.equal(h.calls.discover, 1)

  // Disable: the fiber tears down and stops scheduling anything.
  h.dispose()
  // While off, one owned model disappears from the section (hand deletion).
  h.store.get('llm-pi-ai').providers.p1.models = []

  // Re-enable: a second activation sync re-discovers and re-adds it.
  apply(h.context, { intervalMinutes: 0 })
  await mock.timers.tick(ACTIVATION_DELAY_MS)
  await flush()

  assert.equal(h.calls.discover, 2)
  assert.equal(h.calls.replace, 2)
  const models = h.store.get('llm-pi-ai').providers.p1.models
  assert.deepEqual(models.map((model) => model.id), ['a'])
  assert.equal(models[0].owner, 'model-sync')
  const activations = h.calls.logs.filter((entry) =>
    entry[0] === '[dsh-model-sync] %s sync: %s' && entry[1] === 'activation')
  assert.equal(activations.length, 2)
  h.dispose()
})

test('positive intervalMinutes also repeats the pass with an interval trigger', async (t) => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  t.after(() => mock.timers.reset())
  const h = harness(
    { providers: { p1: { baseURL: 'http://x/v1', models: [] } } },
    [{ id: 'a' }],
  )
  apply(h.context, { intervalMinutes: 5 })
  await mock.timers.tick(ACTIVATION_DELAY_MS)
  await flush()
  const at = h.store.get('model-sync').lastSync.at
  await mock.timers.tick(5 * 60_000)
  await flush()

  assert.equal(h.calls.discover, 2)
  assert.equal(h.calls.replace, 1, 'an up-to-date pass writes nothing')
  assert.ok(h.calls.logs.some((entry) =>
    entry[0] === '[dsh-model-sync] %s sync: %s' && entry[1] === 'interval'))
  const summaries = h.calls.logs.filter((entry) =>
    entry[0] === '[dsh-model-sync] %s summary: %s')
  assert.equal(summaries.length, 1, 'only the activation pass prints a summary')
  assert.equal(h.calls.update, 1, 'only the activation pass persists an outcome')
  assert.equal(h.store.get('model-sync').lastSync.at, at, 'interval passes leave the persisted outcome untouched')
  h.dispose()
})

test('activation summary lists the model ids the pass added', async (t) => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  t.after(() => mock.timers.reset())
  const h = harness(
    { providers: { p1: { baseURL: 'http://x/v1', models: [] } } },
    [{ id: 'a' }, { id: 'b' }],
  )
  apply(h.context, { intervalMinutes: 0 })
  await mock.timers.tick(ACTIVATION_DELAY_MS)
  await flush()

  assert.ok(h.calls.logs.some((entry) =>
    entry[0] === '[dsh-model-sync] %s summary: %s'
    && entry[1] === 'activation'
    && entry[2] === 'p1: +2 models: a, b'))
  const provenance = h.store.get('model-sync')
  assert.equal(typeof provenance.lastSync.at, 'string')
  assert.deepEqual(provenance.lastSync.providers.p1, { added: ['a', 'b'], deleted: [] })
  h.dispose()
})

test('activation summary reports no models added or removed for an unchanged provider', async (t) => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  t.after(() => mock.timers.reset())
  const h = harness(
    { providers: { p1: { baseURL: 'http://x/v1', models: [{ id: 'a', owner: 'model-sync' }] } } },
    [{ id: 'a' }],
  )
  apply(h.context, { intervalMinutes: 0 })
  await mock.timers.tick(ACTIVATION_DELAY_MS)
  await flush()

  assert.equal(h.calls.replace, 0)
  assert.ok(h.calls.logs.some((entry) =>
    entry[0] === '[dsh-model-sync] %s summary: %s'
    && entry[1] === 'activation'
    && entry[2] === 'p1: no models added or removed'))
  assert.deepEqual(h.store.get('model-sync').lastSync.providers.p1, { added: [], deleted: [] })
  h.dispose()
})

test('activation summary lists pruned ids when prune removed them', async (t) => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  t.after(() => mock.timers.reset())
  const h = harness(
    {
      providers: {
        p1: {
          baseURL: 'http://x/v1',
          models: [
            { id: 'a', owner: 'model-sync' },
            { id: 'gone', owner: 'model-sync' },
          ],
        },
      },
    },
    [{ id: 'a' }],
  )
  apply(h.context, { intervalMinutes: 0, prune: true })
  await mock.timers.tick(ACTIVATION_DELAY_MS)
  await flush()

  assert.ok(h.calls.logs.some((entry) =>
    entry[0] === '[dsh-model-sync] %s summary: %s'
    && entry[1] === 'activation'
    && entry[2] === 'p1: -1 model: gone'))
  assert.deepEqual(h.store.get('model-sync').lastSync.providers.p1, { added: [], deleted: ['gone'] })
  h.dispose()
})

test('persisted rejections survive a re-enable: a rejected id is not re-added', async (t) => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  t.after(() => mock.timers.reset())
  const h = harness(
    { providers: { p1: { baseURL: 'http://x/v1', models: [] } } },
    [{ id: 'a' }],
  )
  // A rejection recorded by an earlier interval-based detection lives in the
  // plugin state file; only the in-memory baseline resets on re-enable.
  writeFileSync(h.stateFile, JSON.stringify({ providers: { p1: { rejected: ['a'] } } }))
  apply(h.context, { intervalMinutes: 0 })
  await mock.timers.tick(ACTIVATION_DELAY_MS)
  await flush()

  const models = h.store.get('llm-pi-ai').providers.p1.models
  assert.deepEqual(models.map((model) => model.id), [], 'rejected id stays out')
  assert.equal(h.calls.replace, 0)
  assert.deepEqual(JSON.parse(readFileSync(h.stateFile, 'utf8')).providers,
    { p1: { rejected: ['a'] } }, 'the pass does not touch the baseline')
  h.dispose()
})

test('interval detection records a deliberate deletion in the state file, not settings', async (t) => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  t.after(() => mock.timers.reset())
  const h = harness(
    { providers: { p1: { baseURL: 'http://x/v1', models: [] } } },
    [{ id: 'a' }, { id: 'b' }],
  )
  apply(h.context, { intervalMinutes: 5 })
  await mock.timers.tick(ACTIVATION_DELAY_MS)
  await flush()

  // A hand deletion while the id is still advertised: owned id gone, id
  // advertised, not previously rejected — a deliberate deletion.
  h.store.get('llm-pi-ai').providers.p1.models =
    h.store.get('llm-pi-ai').providers.p1.models.filter((model) => model.id !== 'a')
  await mock.timers.tick(5 * 60_000)
  await flush()

  assert.deepEqual(JSON.parse(readFileSync(h.stateFile, 'utf8')).providers,
    { p1: { rejected: ['a'] } }, 'deliberate deletion recorded in the state file')
  assert.ok(!('providers' in h.store.get('model-sync')), 'settings namespace stays clean')
  // The next interval pass does not resurrect the rejected id.
  await mock.timers.tick(5 * 60_000)
  await flush()
  const models = h.store.get('llm-pi-ai').providers.p1.models
  assert.deepEqual(models.map((model) => model.id), ['b'], 'rejected id stays out')
  h.dispose()
})

test('a legacy settings document migrates its rejection baseline into the state file', async (t) => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  t.after(() => mock.timers.reset())
  const h = harness(
    { providers: { p1: { baseURL: 'http://x/v1', models: [] } } },
    [{ id: 'a' }],
  )
  // A pre-0.7.0 document stored the baseline in the model-sync namespace.
  h.store.set('model-sync', {
    providers: { p1: { rejected: ['a'] } },
    lastSync: { at: '2026-09-19T00:00:00.000Z', providers: { p1: { added: [], deleted: [] } } },
  })
  apply(h.context, { intervalMinutes: 0 })
  await mock.timers.tick(ACTIVATION_DELAY_MS)
  await flush()

  const namespace = h.store.get('model-sync')
  assert.ok(!('providers' in namespace), 'legacy baseline stripped from the namespace')
  assert.equal(typeof namespace.lastSync.at, 'string')
  assert.deepEqual(JSON.parse(readFileSync(h.stateFile, 'utf8')).providers,
    { p1: { rejected: ['a'] } }, 'baseline moved into the state file')
  const models = h.store.get('llm-pi-ai').providers.p1.models
  assert.deepEqual(models.map((model) => model.id), [], 'the migrated rejection is honored')
  h.dispose()
})

test('prune removes owned ids that vanished from the listing, never hand-entered ones', async (t) => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  t.after(() => mock.timers.reset())
  const h = harness(
    {
      providers: {
        p1: {
          baseURL: 'http://x/v1',
          models: [
            { id: 'a', owner: 'model-sync' },
            { id: 'gone', owner: 'model-sync' },
            { id: 'hand', name: 'Hand-entered' },
          ],
        },
      },
    },
    [{ id: 'a' }],
  )
  apply(h.context, { intervalMinutes: 0, prune: true })
  await mock.timers.tick(ACTIVATION_DELAY_MS)
  await flush()

  const models = h.store.get('llm-pi-ai').providers.p1.models
  assert.deepEqual(models.map((model) => model.id), ['a', 'hand'],
    'stale owned id pruned, advertised owned id kept, hand-entered id kept')
  assert.equal(h.calls.replace, 1)
  h.dispose()
})

test('activation with no configured providers logs nothing-to-sync and writes nothing', async (t) => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  t.after(() => mock.timers.reset())
  const h = harness(undefined, [{ id: 'a' }])
  apply(h.context, { intervalMinutes: 0 })
  await mock.timers.tick(ACTIVATION_DELAY_MS)
  await flush()

  assert.equal(h.calls.discover, 0, 'no discovery without a section')
  assert.equal(h.calls.replace, 0)
  assert.equal(h.calls.update, 0, 'no outcome persisted without providers')
  assert.ok(h.calls.logs.some((entry) =>
    entry[0] === '[dsh-model-sync] %s sync: no llm-pi-ai providers configured; nothing to sync'
    && entry[1] === 'activation'))
  h.dispose()
})
