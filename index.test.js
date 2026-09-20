/**
 * Behavior tests for dsh-model-sync, focused on the manual on-demand sync
 * path: every activation — first boot or a plugin re-enable from the Plugins
 * surface — runs one sync pass, and interval repeats are distinct.
 *
 * Runs with `node --test`; the plugin's only scheduler needs are setTimeout /
 * setInterval, which the test replaces with controlled fake timers.
 */

import { mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { apply } from './index.js'

/** Flush the microtask chain underneath the fake-timer callbacks. */
const flush = () => new Promise((resolve) => setImmediate(resolve))

/** One sync pass settle delay, mirrored from the plugin's internal constant. */
const ACTIVATION_DELAY_MS = 1500

/**
 * Build a fake host context: `llm` answers one fixed advertised list, and
 * `settings` keeps registered namespaces in an in-memory store. `inject` runs
 * its callback immediately as a mini fiber whose effect disposers and
 * callback return value are collected, mirroring how the real loader owns
 * them; `dispose` tears that fiber down so a re-enable can start a new one.
 * @param section - initial llm-pi-ai section, or undefined for none.
 * @param models - the advertised model list `discoverModels` returns.
 */
function harness(section, models) {
  const store = new Map()
  if (section !== undefined) store.set('llm-pi-ai', section)
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
    get: (name) => (name === 'settings' ? settings : name === 'llm' ? llm : undefined),
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
  }
  return { context, store, calls, dispose }
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
  const activations = h.calls.logs.filter((entry) => entry[1] === 'activation')
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
  await mock.timers.tick(5 * 60_000)
  await flush()

  assert.equal(h.calls.discover, 2)
  assert.ok(h.calls.logs.some((entry) =>
    entry[0] === '[dsh-model-sync] %s sync: %s' && entry[1] === 'interval'))
  h.dispose()
})
