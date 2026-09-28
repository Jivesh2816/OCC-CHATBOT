import React, { useCallback, useEffect, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Inbox, Lock, LogOut, RefreshCw, Send, LoaderCircle, Ticket, ArrowLeft, Siren } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Textarea } from '@/components/ui/textarea'
import { staffApi, errorMessage, normalizeCitations } from '@/lib/api'
import { cn } from '@/lib/utils'

const TOKEN_KEY = 'occ_staff_token'
const STATUSES = ['open', 'escalated', 'in_progress', 'resolved']
const STATUS_LABEL = { open: 'Open', escalated: 'Escalated', in_progress: 'In progress', resolved: 'Resolved' }

function timeAgo(iso) {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  if (minutes < 1440) return `${Math.round(minutes / 60)}h ago`
  return `${Math.round(minutes / 1440)}d ago`
}

function StatusBadge({ ticket }) {
  if (ticket.status === 'resolved') return <Badge>Resolved</Badge>
  if (ticket.escalated && ticket.status !== 'in_progress') return <Badge variant="destructive">Escalated</Badge>
  return <Badge variant={ticket.status === 'in_progress' ? 'primary' : 'default'}>{STATUS_LABEL[ticket.status] || ticket.status}</Badge>
}

function Login({ onLogin, error }) {
  const [value, setValue] = useState('')
  return (
    <form
      onSubmit={e => { e.preventDefault(); if (value.trim()) onLogin(value.trim()) }}
      className="mx-auto mt-24 flex w-full max-w-sm flex-col gap-3 rounded-2xl border border-border bg-panel p-6 shadow-glow"
    >
      <div className="flex items-center gap-2 text-[16px] font-semibold"><Lock className="h-4 w-4 text-primary" /> Staff sign-in</div>
      <p className="text-[12.5px] leading-relaxed text-muted-foreground">Enter the staff token configured on the server (<code className="font-mono">STAFF_TOKEN</code>).</p>
      <input
        type="password"
        value={value}
        onChange={e => setValue(e.target.value)}
        className="h-10 rounded-xl border border-border bg-background/50 px-3 text-[14px] outline-none focus:border-primary"
        placeholder="Staff token"
        autoFocus
      />
      {error && <p className="text-[12.5px] text-destructive">{error}</p>}
      <button type="submit" className="h-10 rounded-xl text-[14px] font-medium text-white" style={{ background: 'var(--gradient-brand)' }}>Sign in</button>
    </form>
  )
}

