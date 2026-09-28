import React, { useRef, useState } from 'react'
import { FileSearch, Upload, X, ExternalLink, LoaderCircle, TriangleAlert, Info, Send, Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Textarea } from '@/components/ui/textarea'
import { api, errorMessage } from '@/lib/api'

const MAX_PDF_BYTES = 3 * 1024 * 1024 // stays under Vercel's 4.5 MB body cap once base64-encoded

const SAMPLE_LEASE = `1. Rent is $950 per month, due on the first of each month.
2. A last month's rent deposit of $950 and a damage deposit of $300 are due at signing.
3. No pets are allowed on the property.
4. Overnight guests are not permitted.
5. Rent received after the 3rd is subject to a $50 late fee.
6. Tenant is responsible for all repairs and maintenance of appliances.
7. The landlord may enter the unit at any time to inspect.
8. The tenant must pay for damage caused by the tenant or their guests.`

function readAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',')[1])
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

function SourceLinks({ sources }) {
  if (!sources?.length) return null
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1">
      {sources.map(s => (
        <a key={s.id} href={s.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[11.5px] font-medium text-primary hover:underline">
          {s.publisher}: {s.title} <ExternalLink className="h-3 w-3" />
        </a>
      ))}
    </div>
  )
}

function FindingCard({ finding }) {
  const isVoid = finding.severity === 'void'
  return (
    <div className="flex flex-col gap-2 rounded-2xl border border-border bg-panel p-4 shadow-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={isVoid ? 'destructive' : 'default'}>{isVoid ? 'Likely unenforceable' : 'Worth checking'}</Badge>
        <span className="text-[14px] font-semibold">{finding.title}</span>
        <span className="ml-auto font-mono text-[10.5px] text-muted-foreground">clause {finding.clauseNumber} · found by {finding.detectedBy.join(' + ')}</span>
      </div>
      <blockquote className="border-l-2 border-primary/50 pl-3 text-[13px] italic leading-relaxed text-foreground/85">“{finding.quote}”</blockquote>
      <p className="text-[13px] leading-relaxed text-muted-foreground">{finding.explanation}</p>
      <SourceLinks sources={finding.sources} />
    </div>
  )
}

