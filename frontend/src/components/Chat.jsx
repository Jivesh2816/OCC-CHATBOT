import React, { useState, useRef, useEffect } from 'react';
import axios from 'axios';
import './Chat.css';

const API_BASE_URL = 'http://localhost:5000';

function Chat() {
  const [messages, setMessages] = useState([]);
  const [inputMessage, setInputMessage] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);
  const messagesEndRef = useRef(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const prefillAndSend = async (text) => {
    setInputMessage(text);
    // Slight delay to allow state to set, then submit
    setTimeout(() => {
      const fakeEvent = { preventDefault: () => {} };
      sendMessage(fakeEvent, text);
    }, 0);
  };

  const sendMessage = async (e, overrideText) => {
    e.preventDefault();
    const textToSend = (overrideText ?? inputMessage).trim();
    if (!textToSend || isLoading) return;

    const userMessage = { 
      role: 'user', 
      content: textToSend, 
      timestamp: new Date() 
    };
    
    setMessages(prev => [...prev, userMessage]);
    setInputMessage('');
    setIsLoading(true);
    setError(null);

    try {
      const response = await axios.post(`${API_BASE_URL}/ask`, {
        question: textToSend
      });

      const botMessage = { 
        role: 'bot', 
        content: response.data.answer, 
        timestamp: new Date(),
        source: response.data.source,
        confidence: response.data.confidence
      };
      
      setMessages(prev => [...prev, botMessage]);
    } catch (error) {
      console.error('Error sending message:', error);
      const errorMessage = { 
        role: 'bot', 
        content: 'Hmm, I had trouble reaching the server. Please check your connection and try again.', 
        timestamp: new Date(),
        isError: true
      };
      setMessages(prev => [...prev, errorMessage]);
      setError('The service is temporarily unavailable. Please try again in a moment.');
    } finally {
      setIsLoading(false);
    }
  };

  const clearChat = () => {
    setMessages([]);
    setError(null);
  };

  return (
    <div className="chat-container">
      <div className="chat-header">
        <h2>Chat with the Bot</h2>
        <button onClick={clearChat} className="clear-button">
          Clear Chat
        </button>
      </div>
      
      {/* Quick options menu */}
      <div className="quick-options">
        <button onClick={() => prefillAndSend('How do I find off-campus housing?')} className="quick-option">🏠 Housing</button>
        <button onClick={() => prefillAndSend('Can I get food on campus?')} className="quick-option">🍴 Food</button>
        <button onClick={() => prefillAndSend('How do I find campus-wide events?')} className="quick-option">🎉 Events</button>
      </div>
      
      <div className="chat-messages">
        {messages.length === 0 ? (
          <div className="welcome-message">
            <p>👋 Hi! I'm here to help with your off-campus student questions.</p>
            <p>Try asking me about:</p>
            <ul>
              <li>Housing and rental information</li>
              <li>Campus facilities and services</li>
              <li>Transportation and parking</li>
              <li>Food and dining options</li>
              <li>Health and wellness resources</li>
            </ul>
          </div>
        ) : (
          messages.map((message, index) => (
            <div
              key={index}
              className={`message ${message.role} ${message.isError ? 'error' : ''}`}
            >
              <div className="message-content">
                <p>{message.content}</p>
                <div className="message-meta">
                  <span className="timestamp">
                    {new Date(message.timestamp).toLocaleTimeString()}
                  </span>
                  {message.source && (
                    <span className="source">
                      Source: {message.source}
                    </span>
                  )}
                  {message.confidence && (
                    <span className="confidence">
                      Confidence: {(message.confidence * 100).toFixed(1)}%
                    </span>
                  )}
                </div>
              </div>
            </div>
          ))
        )}
        
        {isLoading && (
          <div className="message bot loading">
            <div className="message-content">
              <div className="typing-indicator">
                <span></span>
                <span></span>
                <span></span>
              </div>
            </div>
          </div>
        )}
        
        <div ref={messagesEndRef} />
      </div>

      {error && (
        <div className="error-message">
          {error}
        </div>
      )}

      <form onSubmit={sendMessage} className="chat-input">
        <input
          type="text"
          value={inputMessage}
          onChange={(e) => setInputMessage(e.target.value)}
          placeholder="Ask me anything about off-campus student life..."
          disabled={isLoading}
          className="message-input"
        />
        <button
          type="submit"
          disabled={!inputMessage.trim() || isLoading}
          className="send-button"
        >
          {isLoading ? 'Sending...' : 'Send'}
        </button>
      </form>
    </div>
  );
}

export default Chat;