function TicketDetail({ api, ticketId, onChanged, onBack }) {
  const [data, setData] = useState(null)
  const [reply, setReply] = useState('')
  const [author, setAuthor] = useState(() => { try { return localStorage.getItem('occ_staff_name') || '' } catch { return '' } })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const load = useCallback(() => {
    api.ticket(ticketId).then(setData).catch(err => setError(errorMessage(err, 'Could not load ticket')))
  }, [api, ticketId])

  useEffect(() => { setData(null); load() }, [load])

  const send = async () => {
    setBusy(true)
    setError(null)
    try {
      try { localStorage.setItem('occ_staff_name', author) } catch { /* best-effort */ }
      await api.reply(ticketId, reply, author || undefined)
      setReply('')
      load()
      onChanged()
    } catch (err) {
      setError(errorMessage(err, 'Reply failed'))
    } finally {
      setBusy(false)
    }
  }

  const setStatus = async status => {
    try {
      await api.setStatus(ticketId, status)
      load()
      onChanged()
    } catch (err) {
      setError(errorMessage(err, 'Status change failed'))
    }
  }

  if (!data) return <div className="flex flex-1 items-center justify-center p-10 text-muted-foreground"><LoaderCircle className="h-5 w-5 animate-spin" /></div>
  const { ticket, conversation, criticLog } = data

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-4 overflow-y-auto p-5">
      <button onClick={onBack} className="inline-flex items-center gap-1 text-[12.5px] text-muted-foreground md:hidden"><ArrowLeft className="h-3.5 w-3.5" /> All tickets</button>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-[13px] font-medium">{ticket.id}</span>
        <StatusBadge ticket={ticket} />
        <Badge>{ticket.priority}</Badge>
        <Badge>{ticket.category}</Badge>
        <span className="ml-auto text-[11.5px] text-muted-foreground">{new Date(ticket.created_at).toLocaleString()}</span>
      </div>
      <p className="text-[14px] leading-relaxed">{ticket.summary}</p>
      {ticket.escalation_reason && (
        <div className="flex gap-2 rounded-xl border border-destructive/30 bg-destructive/5 px-3 py-2 text-[12.5px] text-destructive">
          <Siren className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {ticket.escalation_reason}
        </div>
      )}

      <div className="flex flex-wrap gap-1.5">
        {STATUSES.map(s => (
          <Button key={s} size="sm" variant={ticket.status === s ? 'default' : 'outline'} className="rounded-full" onClick={() => setStatus(s)} disabled={ticket.status === s}>
            {STATUS_LABEL[s]}
          </Button>
        ))}
      </div>

      {ticket.emails?.length > 0 && (
        <section className="flex flex-col gap-2">
          <h3 className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-muted-foreground">Follow-up drafts (not sent — review and send yourself if useful)</h3>
          {ticket.emails.map((email, i) => (
            <div key={i} className="rounded-xl border border-border bg-card/60 px-3 py-2 text-[12.5px] leading-relaxed">
              <div className="font-medium">{email.office || email.to} · {email.subject}</div>
              <div className="mt-1 whitespace-pre-line text-muted-foreground">{email.body}</div>
            </div>
          ))}
        </section>
      )}

      <section className="flex flex-col gap-2">
        <h3 className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-muted-foreground">Student conversation</h3>
        <div className="flex flex-col gap-2 rounded-2xl border border-border bg-card/60 p-3">
          {conversation.map(m => (
            <div key={m.id} className={cn('rounded-xl px-3 py-2 text-[13px] leading-relaxed', m.role === 'user' ? 'self-end bg-muted' : m.role === 'staff' ? 'border border-primary/30 bg-primary/5' : 'bg-panel')}>
              <div className="mb-0.5 font-mono text-[10px] uppercase text-muted-foreground">{m.role} · {timeAgo(m.timestamp)}</div>
              <div className="prose prose-sm max-w-none prose-p:my-1"><ReactMarkdown remarkPlugins={[remarkGfm]}>{normalizeCitations(m.content)}</ReactMarkdown></div>
            </div>
          ))}
          {conversation.length === 0 && <p className="text-[12.5px] text-muted-foreground">No messages stored for this session.</p>}
        </div>
      </section>

      {criticLog.length > 0 && (
        <section className="flex flex-col gap-2">
          <h3 className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-muted-foreground">Critic decisions</h3>
          <div className="flex flex-col gap-1.5">
            {criticLog.map(entry => (
              <div key={entry.id} className="rounded-lg bg-muted px-3 py-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
                <span className="text-foreground/80">{entry.intent || 'no intent'}</span> · {entry.reasoning}
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="flex flex-col gap-2">
        <h3 className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-muted-foreground">Reply to student</h3>
        <input
          value={author}
          onChange={e => setAuthor(e.target.value)}
          placeholder="Your name as shown to the student (e.g. Sam, OCC)"
          className="h-9 rounded-xl border border-border bg-panel px-3 text-[13px] outline-none focus:border-primary"
        />
        <Textarea
          rows={3}
          value={reply}
          onChange={e => setReply(e.target.value)}
          placeholder="Appears in the student's chat within a few seconds…"
          className="rounded-xl border border-border bg-panel px-3 py-2 text-[13.5px]"
        />
        {error && <p className="text-[12.5px] text-destructive">{error}</p>}
        <Button className="self-end rounded-full" onClick={send} disabled={busy || !reply.trim()}>
          {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Send reply
        </Button>
      </section>
    </div>
  )
}

export default function StaffDashboard() {
  const [token, setToken] = useState(() => { try { return sessionStorage.getItem(TOKEN_KEY) || '' } catch { return '' } })
  const [tickets, setTickets] = useState(null)
  const [selected, setSelected] = useState(null)
  const [error, setError] = useState(null)
  const [filter, setFilter] = useState('active')

  const api = React.useMemo(() => staffApi(token), [token])

  const refresh = useCallback(() => {
    if (!token) return
    api.tickets().then(t => { setTickets(t); setError(null) }).catch(err => {
      if (err?.response?.status === 401) {
        try { sessionStorage.removeItem(TOKEN_KEY) } catch { /* best-effort */ }
        setToken('')
      }
      setError(errorMessage(err, 'Could not load tickets'))
    })
  }, [api, token])

  useEffect(() => {
    refresh()
    const id = setInterval(refresh, 15000)
    return () => clearInterval(id)
  }, [refresh])

  const login = value => {
    try { sessionStorage.setItem(TOKEN_KEY, value) } catch { /* best-effort */ }
    setError(null)
    setToken(value)
  }
  const logout = () => {
    try { sessionStorage.removeItem(TOKEN_KEY) } catch { /* best-effort */ }
    setToken('')
    setTickets(null)
    setSelected(null)
  }

  const visible = (tickets || []).filter(t => filter === 'all' || (filter === 'active' ? t.status !== 'resolved' : t.escalated && t.status !== 'resolved'))

  return (
    <div className="flex h-dvh w-full flex-col overflow-hidden text-foreground">
      <header className="flex shrink-0 items-center gap-2.5 border-b border-border/70 bg-background/75 px-4 py-3 backdrop-blur-md md:px-6">
        <span className="flex h-8 w-8 items-center justify-center rounded-full text-white shadow-glow" style={{ background: 'var(--gradient-brand)' }}><Inbox className="h-4 w-4" /></span>
        <span className="font-serif text-[16px] font-medium tracking-tight">OCC Staff Queue</span>
        <a href="#/" className="ml-3 text-[12.5px] text-muted-foreground hover:text-foreground">← Student chat</a>
        {token && (
          <div className="ml-auto flex items-center gap-1.5">
            <Button variant="ghost" size="sm" className="rounded-full text-muted-foreground" onClick={refresh}><RefreshCw className="h-4 w-4" /></Button>
            <Button variant="ghost" size="sm" className="gap-1.5 rounded-full text-muted-foreground" onClick={logout}><LogOut className="h-4 w-4" /> Sign out</Button>
          </div>
        )}
      </header>

      {!token ? (
        <Login onLogin={login} error={error} />
      ) : (
        <div className="flex min-h-0 flex-1">
          <aside className={cn('flex w-full shrink-0 flex-col border-r border-border/70 md:w-[340px]', selected && 'hidden md:flex')}>
            <div className="flex gap-1 p-3">
              {[['active', 'Active'], ['escalated', 'Escalated'], ['all', 'All']].map(([key, label]) => (
                <button key={key} onClick={() => setFilter(key)} className={cn('rounded-full px-3 py-1 text-[12px]', filter === key ? 'bg-foreground text-background' : 'text-muted-foreground hover:bg-accent')}>
                  {label}
                </button>
              ))}
            </div>
            <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto px-3 pb-3">
              {error && <p className="px-1 text-[12.5px] text-destructive">{error}</p>}
              {tickets === null && !error && <LoaderCircle className="mx-auto mt-8 h-5 w-5 animate-spin text-muted-foreground" />}
              {tickets && visible.length === 0 && <p className="px-1 pt-4 text-[12.5px] text-muted-foreground">Nothing here.</p>}
              {visible.map(t => (
                <button
                  key={t.id}
                  onClick={() => setSelected(t.id)}
                  className={cn('flex flex-col gap-1 rounded-xl border px-3 py-2.5 text-left transition-colors', selected === t.id ? 'border-primary/50 bg-primary/5' : 'border-border bg-panel hover:bg-accent')}
                >
                  <div className="flex items-center gap-2">
                    <Ticket className="h-3 w-3 text-muted-foreground" />
                    <span className="font-mono text-[11.5px]">{t.id}</span>
                    <span className="ml-auto"><StatusBadge ticket={t} /></span>
                  </div>
                  <span className="line-clamp-2 text-[12.5px] leading-snug text-foreground/85">{t.summary}</span>
                  <span className="text-[11px] text-muted-foreground">{t.category} · {t.priority} · {timeAgo(t.created_at)}{t.reply_count ? ` · ${t.reply_count} repl${t.reply_count === 1 ? 'y' : 'ies'}` : ''}</span>
                </button>
              ))}
            </div>
          </aside>
          {selected ? (
            <TicketDetail key={selected} api={api} ticketId={selected} onChanged={refresh} onBack={() => setSelected(null)} />
          ) : (
            <div className="hidden flex-1 items-center justify-center text-[13px] text-muted-foreground md:flex">Select a ticket</div>
          )}
        </div>
      )}
    </div>
  )
}
