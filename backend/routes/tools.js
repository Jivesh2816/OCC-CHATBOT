const express = require('express');
const crypto = require('crypto');
const { db } = require('../db');
const { completeJSON } = require('../lib/llm');
const { sourcesById } = require('../lib/knowledge');
const { analyzeLease } = require('../lib/lease');
const { analyzeListing } = require('../lib/scam');
const { now, createTicketRecord } = require('../lib/tickets');
const { toolLimits } = require('../middleware/rateLimits');

const router = express.Router();

// --- Lease Checker ---------------------------------------------------------

const MAX_LEASE_CHARS = 120000;

async function extractPdfText(base64) {
  const { extractText, getDocumentProxy } = await import('unpdf');
  const pdf = await getDocumentProxy(new Uint8Array(Buffer.from(base64, 'base64')));
  const { text, totalPages } = await extractText(pdf, { mergePages: true });
  return { text: text || '', pages: totalPages };
}

router.post('/lease/check', toolLimits, async (req, res) => {
  try {
    let { text, pdfBase64 } = req.body || {};
    let pages = null;

    if (pdfBase64) {
      const extracted = await extractPdfText(pdfBase64);
      text = extracted.text;
      pages = extracted.pages;
      if (text.replace(/\s/g, '').length < 50) {
        return res.status(422).json({ error: 'That PDF has no selectable text (it may be a scan). Paste the lease text instead.' });
      }
    }
    if (!text || text.trim().length < 50) return res.status(400).json({ error: 'Paste at least a few lines of the lease, or upload a PDF.' });

    const truncated = text.length > MAX_LEASE_CHARS;
    const result = await analyzeLease(text.slice(0, MAX_LEASE_CHARS), {
      complete: process.env.GROQ_API_KEY ? completeJSON : null,
      sourcesById
    });
    res.json({ ...result, pages, truncated, characters: Math.min(text.length, MAX_LEASE_CHARS) });
  } catch (error) {
    console.error('Lease check failed:', error);
    res.status(500).json({ error: 'Could not analyze that lease.' });
  }
});

// Hands a lease review to a person: opens a normal-priority ticket on the
// student's session with the flagged clauses as its summary.
router.post('/lease/escalate', toolLimits, async (req, res) => {
  try {
    const { sessionId: incoming, findings = [] } = req.body || {};
    if (!Array.isArray(findings) || findings.length === 0) return res.status(400).json({ error: 'No findings to send.' });
    const sessionId = incoming || crypto.randomUUID();
    await db.run('INSERT OR IGNORE INTO sessions (id, created_at) VALUES (?, ?)', [sessionId, now()]);

    const lines = findings.slice(0, 20).map(f => `• [${f.severity}] ${f.title} (clause ${f.clauseNumber}): "${String(f.quote || '').slice(0, 200)}"`);
    const summary = `Lease review requested — ${findings.length} flagged clause(s).`;
    const ticket = await createTicketRecord({ category: 'lease_review', summary, priority: 'normal' }, lines.join('\n'), 'housing', sessionId);
    res.json({ sessionId, ...ticket });
  } catch (error) {
    console.error('Lease escalation failed:', error);
    res.status(500).json({ error: 'Could not create the ticket.' });
  }
});

// --- Listing Scam Checker --------------------------------------------------

router.post('/listing/check', toolLimits, async (req, res) => {
  try {
    const { text } = req.body || {};
    if (!text || text.trim().length < 30) return res.status(400).json({ error: 'Paste the listing or the landlord\'s message (at least a couple of sentences).' });
    const result = await analyzeListing(text.slice(0, 20000), {
      complete: process.env.GROQ_API_KEY ? completeJSON : null,
      sourcesById
    });
    res.json(result);
  } catch (error) {
    console.error('Listing check failed:', error);
    res.status(500).json({ error: 'Could not analyze that listing.' });
  }
});

module.exports = router;
