const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

// Google Gemini
const { GoogleGenerativeAI } = require('@google/generative-ai');
const genAI = process.env.GOOGLE_API_KEY ? new GoogleGenerativeAI(process.env.GOOGLE_API_KEY) : null;

const app = express();
const PORT = process.env.PORT || 5000;

// Diagnostics for env
console.log('Gemini enabled:', !!process.env.GOOGLE_API_KEY);

// Load FAQ data
let faqData = {};
try {
  const faqPath = path.join(__dirname, 'faq.json');
  const faqRaw = fs.readFileSync(faqPath, 'utf8');
  faqData = JSON.parse(faqRaw);
  console.log('FAQ data loaded successfully');
} catch (error) {
  console.error('Error loading FAQ data:', error);
}

// Middleware
app.use(cors());
app.use(express.json());

// Simple in-memory storage for demo purposes
let chatHistory = [];

// Gemini helper
async function generateWithGemini(prompt, maxOutputTokens = 512) {
  if (!genAI) throw new Error('Missing GOOGLE_API_KEY');
  const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
  const result = await model.generateContent({
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens
    }
  });
  const text = result.response.text();
  return (text || '').trim();
}

// Function to search FAQ for matching questions
function searchFAQ(userMessage) {
  const message = userMessage.toLowerCase().trim();
  
  // FAQ is now a simple array of objects with question/answer properties
  const allFAQs = Array.isArray(faqData) ? faqData : [];
  
  // First pass: Look for exact matches
  for (const faq of allFAQs) {
    const question = faq.question.toLowerCase();
    if (question === message) return faq.answer;
  }
  
  // Second pass: Look for exact phrase matches (more restrictive)
  for (const faq of allFAQs) {
    const question = faq.question.toLowerCase();
    if (question.includes(message) || message.includes(question)) {
      // Additional check: ensure it's a meaningful match (not just single words)
      const messageWords = message.split(' ').filter(word => word.length > 2);
      const questionWords = question.split(' ').filter(word => word.length > 2);
      if (messageWords.length >= 2 && questionWords.length >= 2) {
        return faq.answer;
      }
    }
  }
  
  // Third pass: Word-based matching with higher threshold
  for (const faq of allFAQs) {
    const question = faq.question.toLowerCase();
    const messageWords = message.split(' ').filter(word => word.length > 2);
    const questionWords = question.split(' ').filter(word => word.length > 2);
    
    if (messageWords.length >= 3 && questionWords.length >= 3) {
      const matchingWords = messageWords.filter(word => 
        questionWords.some(qWord => qWord.includes(word) || word.includes(qWord))
      );
      // Higher threshold for longer questions to avoid false matches
      const threshold = messageWords.length >= 5 ? 0.7 : 0.6;
      if (matchingWords.length > 0 && matchingWords.length / messageWords.length >= threshold) {
        return faq.answer;
      }
    }
  }
  
  return null;
}

// Lightweight fallback for common intents
function getIntelligentResponse(message) {
  const q = message.toLowerCase();
  if (q.includes('study') || q.includes('library')) return 'Try Davis Centre Library, Dana Porter Library, and SLC study areas.';
  if (q.includes('event')) return 'See WUSA Events and the UWaterloo events calendar for what\'s on this week.';
  if (q.includes('housing') || q.includes('rent')) return 'Check the Off-Campus Housing Office site for listings, leases, and tenant rights.';
  if (q.includes('food') || q.includes('meal') || q.includes('eat')) {
    return '🍕 Campus is full of food options! Check out:\n\n• **SLC**: Tim Hortons, Pizza Pizza, Subway, Booster Juice\n• **DC & MC**: Tim Hortons locations\n• **South Campus Hall**: Food court with diverse options\n• **Dining Halls**: Village 1, REV for all-you-can-eat\n• **WUSA Food Support**: Free hampers at SLC Turnkey\n\nUse your WatCard everywhere! Perfect for off-campus students.';
  }
  if (q.includes('tim') || q.includes('tim hortons') || q.includes('coffee')) {
    return '☕ Tim Hortons locations on campus:\n\n• **SLC** - Busiest, open late\n• **DC** (Davis Centre) - Between classes\n• **MC** (Math & Computer) - Quick runs\n• **South Campus Hall** - Near food court\n\nAll accept WatCard! Great for coffee, breakfast, and study snacks.';
  }
  if (q.includes('slc') && (q.includes('food') || q.includes('eat'))) {
    return '🎉 SLC Food Court has everything:\n\n• Tim Hortons - Coffee & breakfast\n• Pizza Pizza - Slices & whole pizzas\n• Subway - Subs & salads\n• Booster Juice - Smoothies\n• Teriyaki Experience - Asian bowls\n\nOpen late, WatCard accepted everywhere!';
  }
  if (q.includes('transport') || q.includes('bus') || q.includes('ion') || q.includes('grt')) return 'Your WatCard is your U-Pass for GRT/ION. Tap on entry. Might take 2–4 business days to activate if new.';
  return 'Happy to help! Ask me about housing, food, transportation, campus facilities, or wellness resources.';
}

