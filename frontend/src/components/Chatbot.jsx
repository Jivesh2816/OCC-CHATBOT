import React, { useState, useRef, useEffect } from 'react'
import axios from 'axios'
import './Chatbot.css'

const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL ||
  (typeof window !== 'undefined' && window.location.hostname === 'localhost'
    ? '/api'
    : 'https://occ-chatbot.vercel.app')

// The 6 topics promoted in the sidebar/welcome nav. Counts are fetched live
// from /topics and fall back to these known-good numbers if that call fails.
const NAV_TOPICS = [
  { name: 'Housing & Leases', hint: 'Signing, subletting, disputes', hue: 250, fallbackCount: 10, starter: "My landlord won't fix maintenance issues" },
  { name: 'Rent & Money', hint: 'Deposits, utilities, discounts', hue: 150, fallbackCount: 4, starter: 'What should I know about off-campus utilities?' },
  { name: 'Getting Around', hint: 'ION, GRT, U-Pass', hue: 285, fallbackCount: 4, starter: 'How do I get around campus and the city?' },
  { name: 'Health & Safety', hint: 'Clinics, mental health, emergencies', hue: 200, fallbackCount: 7, starter: 'What health services are available on campus?' },
  { name: 'Food & Essentials', hint: 'Groceries, food support', hue: 55, fallbackCount: 4, starter: 'I need food support - where can I get help?' },
  { name: 'Neighbours & Bylaws', hint: 'Noise, waste, parking', hue: 105, fallbackCount: 4, starter: 'What campus and municipal rules should I know?' }
]

const POPULAR_QUESTIONS = [
  "My landlord won't fix maintenance issues",
  'U-Pass not working on bus/ION',
  'What grocery stores offer student discounts?',
  'Mental health resources'
]

const TOTAL_FAQS_FALLBACK = 42

const dot = (hue) => `oklch(0.62 0.13 ${hue})`
const wash = (hue) => `oklch(0.915 0.062 ${hue})`
const line = (hue) => `oklch(0.72 0.11 ${hue})`