export default function LeaseChecker({ sessionId, onSessionId, onTicketCreated }) {
  const [text, setText] = useState('')
  const [file, setFile] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [result, setResult] = useState(null)
  const [ticket, setTicket] = useState(null)
  const [sending, setSending] = useState(false)
  const fileRef = useRef(null)

  const pickFile = e => {
    const f = e.target.files?.[0]
    e.target.value = ''
    if (!f) return
    if (f.type !== 'application/pdf') return setError('Please choose a PDF file, or paste the text instead.')
    if (f.size > MAX_PDF_BYTES) return setError('That PDF is over 3 MB. Paste the text instead.')
    setError(null)
    setFile(f)
  }

  const analyze = async () => {
    setLoading(true)
    setError(null)
    setResult(null)
    setTicket(null)
    try {
      const body = file ? { pdfBase64: await readAsBase64(file) } : { text }
      setResult(await api.checkLease(body))
    } catch (err) {
      setError(errorMessage(err, 'Could not analyze that lease. Try again in a moment.'))
    } finally {
      setLoading(false)
    }
  }

  const sendToAdvisor = async () => {
    setSending(true)
    try {
      const res = await api.escalateLease({ sessionId, findings: result.findings })
      if (res.sessionId !== sessionId) onSessionId?.(res.sessionId)
      setTicket(res.ticketId)
      onTicketCreated?.()
    } catch (err) {
      setError(errorMessage(err, 'Could not send it to an advisor.'))
    } finally {
      setSending(false)
    }
  }

  const canSubmit = !loading && (file || text.trim().length >= 50)
  const voidCount = result?.summary.void || 0
  const checkCount = result?.summary.check || 0

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-5 px-5 py-6 md:px-0">
      <div className="flex flex-col gap-1.5">
        <h2 className="flex items-center gap-2 text-[22px] font-semibold tracking-tight">
          <FileSearch className="h-5 w-5 text-primary" /> Lease <span className="font-serif italic font-medium text-gradient-brand">Checker</span>
        </h2>
        <p className="text-[13.5px] leading-relaxed text-muted-foreground">
          Paste your lease or upload the PDF. Each clause is checked against official Ontario and UW Off-Campus Housing guidance on terms a lease can&rsquo;t enforce — every flag links to the page it&rsquo;s based on.
        </p>
      </div>

      <div className="flex flex-col gap-3 rounded-2xl border border-border bg-panel p-4 shadow-sm">
        {file ? (
          <div className="flex items-center gap-2 rounded-xl bg-muted px-3 py-2.5 text-[13px]">
            <FileSearch className="h-4 w-4 text-primary" />
            <span className="truncate font-medium">{file.name}</span>
            <span className="text-muted-foreground">{(file.size / 1024).toFixed(0)} KB</span>
            <button className="ml-auto rounded-md p-1 hover:bg-accent" onClick={() => setFile(null)} aria-label="Remove file"><X className="h-3.5 w-3.5" /></button>
          </div>
        ) : (
          <Textarea
            rows={8}
            value={text}
            onChange={e => setText(e.target.value)}
            placeholder="Paste the lease text here…"
            className="max-h-[320px] min-h-[160px] rounded-xl border border-border bg-background/40 px-3 py-2 text-[13.5px]"
          />
        )}
        <div className="flex flex-wrap items-center gap-2">
          <input ref={fileRef} type="file" accept="application/pdf" className="hidden" onChange={pickFile} />
          <Button variant="outline" size="sm" className="rounded-full" onClick={() => fileRef.current?.click()}>
            <Upload className="h-3.5 w-3.5" /> Upload PDF
          </Button>
          {!file && !text && (
            <Button variant="ghost" size="sm" className="rounded-full text-muted-foreground" onClick={() => setText(SAMPLE_LEASE)}>
              Try a sample lease
            </Button>
          )}
          <button
            onClick={analyze}
            disabled={!canSubmit}
            className="ml-auto inline-flex h-9 items-center gap-2 rounded-full px-4 text-[13px] font-medium text-white transition-transform disabled:cursor-not-allowed disabled:opacity-40 enabled:hover:scale-[1.03]"
            style={{ background: 'var(--gradient-brand)' }}
          >
            {loading ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <FileSearch className="h-4 w-4" />}
            {loading ? 'Reading clauses…' : 'Check my lease'}
          </button>
        </div>
      </div>

      {error && <div className="rounded-xl border border-destructive/40 bg-destructive/5 px-3 py-2.5 text-[13px] text-destructive">{error}</div>}

      {result && (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2 text-[13px]">
            {voidCount > 0 ? (
              <span className="inline-flex items-center gap-1.5 font-semibold text-destructive"><TriangleAlert className="h-4 w-4" /> {voidCount} clause{voidCount === 1 ? '' : 's'} likely unenforceable</span>
            ) : (
              <span className="inline-flex items-center gap-1.5 font-semibold text-emerald-700"><Check className="h-4 w-4" /> No clearly void clauses found</span>
            )}
            {checkCount > 0 && <span className="text-muted-foreground">· {checkCount} worth checking</span>}
            <span className="ml-auto font-mono text-[10.5px] text-muted-foreground">
              {result.summary.clauses} clauses{result.pages ? ` · ${result.pages} page${result.pages === 1 ? '' : 's'}` : ''} · model reviewed {result.summary.modelReviewedClauses}
            </span>
          </div>
          {(result.summary.modelError || result.truncated || result.summary.modelReviewedClauses < result.summary.clauses) && (
            <div className="flex gap-2 rounded-xl bg-muted px-3 py-2 text-[12px] text-muted-foreground">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {result.summary.modelError
                ? 'The AI review was unavailable, so only the rule-based checks ran.'
                : 'This lease is long: rule-based checks covered all of it, the AI review covered the first part.'}
            </div>
          )}
          {result.findings.map(f => <FindingCard key={`${f.ruleId}-${f.clauseNumber}`} finding={f} />)}

          {result.findings.length > 0 && (
            <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-dashed border-border px-4 py-3">
              <p className="min-w-0 flex-1 text-[12.5px] leading-relaxed text-muted-foreground">
                Want a person to look at this? It opens a ticket with the flagged clauses for the Off-Campus team.
              </p>
              {ticket ? (
                <Badge variant="primary"><Check className="h-3 w-3" /> Sent · {ticket}</Badge>
              ) : (
                <Button size="sm" variant="outline" className="rounded-full" onClick={sendToAdvisor} disabled={sending}>
                  {sending ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />} Send to an advisor
                </Button>
              )}
            </div>
          )}
          <p className="text-center text-[11px] leading-relaxed text-muted-foreground/70">
            General information, not legal advice. For a binding answer, contact Waterloo Region Community Legal Services or the Landlord and Tenant Board.
          </p>
        </div>
      )}
    </div>
  )
}