function findMostRelevantFAQ(question) {
  const message = question.toLowerCase().trim();
  // FAQ is now a simple array of objects with question/answer properties
  const allFAQs = Array.isArray(faqData) ? faqData : [];
  let bestMatch = null;
  let bestScore = 0;
  for (const faq of allFAQs) {
    const fq = faq.question.toLowerCase();
    let score = 0;
    if (fq === message) score = 1.0;
    else if (message.includes('off-campus') && fq.includes('off-campus')) score = 0.98;
    else if (message.includes('food') && message.includes('off-campus') && fq.includes('food') && fq.includes('off-campus')) score = 0.98;
    else if (message.includes('residence') && fq.includes('residence')) score = 0.95;
    else if (message.includes('food') && message.includes('residence') && fq.includes('food') && fq.includes('residence')) score = 0.95;
    else if (message.includes('food') && fq.includes('food')) score = 0.85;
    else if (fq.includes(message) || message.includes(fq)) {
      const overlap = Math.min(message.length, fq.length) / Math.max(message.length, fq.length);
      score = overlap > 0.6 ? 0.8 : 0.5;
    } else {
      const m = message.split(' ').filter(w => w.length > 2);
      const qw = fq.split(' ').filter(w => w.length > 2);
      const matches = m.filter(w => qw.some(qw2 => qw2.includes(w) || w.includes(qw2)));
      if (matches.length > 0) {
        const ratio = matches.length / m.length;
        score = ratio >= 0.6 ? ratio * 0.7 : 0.3;
      }
    }
    if (score > bestScore) { bestScore = score; bestMatch = faq; }
  }
  return { faq: bestMatch, confidence: bestScore };
}

function generateConversationalResponse(question, faqEntry) {
  const options = [
    `Based on the information I have: ${faqEntry.answer}`,
    `Here’s what I can tell you: ${faqEntry.answer}`,
    `Great question! ${faqEntry.answer}`
  ];
  return options[Math.floor(Math.random() * options.length)];
}

app.get('/', (req, res) => {
  res.json({ message: 'Chatbot API is running!' });
});

app.post('/chat', async (req, res) => {
  try {
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: 'Message is required' });

    chatHistory.push({ role: 'user', content: message, timestamp: new Date() });

    const faqAnswer = searchFAQ(message);
    console.log('Searching for:', message);
    console.log('FAQ Answer found:', !!faqAnswer);
    let botResponse, source;
    if (faqAnswer) {
      botResponse = faqAnswer;
      source = 'faq';
    } else {
      const prompt = `You are a helpful assistant for University of Waterloo students.\nQuestion: ${message}\nAnswer:`;
      try {
        botResponse = await generateWithGemini(prompt, 400);
        source = 'gemini_general';
      } catch (e) {
        console.error('Gemini error (/chat):', e?.message || e);
        botResponse = getIntelligentResponse(message);
        source = 'intelligent_response';
      }
    }

    chatHistory.push({ role: 'bot', content: botResponse, timestamp: new Date() });
    console.log('Sending response:', { response: botResponse.substring(0, 100) + '...', source });
    res.json({ response: botResponse, history: chatHistory.slice(-10), source });
  } catch (error) {
    console.error('Error processing chat:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/history', (req, res) => {
  res.json({ history: chatHistory });
});

app.delete('/history', (req, res) => {
  chatHistory = [];
  res.json({ message: 'Chat history cleared' });
});

app.post('/ask', async (req, res) => {
  try {
    const { question } = req.body;
    if (!question) return res.status(400).json({ error: 'Question is required' });

    const match = findMostRelevantFAQ(question);
    if (!match.faq) {
      const prompt = `You are a helpful assistant for University of Waterloo students.\nQuestion: ${question}\nAnswer:`;
      try {
        const answer = await generateWithGemini(prompt, 512);
        return res.json({ answer, source: 'gemini_general', confidence: 0 });
      } catch (e) {
        console.error('Gemini error (/ask, no FAQ):', e?.message || e);
        const answer = getIntelligentResponse(question);
        return res.json({ answer, source: 'intelligent_response', confidence: 0 });
      }
    }

    if (match.confidence >= 0.85) {
      return res.json({ answer: match.faq.answer, source: 'faq', confidence: match.confidence });
    } else {
      const context = `You are a helpful assistant for University of Waterloo students.\nUse the FAQ to answer naturally.\nFAQ: ${match.faq.question} -> ${match.faq.answer}\nUser: ${question}\nAssistant:`;
      try {
        const answer = await generateWithGemini(context, 512);
        return res.json({ answer, source: 'gemini_enhanced', confidence: match.confidence });
      } catch (e) {
        console.error('Gemini error (/ask, enhance):', e?.message || e);
        const answer = generateConversationalResponse(question, match.faq);
        return res.json({ answer, source: 'faq_fallback', confidence: match.confidence });
      }
    }
  } catch (error) {
    console.error('Error processing /ask request:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
