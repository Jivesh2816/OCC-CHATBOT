const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

// Groq AI
const Groq = require('groq-sdk');
const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY
});

const app = express();
const PORT = process.env.PORT || 5000;

// Diagnostics for env
console.log('Groq enabled:', !!process.env.GROQ_API_KEY);

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

// Groq helper
async function generateWithGroq(message, faqContext = '') {
  try {
    const prompt = faqContext 
      ? `You are a helpful assistant for University of Waterloo off-campus students.

Here are relevant FAQs:
${faqContext}

Student question: ${message}

Provide a helpful, friendly answer based on the FAQs above. If the FAQs don't cover it, use your knowledge but stay focused on student life at UWaterloo. Be empathetic and action-oriented.`
      : `You are a helpful assistant for University of Waterloo off-campus students. 

Student question: ${message}

Provide a helpful, friendly, and practical answer about off-campus student life at UWaterloo. Be empathetic and action-oriented.`;

    const completion = await groq.chat.completions.create({
      messages: [
        {
          role: "system",
          content: "You are a helpful assistant for University of Waterloo off-campus students."
        },
        {
          role: "user",
          content: prompt
        }
      ],
      model: "openai/gpt-oss-20b",
      temperature: 0.7,
      max_tokens: 1024,
    });

    return completion.choices[0]?.message?.content?.trim() || "Sorry, I couldn't generate a response.";
  } catch (error) {
    console.error('Groq API Error:', error);
    return null;
  }
}

// Function to search FAQ for matching questions
function searchFAQ(userMessage) {
  const message = userMessage.toLowerCase().trim();
  
  // FAQ is now a simple array of objects with question/answer properties
  const allFAQs = Array.isArray(faqData) ? faqData : [];
  
  // First pass: Look for exact matches
  for (const faq of allFAQs) {
    const question = faq.question.toLowerCase();
    if (question === message) return faq;
  }

  // Second pass: Look for exact phrase matches (more restrictive)
  for (const faq of allFAQs) {
    const question = faq.question.toLowerCase();
    if (question.includes(message) || message.includes(question)) {
      // Additional check: ensure it's a meaningful match (not just single words)
      const messageWords = message.split(' ').filter(word => word.length > 2);
      const questionWords = question.split(' ').filter(word => word.length > 2);
      if (messageWords.length >= 2 && questionWords.length >= 2) {
        return faq;
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
        return faq;
      }
    }
  }

  return null;
}

// The 6 topics surfaced in the sidebar/welcome UI. Academic and Clubs & Social
// FAQs still exist and are tagged, but aren't promoted as a nav entry point.
const NAV_TOPICS = ['Housing & Leases', 'Rent & Money', 'Getting Around', 'Health & Safety', 'Food & Essentials', 'Neighbours & Bylaws'];

function topicCounts() {
  const allFAQs = Array.isArray(faqData) ? faqData : [];
  return NAV_TOPICS.map(name => ({
    name,
    count: allFAQs.filter(f => f.category === name).length
  }));
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

// Function to find top N relevant FAQs for context
function findRelevantFAQs(question, topN = 3) {
  const message = question.toLowerCase().trim();
  const allFAQs = Array.isArray(faqData) ? faqData : [];
  
  // Score all FAQs
  const scoredFAQs = allFAQs.map(faq => {
    const fq = faq.question.toLowerCase();
    let score = 0;
    
    // Exact match
    if (fq === message) score = 100;
    // Off-campus specific
    else if (message.includes('off-campus') && fq.includes('off-campus')) score = 95;
    else if (message.includes('food') && message.includes('off-campus') && fq.includes('food') && fq.includes('off-campus')) score = 95;
    // Residence specific
    else if (message.includes('residence') && fq.includes('residence')) score = 90;
    else if (message.includes('food') && message.includes('residence') && fq.includes('food') && fq.includes('residence')) score = 90;
    // Food specific
    else if (message.includes('food') && fq.includes('food')) score = 80;
    // Partial match
    else if (fq.includes(message) || message.includes(fq)) {
      const overlap = Math.min(message.length, fq.length) / Math.max(message.length, fq.length);
      score = overlap > 0.6 ? 70 : 40;
    } 
    // Word-based matching
    else {
      const m = message.split(' ').filter(w => w.length > 2);
      const qw = fq.split(' ').filter(w => w.length > 2);
      const matches = m.filter(w => qw.some(qw2 => qw2.includes(w) || w.includes(qw2)));
      if (matches.length > 0) {
        const ratio = matches.length / Math.max(m.length, qw.length);
        score = ratio >= 0.5 ? 60 : 30;
      }
    }
    
    return { faq, score };
  });
  
  // Sort by score descending and return top N
  scoredFAQs.sort((a, b) => b.score - a.score);
  return scoredFAQs.slice(0, topN).filter(item => item.score > 0).map(item => item.faq);
}

app.get('/', (req, res) => {
  res.json({ message: 'Chatbot API is running!' });
});

app.get('/topics', (req, res) => {
  res.json({
    topics: topicCounts(),
    totalFAQs: Array.isArray(faqData) ? faqData.length : 0
  });
});

app.post('/chat', async (req, res) => {
  try {
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: 'Message is required' });

    chatHistory.push({ role: 'user', content: message, timestamp: new Date() });

    console.log('Processing question:', message);

    // Find relevant FAQs for context
    const relevantFAQs = findRelevantFAQs(message, 3);
    console.log('Found relevant FAQs:', relevantFAQs.length);

    // Build context from FAQs
    const context = relevantFAQs.map(faq => 
      `Q: ${faq.question}\nA: ${faq.answer}`
    ).join('\n\n');

    let botResponse, source, metadata, category, matchType;

    try {
      // Try Groq with FAQ context
      botResponse = await generateWithGroq(message, context);
      source = 'groq_with_faq_context';
      metadata = {
        relevantFAQs: relevantFAQs.map(f => f.question),
        faqCount: relevantFAQs.length
      };
      console.log('Groq generated response with FAQ context');

      // Handle Groq error response
      if (!botResponse || botResponse.includes("Sorry, I couldn't generate")) {
        throw new Error('Groq returned empty response');
      }

      // Grounded in a real FAQ only if a relevant one was actually found
      if (relevantFAQs.length > 0) {
        matchType = 'faq';
        category = relevantFAQs[0].category;
      } else {
        matchType = 'fallback';
        category = null;
      }
    } catch (groqError) {
      console.error('Groq error:', groqError?.message || groqError);

      // Fallback to direct FAQ match
      const faqMatch = searchFAQ(message);
      if (faqMatch) {
        botResponse = faqMatch.answer;
        source = 'faq_fallback';
        matchType = 'faq';
        category = faqMatch.category;
        console.log('Used FAQ fallback');
      } else {
        botResponse = getIntelligentResponse(message);
        source = 'intelligent_response';
        matchType = 'fallback';
        category = null;
        console.log('Used intelligent response fallback');
      }
      metadata = { error: 'groq_failed' };
    }

    chatHistory.push({ role: 'bot', content: botResponse, timestamp: new Date() });
    console.log('Sending response:', {
      source,
      category,
      preview: botResponse.substring(0, 100) + '...',
      metadata
    });

    res.json({
      response: botResponse,
      history: chatHistory.slice(-10),
      source,
      category,
      matchType,
      metadata
    });
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

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
