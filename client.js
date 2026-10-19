/**
 * Browser half of `dsh-schedule-send`.
 *
 * Registers three contributions:
 *  - `conversation.input.right` — the clock control that opens the schedule
 *    popover for the current draft;
 *  - `conversation.chat.commandview` (`schedule-send`) — the persistent card
 *    that records one queued send and offers its cancellation;
 *  - `conversation.chat.commandview` (`schedule-send-cancel`) — a quiet status
 *    line for a cancellation, so the generic command card never shows raw JSON.
 *
 * Every Host interaction rides the session command channel
 * (`ctx.remote.commands.execute`); the Host half owns the queue and delivery.
 * The artifact is a plain closure factory that depends only on `react` and
 * `react-dom`, so it needs no build and no version-specific UI primitives.
 */
window.__ModuleLoader__.load({
  id: 'dsh-schedule-send',
  factory(require) {
    const React = require('react')
    const { createPortal } = require('react-dom')
    const { createElement: h, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } = React

    /** Locale namespace owned by this plugin. */
    const NS = 'schedule.send'

    /** Simplified Chinese dictionary (the key-set source of truth). */
    const zh = {
      'trigger.label': '定时发送',
      'trigger.empty': '先输入要发送的内容',
      'trigger.attachments': '定时发送暂不支持附件',
      'panel.title': '定时发送',
      'panel.subtitle': '到点后自动发进当前会话',
      'panel.draft': '将发送',
      'panel.custom': '自定义时间',
      'panel.sendAt': '发送时间：{time}',
      'panel.invalid': '请选择一个未来的时间',
      'panel.attachments': '当前草稿含附件，定时发送只支持纯文本。',
      'panel.cancel': '取消',
      'panel.confirm': '定时发送',
      'panel.sending': '安排中…',
      'preset.30m': '30 分钟后',
      'preset.1h': '1 小时后',
      'preset.3h': '3 小时后',
      'preset.tomorrow': '明天 09:00',
      'toast.scheduled': '已安排在 {time}',
      'card.title': '定时发送',
      'card.pending': '等待发送中',
      'card.cancel': '取消',
      'card.cancelling': '取消中…',
      'card.cancelled': '已取消',
      'card.sent': '已发送，无法取消',
      'card.cancelFailed': '取消失败：{message}',
      'card.cancelTitle': '已取消定时发送',
      'card.cancelError': '取消定时发送失败',
      'error.generic': '操作失败',
      'error.unavailable': '定时发送暂不可用',
    }

    /** English dictionary, key-identical to the Chinese source of truth. */
    const en = {
      'trigger.label': 'Schedule send',
      'trigger.empty': 'Write the message first',
      'trigger.attachments': 'Attachments are not supported yet',
      'panel.title': 'Schedule send',
      'panel.subtitle': 'Delivered into this conversation at the chosen time',
      'panel.draft': 'Will send',
      'panel.custom': 'Custom time',
      'panel.sendAt': 'Sends at {time}',
      'panel.invalid': 'Choose a time in the future',
      'panel.attachments': 'The draft has attachments; scheduled sends are text-only.',
      'panel.cancel': 'Cancel',
      'panel.confirm': 'Schedule',
      'panel.sending': 'Scheduling…',
      'preset.30m': 'In 30 minutes',
      'preset.1h': 'In 1 hour',
      'preset.3h': 'In 3 hours',
      'preset.tomorrow': 'Tomorrow 09:00',
      'toast.scheduled': 'Scheduled for {time}',
      'card.title': 'Scheduled send',
      'card.pending': 'Waiting to send',
      'card.cancel': 'Cancel',
      'card.cancelling': 'Cancelling…',
      'card.cancelled': 'Cancelled',
      'card.sent': 'Already sent; nothing to cancel',
      'card.cancelFailed': 'Could not cancel: {message}',
      'card.cancelTitle': 'Scheduled send cancelled',
      'card.cancelError': 'Could not cancel the scheduled send',
      'error.generic': 'The operation failed',
      'error.unavailable': 'Scheduled send is unavailable',
    }

    /** Reusable inline style fragments (all colors are theme tokens). */
    const STYLES = {
      panel: {
        position: 'fixed',
        zIndex: 1200,
        boxSizing: 'border-box',
        width: 336,
        maxWidth: 'calc(100vw - 32px)',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        padding: 14,
        borderRadius: 18,
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-overlay)',
        boxShadow: 'var(--dsw-elevation-prominent, 0 12px 32px rgba(0, 0, 0, 0.28))',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: 13,
        lineHeight: '18px',
      },
      title: { fontSize: 14, fontWeight: 600, lineHeight: '20px' },
      muted: { color: 'var(--dsw-alias-label-secondary)', fontSize: 11, lineHeight: '16px' },
      draftBox: {
        maxHeight: 96,
        overflow: 'auto',
        padding: '8px 10px',
        borderRadius: 10,
        background: 'var(--dsw-alias-bg-layer-2)',
        whiteSpace: 'pre-wrap',
        overflowWrap: 'anywhere',
        color: 'var(--dsw-alias-label-primary)',
      },
      chips: { display: 'flex', flexWrap: 'wrap', gap: 6 },
      chip: {
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary)',
        borderRadius: 999,
        padding: '3px 9px',
        fontSize: 12,
        lineHeight: '18px',
        cursor: 'pointer',
      },
      chipActive: {
        borderColor: 'var(--dsw-alias-brand-primary)',
        color: 'var(--dsw-alias-brand-primary)',
      },
      input: {
        boxSizing: 'border-box',
        width: '100%',
        height: 32,
        padding: '0 8px',
        borderRadius: 8,
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-primary)',
        font: 'inherit',
      },
      label: { display: 'flex', flexDirection: 'column', gap: 4 },
      warning: { color: 'var(--dsw-alias-state-warn-primary)', fontSize: 12, lineHeight: '17px' },
      error: { color: 'var(--dsw-alias-state-error-primary)', fontSize: 12, lineHeight: '17px', overflowWrap: 'anywhere' },
      footer: { display: 'flex', justifyContent: 'flex-end', gap: 8, paddingTop: 2 },
      notice: {
        position: 'fixed',
        zIndex: 1201,
        padding: '6px 12px',
        borderRadius: 999,
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-overlay)',
        boxShadow: 'var(--dsw-elevation-prominent, 0 8px 24px rgba(0, 0, 0, 0.24))',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: 12,
        lineHeight: '18px',
        whiteSpace: 'nowrap',
      },
      trigger: {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 28,
        height: 28,
        padding: 0,
        border: 0,
        borderRadius: 8,
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary)',
        cursor: 'pointer',
      },
      card: {
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        boxSizing: 'border-box',
        width: '100%',
        padding: '9px 12px',
        borderRadius: 12,
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-1)',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: 13,
        lineHeight: '18px',
      },
      cardHeader: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, lineHeight: '18px' },
      cardActions: { display: 'flex', justifyContent: 'flex-end', gap: 8 },
    }

    /** Preset offsets offered next to the custom time. */
    const PRESETS = [
      { id: '30m', key: 'preset.30m', offsetMs: 30 * 60_000 },
      { id: '1h', key: 'preset.1h', offsetMs: 60 * 60_000 },
      { id: '3h', key: 'preset.3h', offsetMs: 3 * 60 * 60_000 },
    ]

    /** Alarm-clock glyph in the app's outline icon language. */
    function AlarmClockIcon({ size = 16 }) {
      return h('svg', {
        viewBox: '0 0 16 16',
        width: size,
        height: size,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.4,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
        focusable: false,
        style: { flex: 'none', display: 'block' },
      },
      h('circle', { cx: 8, cy: 8.6, r: 5.1 }),
      h('path', { d: 'M8 5.7v3l1.9 1.2' }),
      h('path', { d: 'M4.3 2.7 3 4M11.7 2.7 13 4' }),
      )
    }

    /** Token-styled text button, so no UI-primitives import is needed. */
    function ActionButton({ variant = 'ghost', disabled = false, onClick, children }) {
      const base = {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 4,
        height: 28,
        padding: '0 12px',
        borderRadius: 14,
        fontSize: 12,
        lineHeight: '18px',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.4 : 1,
      }
      const byVariant = variant === 'primary'
        ? { border: 'none', background: 'var(--dsw-alias-button-primary-fill)', color: 'var(--dsw-alias-label-primary-foreground)' }
        : variant === 'outline'
          ? { border: '1px solid var(--dsw-alias-border-l2)', background: 'transparent', color: 'var(--dsw-alias-label-primary)' }
          : { border: 'none', background: 'transparent', color: 'var(--dsw-alias-label-primary)' }
      return h('button', { type: 'button', disabled, onClick, style: { ...base, ...byVariant } }, children)
    }

    /**
     * Keep one floating panel above its trigger, clamped to the viewport.
     * @param open - whether the panel is mounted.
     * @param anchorRef - trigger element.
     * @param panelRef - floating panel element.
     * @returns Inline position, or null before the first measurement.
     */
    function useAnchoredAbove(open, anchorRef, panelRef) {
      const [position, setPosition] = useState(null)
      useLayoutEffect(() => {
        if (!open) {
          setPosition(null)
          return undefined
        }
        const place = () => {
          const anchor = anchorRef.current
          if (anchor === null) return
          const rect = anchor.getBoundingClientRect()
          const width = panelRef.current === null ? 0 : panelRef.current.offsetWidth
          const height = panelRef.current === null ? 0 : panelRef.current.offsetHeight
          let left = rect.left
          if (width > 0) left = Math.min(Math.max(left, 16), window.innerWidth - width - 16)
          let top = rect.top - 8 - height
          if (height > 0) top = Math.max(top, 16)
          setPosition({ left, top })
        }
        place()
        window.addEventListener('scroll', place, true)
        window.addEventListener('resize', place)
        const panel = panelRef.current
        let observer
        if (typeof ResizeObserver !== 'undefined' && panel !== null) {
          observer = new ResizeObserver(place)
          observer.observe(panel)
        }
        return () => {
          window.removeEventListener('scroll', place, true)
          window.removeEventListener('resize', place)
          if (observer !== undefined) observer.disconnect()
        }
      }, [open, anchorRef, panelRef])
      return position
    }

    /**
     * Close a trigger-owned popover on a pointerdown outside it.
     * @param rootRef - element containing the trigger.
     * @param open - whether the popover is showing.
     * @param close - close callback.
     * @param portalRef - portaled panel that also counts as inside.
     */
    function useOutsideDismiss(rootRef, open, close, portalRef) {
      useEffect(() => {
        if (!open) return undefined
        const onPointerDown = event => {
          const target = event.target
          if (!(target instanceof Node)) return
          if (rootRef.current !== null && rootRef.current.contains(target)) return
          if (portalRef.current !== null && portalRef.current.contains(target)) return
          close()
        }
        document.addEventListener('pointerdown', onPointerDown)
        return () => { document.removeEventListener('pointerdown', onPointerDown) }
      }, [rootRef, open, close, portalRef])
    }

    /**
     * Format one epoch as a local `datetime-local` value.
     * @param epoch - epoch milliseconds.
     * @returns `YYYY-MM-DDTHH:mm` in the browser's zone.
     */
    function localInputValue(epoch) {
      const date = new Date(epoch)
      const pad = value => String(value).padStart(2, '0')
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
        + `T${pad(date.getHours())}:${pad(date.getMinutes())}`
    }

    /**
     * Parse one `datetime-local` value as browser-local time.
     * @param value - input value.
     * @returns Epoch milliseconds, or NaN.
     */
    function parseLocalInput(value) {
      if (typeof value !== 'string' || value === '') return Number.NaN
      const epoch = new Date(value).getTime()
      return Number.isFinite(epoch) ? epoch : Number.NaN
    }

    /**
     * Format an epoch for display in the browser locale and zone.
     * @param epoch - epoch milliseconds.
     * @returns A short local date-time.
     */
    function formatLocalTime(epoch) {
      try {
        return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(epoch))
      } catch {
        return new Date(epoch).toISOString()
      }
    }

    /**
     * The browser's IANA time zone, when available.
     * @returns A zone name or undefined.
     */
    function browserTimeZone() {
      try {
        const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
        return typeof zone === 'string' && zone !== '' ? zone : undefined
      } catch {
        return undefined
      }
    }

    /** @returns A fresh send identity. */
    function mintId() {
      const cryptoApi = globalThis.crypto
      if (cryptoApi !== undefined && typeof cryptoApi.randomUUID === 'function') return cryptoApi.randomUUID()
      return `ss-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
    }

    /**
     * Parse one command row's JSON payload.
     * @param rawArgs - `CommandNode.args`.
     * @returns The payload fields, or undefined when unparsable.
     */
    function parseArgs(rawArgs) {
      if (typeof rawArgs !== 'string') return undefined
      try {
        const value = JSON.parse(rawArgs)
        if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
        if (typeof value.id !== 'string' || !Number.isSafeInteger(value.at) || typeof value.text !== 'string') return undefined
        return { id: value.id, at: value.at, text: value.text }
      } catch {
        return undefined
      }
    }

    /**
     * First meaningful line of a message, for compact previews.
     * @param text - full message.
     * @returns A truncated single line.
     */
    function previewOf(text) {
      const line = text.split('\n').map(part => part.trim()).find(part => part !== '') ?? ''
      return line.length > 140 ? `${line.slice(0, 140)}…` : line
    }

    /**
     * Run one Host command and normalize its outcome.
     * @param ctx - client context.
     * @param sessionId - target session.
     * @param line - complete command line.
     * @returns Normalized success or failure.
     */
    async function runCommand(ctx, sessionId, line) {
      try {
        const result = await ctx.remote.commands.execute(sessionId, line, [])
        if (result === null || typeof result !== 'object') {
          return { ok: false, message: 'command execution is unavailable' }
        }
        if (result.ok !== true) {
          const failure = result.error ?? {}
          return { ok: false, message: failure.message || failure.code || 'command failed' }
        }
        const execution = result.value
        if (execution === undefined || execution === null) return { ok: false, message: 'unknown command' }
        const outcome = execution.result
        if (outcome !== undefined && outcome !== null && outcome.kind === 'success') {
          return { ok: true, text: outcome.text ?? '' }
        }
        return { ok: false, message: (outcome === null || outcome === undefined ? '' : outcome.text) || 'command failed' }
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) }
      }
    }

    /** The composer tool-row control and its schedule popover. */
    function ScheduleSendControl(props) {
      const translate = typeof props.t === 'function' ? props.t : key => key
      const readInput = typeof props.useInput === 'function' ? props.useInput : null
      const inputActions = props.inputActions
      const scheduleSend = typeof props.scheduleSend === 'function' ? props.scheduleSend : null
      const draft = readInput === null ? '' : readInput(snapshot => snapshot.draft)
      const attachmentIds = readInput === null ? [] : readInput(snapshot => snapshot.attachmentIds)
      const [open, setOpen] = useState(false)
      const [openedAt, setOpenedAt] = useState(0)
      const [picked, setPicked] = useState(Number.NaN)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      const [notice, setNotice] = useState('')
      const rootRef = useRef(null)
      const triggerRef = useRef(null)
      const panelRef = useRef(null)
      const noticeRef = useRef(null)

      const panelPosition = useAnchoredAbove(open, triggerRef, panelRef)
      const noticePosition = useAnchoredAbove(notice !== '', triggerRef, noticeRef)
      const close = useCallback(() => { setOpen(false) }, [])
      useOutsideDismiss(rootRef, open, close, panelRef)

      const hasAttachments = Array.isArray(attachmentIds) && attachmentIds.length > 0
      const empty = draft.trim() === ''
      const disabled = empty || hasAttachments || scheduleSend === null

      useEffect(() => {
        if (!open) return undefined
        const onKeyDown = event => {
          if (event.key !== 'Escape') return
          event.preventDefault()
          setOpen(false)
          if (triggerRef.current !== null) triggerRef.current.focus()
        }
        document.addEventListener('keydown', onKeyDown)
        return () => { document.removeEventListener('keydown', onKeyDown) }
      }, [open])

      useEffect(() => {
        if (notice === '') return undefined
        const timer = setTimeout(() => { setNotice('') }, 5000)
        return () => { clearTimeout(timer) }
      }, [notice])

      useEffect(() => {
        if (open && empty && !busy) setOpen(false)
      }, [open, empty, busy])

      const presets = useMemo(() => {
        const base = openedAt === 0 ? Date.now() : openedAt
        const tomorrow = new Date(base)
        tomorrow.setDate(tomorrow.getDate() + 1)
        tomorrow.setHours(9, 0, 0, 0)
        return [
          ...PRESETS.map(preset => ({ id: preset.id, key: preset.key, at: base + preset.offsetMs })),
          { id: 'tomorrow', key: 'preset.tomorrow', at: tomorrow.getTime() },
        ]
      }, [openedAt])

      const toggle = () => {
        if (open) {
          setOpen(false)
          return
        }
        setOpenedAt(Date.now())
        setPicked(Number.NaN)
        setError('')
        setOpen(true)
      }

      const valid = Number.isFinite(picked) && picked > Date.now() + 1000

      const confirm = async () => {
        if (!valid || busy || scheduleSend === null) return
        setBusy(true)
        setError('')
        try {
          const zone = browserTimeZone()
          const result = await scheduleSend({
            v: 1,
            id: mintId(),
            at: picked,
            text: draft,
            ...(zone === undefined ? {} : { tz: zone }),
          })
          if (!result.ok) {
            setError(result.message || translate('error.generic'))
            return
          }
          if (inputActions !== undefined && typeof inputActions.setDraft === 'function') inputActions.setDraft('')
          setOpen(false)
          setNotice(translate('toast.scheduled', { time: formatLocalTime(picked) }))
        } finally {
          setBusy(false)
        }
      }

      const triggerTitle = scheduleSend === null
        ? translate('error.unavailable')
        : hasAttachments ? translate('trigger.attachments')
        : empty ? translate('trigger.empty') : translate('trigger.label')

      return h('div', { ref: rootRef, style: { position: 'relative', display: 'inline-flex' } },
        h('button', {
          ref: triggerRef,
          type: 'button',
          'aria-label': translate('trigger.label'),
          'aria-haspopup': 'dialog',
          'aria-expanded': open,
          title: triggerTitle,
          disabled,
          onClick: toggle,
          style: {
            ...STYLES.trigger,
            ...(open ? { background: 'var(--dsw-alias-interactive-bg-hover)' } : null),
            ...(disabled ? { opacity: 0.4, cursor: 'not-allowed' } : null),
          },
        }, h(AlarmClockIcon, { size: 16 })),
        open ? createPortal(
          h('div', {
            ref: panelRef,
            role: 'dialog',
            'aria-label': translate('panel.title'),
            style: {
              ...STYLES.panel,
              ...(panelPosition === null ? { left: 0, top: 0, visibility: 'hidden' } : panelPosition),
            },
          },
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: 2 } },
            h('div', { style: STYLES.title }, translate('panel.title')),
            h('div', { style: STYLES.muted }, translate('panel.subtitle')),
          ),
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
            h('div', { style: STYLES.muted }, translate('panel.draft')),
            h('div', { style: STYLES.draftBox }, draft),
          ),
          h('div', { style: STYLES.chips }, presets.map(preset => h('button', {
            key: preset.id,
            type: 'button',
            onClick: () => { setPicked(preset.at); setError('') },
            style: {
              ...STYLES.chip,
              ...(Number.isFinite(picked) && Math.abs(picked - preset.at) < 1000 ? STYLES.chipActive : null),
            },
          }, translate(preset.key)))),
          h('label', { style: STYLES.label },
            h('span', { style: STYLES.muted }, translate('panel.custom')),
            h('input', {
              type: 'datetime-local',
              value: Number.isFinite(picked) ? localInputValue(picked) : '',
              min: localInputValue(openedAt === 0 ? Date.now() : openedAt),
              onChange: event => {
                setPicked(parseLocalInput(event.target.value))
                setError('')
              },
              style: STYLES.input,
            }),
          ),
          hasAttachments ? h('div', { style: STYLES.warning }, translate('panel.attachments')) : null,
          h('div', { style: valid ? STYLES.muted : STYLES.warning },
            valid ? translate('panel.sendAt', { time: formatLocalTime(picked) }) : translate('panel.invalid')),
          error === '' ? null : h('div', { style: STYLES.error }, error),
          h('div', { style: STYLES.footer },
            h(ActionButton, { variant: 'ghost', disabled: busy, onClick: close }, translate('panel.cancel')),
            h(ActionButton, { variant: 'primary', disabled: !valid || busy, onClick: confirm },
              busy ? translate('panel.sending') : translate('panel.confirm')),
          ),
          ), document.body) : null,
        notice === '' ? null : createPortal(
          h('div', {
            ref: noticeRef,
            role: 'status',
            style: {
              ...STYLES.notice,
              ...(noticePosition === null ? { left: 0, top: 0, visibility: 'hidden' } : noticePosition),
            },
          }, notice),
          document.body,
        ),
      )
    }

    /** One queued send's persistent card, with its cancellation control. */
    function ScheduleSendCard(props) {
      const translate = typeof props.t === 'function' ? props.t : key => key
      const node = props.node
      const scheduleCancel = typeof props.scheduleCancel === 'function' ? props.scheduleCancel : null
      const rawArgs = node === null || node === undefined
        ? undefined
        : (node.args ?? node.rawInput ?? node.input)
      const payload = useMemo(() => parseArgs(rawArgs), [rawArgs])
      const [state, setState] = useState({ kind: 'idle' })
      if (payload === undefined) return null
      const outcome = node === null || node === undefined ? undefined : node.outcome
      const failed = outcome !== undefined && outcome !== null && outcome.kind === 'error'
      const cancel = async () => {
        if (scheduleCancel === null) {
          setState({ kind: 'error', message: translate('error.unavailable') })
          return
        }
        setState({ kind: 'cancelling' })
        const result = await scheduleCancel(payload.id)
        if (result.ok) {
          setState({ kind: 'cancelled' })
          return
        }
        const message = result.message || ''
        if (/no longer|already|left the queue|being delivered/i.test(message)) {
          setState({ kind: 'sent' })
          return
        }
        setState({ kind: 'error', message })
      }
      const status = failed
        ? ((outcome === null || outcome === undefined ? '' : outcome.text) || translate('card.cancelError'))
        : state.kind === 'cancelled' ? translate('card.cancelled')
        : state.kind === 'sent' ? translate('card.sent')
        : state.kind === 'error' ? translate('card.cancelFailed', { message: state.message })
        : translate('card.pending')
      const showCancel = outcome !== undefined && outcome !== null && !failed
        && state.kind !== 'cancelled' && state.kind !== 'sent' && state.kind !== 'error'
      return h('div', { style: STYLES.card },
        h('div', { style: STYLES.cardHeader },
          h(AlarmClockIcon, { size: 14 }),
          h('span', { style: { fontWeight: 600 } }, translate('card.title')),
          h('span', { style: STYLES.muted }, formatLocalTime(payload.at)),
        ),
        h('div', { style: { overflowWrap: 'anywhere' } }, previewOf(payload.text)),
        h('div', { style: failed ? STYLES.error : STYLES.muted }, status),
        showCancel
          ? h('div', { style: STYLES.cardActions },
            h(ActionButton, {
              variant: 'outline',
              disabled: state.kind === 'cancelling',
              onClick: cancel,
            }, state.kind === 'cancelling' ? translate('card.cancelling') : translate('card.cancel')),
          )
          : null,
      )
    }

    /** Quiet row for the cancellation command, replacing the generic JSON card. */
    function ScheduleCancelCard(props) {
      const translate = typeof props.t === 'function' ? props.t : key => key
      const node = props.node
      const outcome = node === null || node === undefined ? undefined : node.outcome
      const failed = outcome !== undefined && outcome !== null && outcome.kind === 'error'
      return h('div', {
        style: {
          ...STYLES.card,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 6,
          color: 'var(--dsw-alias-label-secondary)',
          fontSize: 12,
        },
      },
      h(AlarmClockIcon, { size: 14 }),
      h('span', null, failed
        ? ((outcome === null || outcome === undefined ? '' : outcome.text) || translate('card.cancelError'))
        : translate('card.cancelTitle')),
      )
    }

    return {
      inject: ['slots', 'locale', 'remote', 'remote.commands'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-schedule-send: dictionaries')

        ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
          name: 'conversation.input.right',
          id: 'schedule-send',
          order: 10,
          locale: NS,
          inject: sessionId => ({
            scheduleSend: payload => runCommand(ctx, sessionId, `/schedule-send ${JSON.stringify(payload)}`),
          }),
        }, ScheduleSendControl))

        ctx.slots.inject('conversation.chat.commandview', () => ctx.slots.register({
          name: 'conversation.chat.commandview',
          key: 'schedule-send',
          locale: NS,
          inject: sessionId => ({
            scheduleCancel: id => runCommand(ctx, sessionId, `/schedule-send-cancel ${JSON.stringify({ v: 1, id })}`),
          }),
        }, ScheduleSendCard))

        ctx.slots.inject('conversation.chat.commandview', () => ctx.slots.register({
          name: 'conversation.chat.commandview',
          key: 'schedule-send-cancel',
          locale: NS,
        }, ScheduleCancelCard))
      },
    }
  },
})
