import React, { useState } from 'react'
import { ScanSearch, LoaderCircle, ExternalLink, ShieldAlert, ShieldCheck, TriangleAlert } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { api, errorMessage } from '@/lib/api'
import { cn } from '@/lib/utils'

const SAMPLE_LISTING = `Hi! Lovely basement unit near UW for only $550/month, utilities included. I'm currently overseas for work so I can't show it in person, but I can mail you the keys. Lots of students are interested so act fast — to hold it, send a $550 deposit by Western Union today.`

const RISK = {
  high: { label: 'High risk', tone: 'text-destructive', bar: 'bg-destructive', icon: ShieldAlert, blurb: 'Several strong scam signs. Don\'t send money.' },
  medium: { label: 'Some red flags', tone: 'text-amber-600', bar: 'bg-amber-500', icon: TriangleAlert, blurb: 'Proceed carefully and verify before paying anything.' },
  low: { label: 'No obvious red flags', tone: 'text-emerald-700', bar: 'bg-emerald-500', icon: ShieldCheck, blurb: 'Nothing matched — still view it in person before you pay.' }
}

export default function ScamChecker() {
  const [text, setText] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [result, setResult] = useState(null)

  const analyze = async () => {
    setLoading(true)
    setError(null)
    setResult(null)
    try {
      setResult(await api.checkListing(text))
    } catch (err) {
      setError(errorMessage(err, 'Could not check that listing. Try again in a moment.'))
    } finally {
      setLoading(false)
    }
  }

  const risk = result ? RISK[result.risk.level] : null
  const RiskIcon = risk?.icon

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-5 px-5 py-6 md:px-0">
      <div className="flex flex-col gap-1.5">
        <h2 className="flex items-center gap-2 text-[22px] font-semibold tracking-tight">
          <ScanSearch className="h-5 w-5 text-primary" /> Listing <span className="font-serif italic font-medium text-gradient-brand">Scam Check</span>
        </h2>
        <p className="text-[13.5px] leading-relaxed text-muted-foreground">
          Paste a rental ad or a landlord&rsquo;s message. It&rsquo;s checked against UW Special Constable Service&rsquo;s rental-fraud warning signs and UW Off-Campus Housing&rsquo;s typical rents.
        </p>
      </div>

      <div className="flex flex-col gap-3 rounded-2xl border border-border bg-panel p-4 shadow-sm">
        <Textarea
          rows={6}
          value={text}
          onChange={e => setText(e.target.value)}
          placeholder="Paste the listing or message here…"
          className="max-h-[280px] min-h-[130px] rounded-xl border border-border bg-background/40 px-3 py-2 text-[13.5px]"
        />
        <div className="flex items-center gap-2">
          {!text && (
            <Button variant="ghost" size="sm" className="rounded-full text-muted-foreground" onClick={() => setText(SAMPLE_LISTING)}>
              Try a sample listing
            </Button>
          )}
          <button
            onClick={analyze}
            disabled={loading || text.trim().length < 30}
            className="ml-auto inline-flex h-9 items-center gap-2 rounded-full px-4 text-[13px] font-medium text-white transition-transform disabled:cursor-not-allowed disabled:opacity-40 enabled:hover:scale-[1.03]"
            style={{ background: 'var(--gradient-brand)' }}
          >
            {loading ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <ScanSearch className="h-4 w-4" />}
            {loading ? 'Checking…' : 'Check this listing'}
          </button>
        </div>
      </div>

      {error && <div className="rounded-xl border border-destructive/40 bg-destructive/5 px-3 py-2.5 text-[13px] text-destructive">{error}</div>}

      {result && (
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-2.5 rounded-2xl border border-border bg-panel p-4 shadow-sm">
            <div className={cn('flex items-center gap-2 text-[16px] font-semibold', risk.tone)}>
              <RiskIcon className="h-5 w-5" /> {risk.label}
              <span className="ml-auto font-mono text-[10.5px] font-normal text-muted-foreground">risk score {result.risk.score}</span>
            </div>
            <div className="flex h-1.5 gap-1">
              {['low', 'medium', 'high'].map(level => (
                <span key={level} className={cn('flex-1 rounded-full', ['low', 'medium', 'high'].indexOf(level) <= ['low', 'medium', 'high'].indexOf(result.risk.level) ? risk.bar : 'bg-muted')} />
              ))}
            </div>
            <p className="text-[13px] text-muted-foreground">{risk.blurb}</p>
          </div>

          {result.signals.map(signal => (
            <div key={signal.id} className="flex flex-col gap-2 rounded-2xl border border-border bg-panel p-4 shadow-sm">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={signal.weight >= 3 ? 'destructive' : 'default'}>{signal.weight >= 3 ? 'Strong sign' : 'Warning sign'}</Badge>
                <span className="text-[14px] font-semibold">{signal.label}</span>
                <span className="ml-auto font-mono text-[10.5px] text-muted-foreground">found by {signal.detectedBy.join(' + ')}</span>
              </div>
              <blockquote className="border-l-2 border-primary/50 pl-3 text-[13px] italic leading-relaxed text-foreground/85">“{signal.quote}”</blockquote>
              <div className="flex flex-wrap gap-x-3 gap-y-1">
                {signal.sources.map(s => (
                  <a key={s.id} href={s.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[11.5px] font-medium text-primary hover:underline">
                    {s.publisher}: {s.title} <ExternalLink className="h-3 w-3" />
                  </a>
                ))}
              </div>
            </div>
          ))}

          <div className="flex flex-col gap-2 rounded-2xl border border-dashed border-border px-4 py-3">
            <div className="text-[13px] font-semibold">Before you send any money</div>
            <ul className="flex list-disc flex-col gap-1 pl-5 text-[12.5px] leading-relaxed text-muted-foreground">
              {result.nextSteps.map(step => <li key={step}>{step}</li>)}
            </ul>
            <a href={result.nextStepsSource.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[11.5px] font-medium text-primary hover:underline">
              {result.nextStepsSource.publisher}: {result.nextStepsSource.title} <ExternalLink className="h-3 w-3" />
            </a>
          </div>
          {result.modelError && <p className="text-center text-[11px] text-muted-foreground/70">The AI review was unavailable, so only the rule-based checks ran.</p>}
        </div>
      )}
    </div>
  )
}
