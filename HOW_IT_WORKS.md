# OCC CHATBOT - Technical Summary

## 🎯 **Project Overview**
The OCC CHATBOT is an interactive web application designed to help off-campus University of Waterloo students navigate campus resources, housing, legal rights, food options, and community services. Built with a Node.js backend and React frontend, deployed on Vercel.

---

## 🏗️ **Architecture**

### **Monorepo Structure**
```
Chatbot/
├── backend/          # Node.js Express API server
│   ├── server.js     # Main Express application
│   ├── faq.json      # Knowledge base (170+ questions)
│   ├── vercel.json   # Vercel deployment config
│   └── .env          # Environment variables
│
└── frontend/         # React + Vite frontend
    ├── src/
    │   ├── components/
    │   │   ├── Chatbot.jsx   # Main chatbot component
    │   │   └── Chatbot.css   # UI styling
    │   ├── App.jsx           # React entry point
    │   └── main.jsx          # Vite entry point
    └── vite.config.js        # Vite proxy configuration
```

---

## 🔧 **Technology Stack**

### **Backend**
- **Runtime**: Node.js
- **Framework**: Express.js
- **AI Integration**: Groq API (Llama 3.3 70B)
- **Dependencies**:
  - `express` - Web server
  - `cors` - Cross-origin resource sharing
  - `dotenv` - Environment variable management
  - `groq-sdk` - AI responses
  - `nodemon` - Development server auto-reload

### **Frontend**
- **Framework**: React 18
- **Build Tool**: Vite 5
- **HTTP Client**: Axios
- **Styling**: Custom CSS with gradients

### **Deployment**
- **Platform**: Vercel
- **Backend**: Serverless Node.js functions
- **Frontend**: Static site hosting

---

## 🧠 **How It Works**

### **1. Knowledge Base System (FAQ.json)**
The chatbot uses a comprehensive FAQ knowledge base stored as a JSON array:
```json
[
  {
    "question": "What are the best budget food options on campus?",
    "answer": "Here's your UWaterloo Budget Eater's Manifesto! 💰..."
  }
]
```
- **170+ questions** across 9 categories
- Covering food, housing, legal, utilities, health, clubs, academic resources, storage, and bylaws

### **2. Multi-Layer Matching Algorithm**

The backend uses sophisticated matching systems:

#### **A. Context Builder: `findRelevantFAQs()`** ⭐ NEW!
Finds top 3 most relevant FAQs to provide as context to Groq:

```javascript
function findRelevantFAQs(question, topN = 3) {
  // Score all FAQs based on relevance
  // - Exact match: 100 points
  // - Off-campus topics: 95 points
  // - Residence topics: 90 points
  // - Food topics: 80 points
  // - Partial matches: 70-40 points
  // - Word matches: 60-30 points
  
  // Sort by score, return top N
}
```

#### **B. Direct FAQ Search: `searchFAQ()`**
For fallback scenarios, uses 3-tier matching:

**Tier 1: Exact Match**
```javascript
// Direct question match
if (question === message) return answer;
```

**Tier 2: Phrase Match**
```javascript
// Partial phrase matching with quality check
if (question.includes(message) || message.includes(question)) {
  if (messageWords.length >= 2 && questionWords.length >= 2) {
    return answer;
  }
}
```

**Tier 3: Word-Based Matching**
```javascript
// Fuzzy matching with threshold
const threshold = messageWords.length >= 5 ? 0.7 : 0.6;
if (matchingWords.length / messageWords.length >= threshold) {
  return answer;
}
```

### **3. Response Generation Flow**

**CURRENT FLOW** (Groq as Primary with FAQ Context):

```
User Question
     ↓
findRelevantFAQs() - Find top 3 matching FAQs
     ↓
Build context from FAQs
     ↓
generateWithGroq() - AI generation WITH FAQ context
     ↓
Success? → YES → Return Groq answer
     ↓
     NO (API Error)
     ↓
Fallback 1: searchFAQ() - Direct FAQ match
     ↓
Found? → YES → Return FAQ
     ↓
     NO
     ↓
Fallback 2: getIntelligentResponse() - Smart default
     ↓
Return Response
```

