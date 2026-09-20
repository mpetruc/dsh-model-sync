/**
 * Client half of dsh-model-sync: shows the last activation sync's outcome on
 * the bundle's Plugins page. Registers into the `plugins.bundle.config` slot
 * (keyed by the package name) so the panel sits between the bundle's
 * description and its Components list — the page where the manual toggle
 * lives. The outcome is read through the client settings scope bound to the
 * `model-sync` namespace; the scope refreshes on the Host's settings commits,
 * so the panel updates live when the re-enabled plugin writes its `lastSync`.
 */

window.__ModuleLoader__.load({
  id: 'dsh-model-sync',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useEffect, useState } = React

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
     * @param props.scope - bound settings scope for the model-sync namespace.
     * @param props.t - bound locale translator.
     */
    function LastSyncPanel({ scope, t }) {
      const [snapshot, setSnapshot] = useState(() => scope.getSnapshot())
      useEffect(() => scope.subscribe(() => setSnapshot(scope.getSnapshot())), [scope])
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

    return {
      inject: ['slots', 'settingsScope', 'locale'],
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
        const scope = ctx.settingsScope.bind({ namespace: 'model-sync' })
        ctx.effect(() => ctx.slots.register({
          name: 'plugins.bundle.config',
          key: 'dsh-model-sync',
        }, (props) => h(LastSyncPanel, { ...props, scope, t })),
        'dsh-model-sync: last-sync panel')
      },
    }
  },
})
