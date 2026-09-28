import React, { useState } from 'react'
import { Route, ShieldCheck, BookOpen, Wrench, Gavel, LoaderCircle, Check, CircleMinus, ChevronDown, Brain } from 'lucide-react'
import { cn } from '@/lib/utils'

// The five pipeline stages, in the order the backend runs them.
const STAGES = [
  { key: 'router', label: 'Router', icon: Route },
  { key: 'critic_pre', label: 'Safety pre-check', icon: ShieldCheck },
  { key: 'retrieval', label: 'Retrieve & answer', icon: BookOpen },
  { key: 'action', label: 'Action agent', icon: Wrench },
  { key: 'critic', label: 'Critic', icon: Gavel }
]

const FLAG_LABELS = {
  safetyOverride: 'safety override',
  lowConfidence: 'low confidence',
  policySensitive: 'legal disclaimer added',
  escalationOverride: 'forced escalation',
  uncited: 'no citation — caution note added'
}

function describe(step) {
  if (!step) return null
  if (step.status === 'running') return 'working…'
  if (step.status === 'skipped') return step.reason
  switch (step.stage) {
    case 'router':
      if (!step.intent) return 'classification failed — answered without routing'
      return [
        `${step.intent.replace(/_/g, ' ')} · ${Math.round((step.confidence ?? 0) * 100)}% confident`,
        step.incident === true ? 'specific incident' : step.incident === false ? 'general question' : null,
        step.usedMemory ? 'used earlier turns' : null
      ].filter(Boolean).join(' · ')
    case 'critic_pre':
      return step.override ? 'safety phrase matched → forced to urgent' : 'no safety phrases found'
    case 'retrieval': {
      if (step.skipped) return step.skipped
      const parts = [`${step.faqs?.length || 0} FAQ${step.faqs?.length === 1 ? '' : 's'}`, `${step.sources?.length || 0} official passage${step.sources?.length === 1 ? '' : 's'}`]
      if (step.groqFailed) parts.push('model unavailable → keyword fallback')
      return parts.join(' · ')
    }
    case 'action':
      if (!step.actions?.length) return 'decided no follow-up was needed'
      return step.actions.map(a => `${a.tool.replace(/_/g, ' ')}${a.ticketId ? ` (${a.ticketId})` : ''}`).join(', ')
    case 'critic': {
      const fired = Object.entries(step.flags || {}).filter(([, v]) => v).map(([k]) => FLAG_LABELS[k] || k)
      return fired.length ? fired.join(' · ') : 'all checks passed'
    }
    default:
      return null
  }
}

function StepIcon({ status }) {
  if (status === 'running') return <LoaderCircle className="h-3.5 w-3.5 animate-spin text-primary" />
  if (status === 'skipped') return <CircleMinus className="h-3.5 w-3.5 text-muted-foreground/60" />
  if (status === 'done') return <Check className="h-3.5 w-3.5 text-emerald-600" />
  return <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/30" />
}

// `steps` is keyed by stage. `live` keeps it expanded while the answer streams.
export default function AgentTrace({ steps = {}, live = false, memoryTurns = 0 }) {
  const [open, setOpen] = useState(false)
  const expanded = live || open
  const done = STAGES.map(s => steps[s.key]).filter(s => s && s.status !== 'running')
  const totalMs = done.reduce((sum, s) => sum + (s.ms || 0), 0)

  return (
    <div className="mt-2 rounded-xl border border-border/80 bg-card/60 text-[12px]">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        disabled={live}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-muted-foreground disabled:cursor-default"
      >
        <Brain className="h-3.5 w-3.5 text-primary" />
        <span className="font-medium text-foreground/80">{live ? 'Working through the pipeline' : 'How I got this answer'}</span>
        {!live && <span className="font-mono text-[10.5px]">{done.length} steps · {(totalMs / 1000).toFixed(1)}s</span>}
        {memoryTurns > 0 && <span className="rounded-full bg-accent px-1.5 py-0.5 font-mono text-[10px]">memory: {memoryTurns} earlier message{memoryTurns === 1 ? '' : 's'}</span>}
        {!live && <ChevronDown className={cn('ml-auto h-3.5 w-3.5 transition-transform', expanded && 'rotate-180')} />}
      </button>
      {expanded && (
        <ol className="flex flex-col gap-1.5 border-t border-border/70 px-3 py-2.5">
          {STAGES.map(({ key, label, icon: Icon }) => {
            const step = steps[key]
            return (
              <li key={key} className={cn('flex items-start gap-2', !step && 'opacity-45')}>
                <span className="mt-0.5 flex w-4 justify-center"><StepIcon status={step?.status} /></span>
                <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className="w-[108px] shrink-0 font-medium text-foreground/80">{label}</span>
                <span className="min-w-0 flex-1 text-muted-foreground">{describe(step) || '—'}</span>
                {step?.ms != null && step.status === 'done' && <span className="shrink-0 font-mono text-[10.5px] text-muted-foreground/70">{step.ms}ms</span>}
              </li>
            )
          })}
          {steps.critic?.reasoning && steps.critic.reasoning !== 'no critic flags raised' && (
            <li className="mt-1 rounded-md bg-muted px-2 py-1.5 font-mono text-[10.5px] leading-relaxed text-muted-foreground">
              critic: {steps.critic.reasoning}
            </li>
          )}
        </ol>
      )}
    </div>
  )
}

// Build the keyed step map from a finished response's `trace` array.
export function stepsFromTrace(trace = []) {
  return Object.fromEntries(trace.map(step => [step.stage, step]))
}