**Key Feature**: Groq (Llama 3.3 70B) uses your FAQ knowledge base as context, creating more natural, conversational responses while maintaining accuracy!

### **4. User Interface Design**

#### **Dual Input Methods**
Users can interact through TWO ways:
1. **Category Buttons** - 9 main categories with emojis
2. **Subcategory Buttons** - Specific questions within categories
3. **Free Text Input** - Type any question naturally
4. **Action Options** - "Browse Categories Again" or "Ask Something Else"

#### **State Management**
```javascript
const [messages, setMessages] = useState([...])
const [showCategories, setShowCategories] = useState(true)
const [showSubcategories, setShowSubcategories] = useState(false)
```

---

## 🌐 **API Endpoints**

### **Backend Routes** (`server.js`)

#### **GET /** 
- Health check endpoint
- Returns: `{ message: 'Chatbot API is running!' }`

#### **POST /chat**
- Main chat endpoint
- **Request**: `{ message: "user question" }`
- **Response**: 
  ```json
  {
    "response": "bot answer",
    "source": "faq|groq_with_faq_context|groq_general|intelligent_response",
    "history": [...]
  }
  ```

#### **POST /ask**
- Alternative ask endpoint with confidence scoring
- **Response**:
  ```json
  {
    "answer": "bot answer",
    "source": "...",
    "confidence": 0.85
  }
  ```

#### **GET /history**
- Retrieve chat history
- Returns: `{ history: [...] }`

#### **DELETE /history**
- Clear chat history
- Returns: `{ message: 'Chat history cleared' }`

---

## 🔐 **Environment Variables**

### **Backend (.env)**
```bash
GROQ_API_KEY=your_api_key_here
PORT=5000
NODE_ENV=production
```

### **Vercel Configuration**
Environment variables set in Vercel dashboard:
- `GROQ_API_KEY`
- `PORT`
- `NODE_ENV`

---

## 🎨 **UI/UX Features**

### **Color Scheme**
- **Background**: Blue-teal gradient (`#030d46` → `#b4240a`)
- **Category Colors**: 
  - Food: `#FF7A7A`
  - Housing: `#4FC3F7`
  - Legal: `#42A5F5`
  - Transportation: `#29B6F6`
  - Health: `#66BB6A`
  - Clubs: `#FF7043`
  - Academic: `#26C6DA`
  - Storage: `#AB47BC`
  - Bylaws: `#8D6E63`

### **Interactive Elements**
- Smooth scrolling to latest message
- Loading spinner during API calls
- Timestamps on all messages
- Source labels showing answer origin
- Clear chat button

---

## 🚀 **Deployment Configuration**

### **Vercel Setup** (`backend/vercel.json`)
```json
{
  "version": 2,
  "builds": [
    {
      "src": "server.js",
      "use": "@vercel/node"
    }
  ],
  "routes": [
    {
      "src": "/(.*)",
      "dest": "server.js"
    }
  ]
}
```

### **Project Settings**
- **Root Directory**: `backend/`
- **Build Command**: `npm install`
- **Output Directory**: Not applicable (Node.js server)
- **Framework Preset**: Other

---

## 🔄 **Development Workflow**

### **Local Development**

#### **Start Backend**
```bash
cd backend
npm install
npm run dev  # Uses nodemon for auto-reload
```

#### **Start Frontend**
```bash
cd frontend
npm install
npm run dev  # Runs on http://localhost:3000
```

#### **Vite Proxy Configuration**
```javascript
proxy: {
  '/api': {
    target: 'http://localhost:5000',
    changeOrigin: true,
    rewrite: (path) => path.replace(/^\/api/, '')
  }
}
```

### **Production Deployment**

#### **Frontend (`Chatbot.jsx`)**
```javascript
// Local: http://localhost:5000/chat
// Production: https://occ-chatbot.vercel.app/chat

const response = await axios.post('https://occ-chatbot.vercel.app/chat', {
  message: message
})
```

#### **Git Workflow**
```bash
git add .
git commit -m "Description"
git push origin master
# Automatic Vercel deployment
```

---

## 🐛 **Key Technical Challenges & Solutions**

