const crypto = require('crypto');
const express = require('express');
const { topicCounts, faqCount, officialSources } = require('../lib/knowledge');
const { runPipeline } = require('../pipeline');
const { chatLimits } = require('../middleware/rateLimits');
const { alertChannels } = require('../lib/alerts');
const { isSessionId, parseChatMessage } = require('../lib/validate');

const router = express.Router();

// A request id ties the response (X-Request-Id) to its structured log line,
// so a reported problem can be traced without anyone sharing message text.
function withRequestId(res) {
  const requestId = crypto.randomUUID();
  res.setHeader('X-Request-Id', requestId);
  return requestId;
}

router.get('/', (req, res) => {
  res.json({ message: 'Chatbot API is running!' });
});

router.get('/topics', (req, res) => {
  res.json({
    topics: topicCounts(),
    totalFAQs: faqCount(),
    totalSources: officialSources.length,
    // Whether escalations actually alert staff, so the UI only promises a
    // human follow-up when one can happen.
    staffHandoff: alertChannels().length > 0
  });
});

router.post('/chat', chatLimits, async (req, res) => {
  const requestId = withRequestId(res);
  try {
    const { message, error } = parseChatMessage(req.body);
    if (error) return res.status(400).json({ error });
    // An id we didn't mint (or a malformed one) starts a fresh session.
    const sessionId = isSessionId(req.body.sessionId) ? req.body.sessionId : undefined;
    res.json(await runPipeline({ message, sessionId, requestId }));
  } catch (error) {
    console.error(JSON.stringify({ event: 'chat_error', requestId, error: error?.message || String(error) }));
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Same pipeline, streamed as newline-delimited JSON: session → step events as
// each stage starts/finishes → answer tokens → a final "done" with the full
// payload (which includes any critic edits to the streamed text).
router.post('/chat/stream', chatLimits, async (req, res) => {
  const requestId = withRequestId(res);
  const { message, error } = parseChatMessage(req.body);
  if (error) return res.status(400).json({ error });
  const sessionId = isSessionId(req.body.sessionId) ? req.body.sessionId : undefined;

  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const emit = event => {
    if (!res.writableEnded) res.write(JSON.stringify(event) + '\n');
  };

  try {
    const payload = await runPipeline({ message, sessionId, emit, requestId });
    emit({ type: 'done', payload });
  } catch (error) {
    console.error(JSON.stringify({ event: 'chat_error', requestId, stream: true, error: error?.message || String(error) }));
    emit({ type: 'error', error: 'Internal server error' });
  }
  res.end();
});

module.exports = router;