function formatTime(date) {
  return new Date(date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

const Chatbot = () => {
  const [messages, setMessages] = useState([])
  const [isLoading, setIsLoading] = useState(false)
  const [textInput, setTextInput] = useState('')
  const [topics, setTopics] = useState(NAV_TOPICS.map(t => ({ name: t.name, count: t.fallbackCount })))
  const [totalFAQs, setTotalFAQs] = useState(TOTAL_FAQS_FALLBACK)
  const bodyEndRef = useRef(null)
  const lastBotRowRef = useRef(null)
  const inputRef = useRef(null)

  const isWelcome = messages.length === 0
  const threadTitle = isWelcome ? 'New question' : (messages[0]?.content || 'Conversation')

  useEffect(() => {
    let cancelled = false
    axios.get(`${API_BASE_URL}/topics`).then(res => {
      if (cancelled || !res.data) return
      if (Array.isArray(res.data.topics)) setTopics(res.data.topics)
      if (res.data.totalFAQs) setTotalFAQs(res.data.totalFAQs)
    }).catch(() => {
      // keep fallback counts — the UI still works, just not live
    })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    const last = messages[messages.length - 1]
    // A finished bot answer scrolls its own top (tag + start of the bubble) into
    // view instead of jumping straight to the bottom, so the tag isn't hidden
    // above the fold on short viewports. Everything else chases the bottom.
    if (!isLoading && last?.role === 'bot' && lastBotRowRef.current) {
      lastBotRowRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' })
    } else {
      bodyEndRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [messages, isLoading])

  const topicCount = (name) => {
    const found = topics.find(t => t.name === name)
    return found ? found.count : NAV_TOPICS.find(t => t.name === name)?.fallbackCount ?? 0
  }

  const sendMessage = async (text) => {
    const trimmed = text.trim()
    if (!trimmed) return
    setTextInput('')

    const userMessage = { role: 'user', content: trimmed, timestamp: new Date() }
    setMessages(prev => [...prev, userMessage])
    setIsLoading(true)

    try {
      const res = await axios.post(`${API_BASE_URL}/chat`, { message: trimmed })
      const { response, category, matchType, source, metadata } = res.data
      setMessages(prev => [...prev, {
        role: 'bot',
        content: response,
        timestamp: new Date(),
        category,
        matchType,
        groqDown: metadata?.error === 'groq_failed',
        source
      }])
    } catch (err) {
      setMessages(prev => [...prev, {
        role: 'bot',
        content: "Couldn't reach the server just now. Try again in a moment.",
        timestamp: new Date(),
        matchType: 'fallback',
        networkError: true
      }])
    } finally {
      setIsLoading(false)
    }
  }

  const handleTopicClick = (topic) => sendMessage(topic.starter)
  const handleSubmit = (e) => { e.preventDefault(); sendMessage(textInput) }
  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(textInput) }
  }

  const startNewChat = async () => {
    setMessages([])
    setTextInput('')
    try { await axios.delete(`${API_BASE_URL}/history`) } catch (err) { /* best-effort */ }
  }

  const focusInput = () => inputRef.current?.focus()

  const renderTopicList = () => (
    <div className="topic-list">
      {NAV_TOPICS.map(t => (
        <button key={t.name} className="topic-row" onClick={() => handleTopicClick(t)}>
          <span className="topic-row-label">
            <span className="topic-dot" style={{ background: dot(t.hue) }} />
            {t.name}
          </span>
          <span className="topic-row-count">{topicCount(t.name)}</span>
        </button>
      ))}
    </div>
  )

  return (
    <div className="app-shell">
      <header className="mobile-header">
        <div className="mobile-header-text">
          <div className="brand">Off-Campus Community</div>
          <div className="mobile-thread-title">{isWelcome ? `Answering from ${totalFAQs} FAQs` : threadTitle}</div>
        </div>
        <button className="new-chat-btn round" onClick={startNewChat} aria-label="New chat">+</button>
      </header>

      <aside className="sidebar">
        <div className="sidebar-top">
          <div className="brand">Off-Campus Community</div>
          <div className="sidebar-tagline">Answers for students living off campus, drawn from the OCC knowledge base.</div>
          <div className="status-line">
            <span className="status-dot" />
            Answering from {totalFAQs} FAQs · Groq Llama 3.3 70B
          </div>
        </div>

        <div className="sidebar-topics">
          <div className="eyebrow">Topics</div>
          {renderTopicList()}
        </div>

        <div className="sidebar-footer">
          <p>Can&rsquo;t find it here? WUSA and the UW Off-Campus Housing Office have the full details &mdash; this assistant only draws from a {totalFAQs}-entry FAQ set.</p>
          <a href="https://wusa.ca" target="_blank" rel="noreferrer">wusa.ca &rarr;</a>
        </div>
      </aside>

      <main className="main">
        <div className="main-header">
          <div className="main-header-title">{threadTitle}</div>
          <button className="new-chat-btn" onClick={startNewChat}>New chat</button>
        </div>

        <div className="body">
          {isWelcome && (
            <div className="welcome">
              <div className="hero-card">
                <h1>What do you need to sort out?</h1>
                <p>Housing, rent, transit, health, food, and campus rules &mdash; grounded in {totalFAQs} real OCC FAQ entries. Ask in your own words, or start from a topic.</p>
              </div>

              <div className="tile-grid">
                {NAV_TOPICS.map(t => (
                  <button
                    key={t.name}
                    className="tile"
                    style={{ background: wash(t.hue), borderColor: line(t.hue), borderLeftColor: dot(t.hue) }}
                    onClick={() => handleTopicClick(t)}
                  >
                    <span className="tile-name">
                      <span className="topic-dot" style={{ background: dot(t.hue) }} />
                      {t.name}
                    </span>
                    <span className="tile-hint">{t.hint}</span>
                  </button>
                ))}
              </div>

              <div className="popular">
                <div className="eyebrow">Asked this week</div>
                <div className="popular-chips">
                  {POPULAR_QUESTIONS.map(q => (
                    <button key={q} className="chip" onClick={() => sendMessage(q)}>{q}</button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {!isWelcome && (
            <div className="thread">
              {messages.map((m, i) => (
                <div
                  key={i}
                  className={`row ${m.role}`}
                  ref={m.role === 'bot' && i === messages.length - 1 ? lastBotRowRef : null}
                >
                  {m.role === 'bot' && (
                    <div className={`tag ${m.matchType === 'faq' ? 'tag-faq' : 'tag-fallback'}`}>
                      OCC &middot; {m.matchType === 'faq' ? m.category : 'Fallback match'}
                    </div>
                  )}
                  <div className="bubble">{m.content}</div>
                  {m.role === 'bot' && m.groqDown && (
                    <div className="alert-note">
                      Groq is unavailable right now &mdash; this is a fallback keyword match, not a generated answer.
                    </div>
                  )}
                  {m.role === 'bot' && !m.groqDown && m.matchType === 'fallback' && !m.networkError && (
                    <div className="muted-note">No specific FAQ matched &mdash; this answer draws on general knowledge instead.</div>
                  )}
                  <div className="timestamp">{formatTime(m.timestamp)}</div>
                  {m.role === 'bot' && (
                    <div className="quick-row">
                      <button className="quick-btn" onClick={focusInput}>Ask something else</button>
                      <button className="quick-btn" onClick={startNewChat}>Start a new topic</button>
                    </div>
                  )}
                </div>
              ))}
              {isLoading && (
                <div className="row bot">
                  <div className="loading-row">
                    Checking the {totalFAQs}-FAQ index
                    <span className="dots"><span></span><span></span><span></span></span>
                  </div>
                </div>
              )}
              <div ref={bodyEndRef} />
            </div>
          )}
        </div>

        <form className="input-bar" onSubmit={handleSubmit}>
          <textarea
            ref={inputRef}
            rows={1}
            placeholder="Ask about leases, rent, transit, food, anything off campus…"
            value={textInput}
            onChange={(e) => setTextInput(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={isLoading}
          />
          <button type="submit" className="send-btn" disabled={isLoading || !textInput.trim()}>Send</button>
        </form>
        <div className="disclaimer">General guidance only, not official advice &mdash; check anything urgent with WUSA or UW directly.</div>
      </main>
    </div>
  )
}

export default Chatbot