### **1. FAQ Data Structure Mismatch**
**Problem**: FAQ was an array, but code expected nested object
```javascript
// ❌ Expected
{ categories: { food: {...} } }

// ✅ Actual
[{ question: "...", answer: "..." }]
```

**Solution**: Updated `searchFAQ()` and `findMostRelevantFAQ()` to handle arrays
```javascript
const allFAQs = Array.isArray(faqData) ? faqData : [];
```

### **2. Deployment Configuration**
**Problem**: Vercel expected static site, got Node.js server
**Solution**: Created `vercel.json` to specify `@vercel/node` builder

### **3. CORS Issues**
**Solution**: Added CORS middleware
```javascript
app.use(cors());
```

### **4. Missing Dependencies**
**Problem**: Frontend had no `package.json`
**Solution**: Created complete React + Vite setup

### **5. Groq AI Integration Upgrade** ⭐ LATEST!
**Problem**: Gemini was unreliable and slow, FAQ answers were static
**Solution**: Re-architected to use Groq (Llama 3.3 70B) as PRIMARY responder with FAQ as knowledge base
```javascript
// NEW: Groq-first approach with FAQ context
const relevantFAQs = findRelevantFAQs(message, 3);
const context = relevantFAQs.map(faq => `Q: ${faq.question}\nA: ${faq.answer}`).join('\n\n');
const answer = await generateWithGroq(message, context);
```
**Impact**: Faster, more reliable, and natural conversational responses while maintaining FAQ accuracy!

---

## 📊 **Key Features**

### **1. Reduced User Errors**
- Button-based navigation (no typos)
- Clear category hierarchy
- Visual feedback on all interactions

### **2. Comprehensive Knowledge Base**
- 170+ questions covering student needs
- Student-friendly language
- Empathetic tone
- Actionable next steps

### **3. Intelligent Response Generation** ⭐ UPDATED!
- **Primary**: Groq (Llama 3.3 70B) with FAQ context (natural, conversational, fast)
- **Fallback 1**: Direct FAQ match (fast, accurate)
- **Fallback 2**: Intelligent defaults (basic help)
- Always returns a helpful response

### **4. Performance Optimizations**
- In-memory FAQ loading (fast lookups)
- Serverless deployment (auto-scaling)
- Minimal dependencies (faster builds)

---

## 📈 **Usage Statistics**

- **Total Questions**: 170+
- **Categories**: 9 main topics
- **Subcategories**: 3-7 per category
- **Coverage**: Food, Housing, Legal, Transportation, Health, Clubs, Academic, Storage, Bylaws
- **Response Sources**: Groq AI (Llama 3.3 70B) with FAQ context (primary), Direct FAQ (fallback), Intelligent responses (last resort)

---

## 🎓 **Student-Specific Design Decisions**

1. **Button Interface**: Prevents spelling mistakes and typos
2. **Category Organization**: Mirrors common student concerns
3. **Empathetic Language**: "We understand this is frustrating"
4. **Action-Focused**: Every answer includes specific next steps
5. **Resource Links**: Direct URLs to WUSA, food bank, etc.
6. **Emergency Info**: Prominent safety and legal contacts

---

## 🔮 **Future Enhancements (Potential)**

- [ ] Database integration (PostgreSQL/MongoDB)
- [ ] User authentication and conversation history
- [ ] Analytics dashboard
- [ ] Multi-language support
- [ ] Voice interface
- [ ] SMS/WhatsApp integration
- [ ] Machine learning for better matching
- [ ] Admin panel for FAQ management

---

## 📝 **Code Quality**

- **ESLint**: Configured for React best practices
- **Error Handling**: Try-catch blocks throughout
- **Logging**: Console logs for debugging
- **Environment Variables**: Secure API key management
- **Git**: Proper `.gitignore` for secrets

---

## 🤝 **Credits**

- **Framework**: React, Express.js
- **AI**: Groq API (Llama 3.3 70B)
- **Deployment**: Vercel
- **Database**: JSON file (knowledge base)
- **Styling**: Custom CSS

---

**🎉 The OCC CHATBOT successfully serves University of Waterloo's off-campus student community with accessible, empathetic, and comprehensive support!**

