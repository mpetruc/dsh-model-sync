/**
 * Client half of dsh-model-sync: shows the last activation sync's outcome on
 * the bundle's Plugins page. Registers into the `plugins.bundle.config` slot
 * (keyed by the package name) so the panel sits between the bundle's
 * description and its Components list — the page where the manual toggle
 * lives. The outcome is read straight from the Host's `settings.describe`
 * answer (the same remote read the ui-settings mirror performs) instead of a
 * bound settings scope: the scope mirror is `unavailable` on non-loopback
 * origins by harness design, and this read is what keeps the panel rendering
 * when the GUI is served over a LAN address. The panel refreshes on the same
 * two signals the mirror subscribes to, so it stays live after a toggle.
 */

window.__ModuleLoader__.load({
  id: 'dsh-model-sync',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useEffect, useState } = React

    const NAMESPACE = 'model-sync'

    /**
     * One provider's added/deleted outcome, rendered like the host's summary
     * log: either the id lists, or "no models added or removed".
     * @param outcome - `{ added, deleted }` id arrays from the namespace.
     * @param t - bound locale translator.
     */
    function describe(outcome, t) {
      const added = Array.isArray(outcome?.added) ? outcome.added : []
      const deleted = Array.isArray(outcome?.deleted) ? outcome.deleted : []
      if (added.length === 0 && deleted.length === 0) return t('noChanges')
      const parts = []
      if (added.length > 0) {
        parts.push(`+${added.length} ${added.length === 1 ? 'model' : 'models'}: ${added.join(', ')}`)
      }
      if (deleted.length > 0) {
        parts.push(`-${deleted.length} ${deleted.length === 1 ? 'model' : 'models'}: ${deleted.join(', ')}`)
      }
      return parts.join('; ')
    }

    /**
     * The last-sync outcome panel: header with the run time, then one line
     * per provider. Renders nothing until a sync has completed and the
     * namespace is readable.
     * @param props - slot owner props (`view` is 'page' for this seat).
     * @param props.source - live last-sync snapshot source.
     * @param props.t - bound locale translator.
     */
    function LastSyncPanel({ source, t }) {
      const [snapshot, setSnapshot] = useState(() => source.getSnapshot())
      useEffect(() => source.subscribe(() => setSnapshot(source.getSnapshot())), [source])
      if (snapshot.status !== 'ready') return null
      const value = snapshot.value
      if (typeof value !== 'object' || value === null || typeof value.lastSync !== 'object' || value.lastSync === null) {
        return null
      }
      const lastSync = value.lastSync
      const providers = Object.entries(typeof lastSync.providers === 'object' && lastSync.providers !== null
        ? lastSync.providers
        : {})
      if (providers.length === 0) return null
      return h('section', {
        'aria-label': t('header'),
        style: { margin: '10px 0 2px', fontSize: 12, lineHeight: 1.7 },
      },
        h('div', { style: { opacity: 0.8 } },
          `${t('header')} — ${new Date(lastSync.at).toLocaleString()}`),
        providers.map(([name, outcome]) => h('div', { key: name },
          `${name}: ${describe(outcome, t)}`)))
    }

    /**
     * A snapshot source over the Host settings document's `model-sync`
     * namespace, refreshed on the settings invalidations the ui-settings
     * mirror also listens to. Bypasses the mirror because non-loopback pages
     * run it in `memory` persistence and read `unavailable`; the describe RPC
     * itself is served to every trusted origin.
     * @param ctx - client context with the `remote` and `remote.settings`
     * services injected.
     * @returns `{ getSnapshot, subscribe }` over `{ status, value }` snapshots.
     */
    function createLastSyncSource(ctx) {
      let snapshot = { status: 'loading', value: undefined }
      let generation = 0
      const listeners = new Set()
      const emit = () => { for (const listener of listeners) listener() }
      const refresh = async () => {
        const gen = ++generation
        let outcome
        try {
          const response = await ctx.remote.settings.describe()
          outcome = response.ok
            ? { status: 'ready', value: response.value.namespaces.find((row) => row.ns === NAMESPACE)?.value }
            : { status: 'error', value: undefined }
        } catch {
          outcome = { status: 'error', value: undefined }
        }
        if (gen !== generation) return
        snapshot = outcome
        emit()
      }
      ctx.effect(() => {
        void refresh()
        const disposers = [
          ctx.remote.$on('settings/document-updated', () => { void refresh() }),
          ctx.on('connection/reset', () => { void refresh() }),
        ]
        return () => {
          generation += 1
          for (const dispose of disposers) dispose()
        }
      }, 'dsh-model-sync: last-sync source')
      return {
        getSnapshot: () => snapshot,
        subscribe: (listener) => {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
      }
    }

    return {
      inject: ['slots', 'locale', 'remote', 'remote.settings'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register('modelSync', {
          en: {
            header: 'Last sync',
            noChanges: 'no models added or removed',
          },
          zh: {
            header: '上次同步',
            noChanges: '没有新增或移除任何模型',
          },
        }), 'dsh-model-sync: dictionaries')
        const t = ctx.locale.bind('modelSync')
        const source = createLastSyncSource(ctx)
        // Injection, not a bare registration: the plugins.bundle.config seat
        // exists only once ui-plugin-manager's own entry realizes its 'main'
        // registration, which can happen after this entry activates — a bare
        // register in apply would throw 'slot is not declared' at boot.
        ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
          name: 'plugins.bundle.config',
          key: 'dsh-model-sync',
        }, (props) => h(LastSyncPanel, { ...props, source, t })))
      },
    }
  },
})
