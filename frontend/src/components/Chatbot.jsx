import React, { useState, useRef, useEffect } from 'react'
import axios from 'axios'
import './Chatbot.css'

const Chatbot = () => {
  const [messages, setMessages] = useState([
    {
      role: 'bot',
      content: 'Hello! I\'m your OCC CHATBOT. What are your issues regarding?',
      timestamp: new Date(),
      showCategories: true
    }
  ])
  const [isLoading, setIsLoading] = useState(false)
  const [showCategories, setShowCategories] = useState(true)
  const [showSubcategories, setShowSubcategories] = useState(false)
  const [currentCategory, setCurrentCategory] = useState('')
  const messagesEndRef = useRef(null)

  const categories = {
    '🍕 Food & Budget Options': {
      emoji: '🍕',
      color: '#FF7A7A',
      subcategories: [
        'What are the best budget food options on campus?',
        'I need food support - where can I get help?',
        'Where can I eat cheap on campus?',
        'What are the best University Plaza restaurants for budget eating?',
        'What grocery stores offer student discounts?',
        'What restaurants are in the SLC?',
        'Tim Hortons locations on campus'
      ]
    },
    '🏠 Housing & Residence': {
      emoji: '🏠',
      color: '#4FC3F7',
      subcategories: [
        'What are my on-campus housing options?',
        'How do I find off-campus housing?',
        'What should I know about off-campus utilities?',
        'My landlord won\'t fix maintenance issues',
        'What are my tenant rights in Ontario?',
        'Joint lease and roommate liability'
      ]
    },
    '⚖️ Legal Support & Rights': {
      emoji: '⚖️',
      color: '#42A5F5',
      subcategories: [
        'What legal support is available for students?',
        'WUSA legal protection program',
        'Emergency contacts and campus police',
        'Academic rights and dispute resolution'
      ]
    },
    '🚌 Transportation & Travel': {
      emoji: '🚌',
      color: '#29B6F6',
      subcategories: [
        'How do I get around campus and the city?',
        'U-Pass not working on bus/ION',
        'ION and GRT bus schedules',
        'Airport transfers and travel tips'
      ]
    },
    '🏥 Health & Wellness': {
      emoji: '🏥',
      color: '#66BB6A',
      subcategories: [
        'What health services are available on campus?',
        'Booking health appointments',
        'Mental health resources',
        'Health emergencies',
        'Insurance and coverage options'
      ]
    },
    '🎉 Clubs & Social Life': {
      emoji: '🎉',
      color: '#FF7043',
      subcategories: [
        'What clubs and social activities are available?',
        'Connecting with clubs on campus',
        'Types of clubs available',
        'Off-campus student events'
      ]
    },
    '💻 Academic Resources': {
      emoji: '💻',
      color: '#26C6DA',
      subcategories: [
        'What academic and computing resources are available?',
        'Software and tools for students',
        'CS and Math course resources',
        'Study groups and TA office hours'
      ]
    },
    '🔒 Storage & Campus Services': {
      emoji: '🔒',
      color: '#AB47BC',
      subcategories: [
        'Where can I store my belongings on campus?',
        'Campus storage and locker rentals',
        'Residence lockers and security'
      ]
    },
    '🏘️ Campus Rules & Safety': {
      emoji: '🏘️',
      color: '#8D6E63',
      subcategories: [
        'What campus and municipal rules should I know?',
        'Noise rules in Kitchener vs Waterloo',
        'Waste and recycling rules',
        'Parking rules off-campus',
        'Safety and emergency procedures'
      ]
    }
  }

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" })
  }

  useEffect(() => {
    scrollToBottom()
  }, [messages])

  const handleCategoryClick = (categoryName) => {
    const categoryData = categories[categoryName]
    setCurrentCategory(categoryName)
    setShowCategories(false)
    setShowSubcategories(true)
    
    // Add user message
    const userMessage = {
      role: 'user',
      content: categoryName,
      timestamp: new Date()
    }
    
    // Add bot response with subcategories
    const botMessage = {
      role: 'bot',
      content: `Great choice! Here are the specific topics I can help you with regarding ${categoryName.replace(/^[^\s]+\s/, '')}:`,
      timestamp: new Date(),
      showSubcategories: true,
      subcategories: categoryData.subcategories,
      categoryColor: categoryData.color
    }
    
    setMessages(prev => [...prev, userMessage, botMessage])
  }

  const handleSubcategoryClick = (subcategory) => {
    setShowSubcategories(false)
    
    // Add user message
    const userMessage = {
      role: 'user',
      content: subcategory,
      timestamp: new Date()
    }
    
    setMessages(prev => [...prev, userMessage])
    
    // Send to backend
    sendMessageToBackend(subcategory)
  }

  const sendMessageToBackend = async (message) => {
    setIsLoading(true)

    try {
      const response = await axios.post('/api/chat', {
        message: message
      })

      const botMessage = {
        role: 'bot',
        content: response.data.response,
        timestamp: new Date(),
        source: response.data.source,
        showInputOptions: true
      }

      setMessages(prev => [...prev, botMessage])
    } catch (error) {
      console.error('Error sending message:', error)
      const errorMessage = {
        role: 'bot',
        content: 'Sorry, I encountered an error. Please try again.',
        timestamp: new Date(),
        showInputOptions: true
      }
      setMessages(prev => [...prev, errorMessage])
    } finally {
      setIsLoading(false)
    }
  }


  const handleInputOptionClick = (option) => {
    // Add user message
    const userMessage = {
      role: 'user',
      content: option,
      timestamp: new Date()
    }
    
    setMessages(prev => [...prev, userMessage])
    
    // Handle special case for browsing categories again
    if (option === 'Show me all categories again') {
      const botMessage = {
        role: 'bot',
        content: 'Hello! I\'m your OCC CHATBOT. What are your issues regarding?',
        timestamp: new Date(),
        showCategories: true
      }
      setMessages(prev => [...prev, botMessage])
      setShowCategories(true)
      setShowSubcategories(false)
      setCurrentCategory('')
      return
    }
    
    // Send to backend for other options
    sendMessageToBackend(option)
  }

  const clearHistory = async () => {
    try {
      await axios.delete('http://localhost:5000/history')
      setMessages([
        {
          role: 'bot',
          content: 'Hello! I\'m your OCC CHATBOT. What are your issues regarding?',
          timestamp: new Date(),
          showCategories: true
        }
      ])
      setShowCategories(true)
      setShowSubcategories(false)
      setCurrentCategory('')
    } catch (error) {
      console.error('Error clearing history:', error)
    }
  }

  return (
    <div className="chatbot">
      <div className="chat-header">
        <h2>UW Assistant</h2>
        <button onClick={clearHistory} className="clear-btn">
          Clear Chat
        </button>
      </div>
      
      <div className="messages">
        {messages.map((message, index) => (
          <div key={index} className={`message ${message.role}`}>
            <div className="message-content">
              {message.content}
              {message.source && (
                <div className="message-source">
                  Source: {message.source}
                </div>
              )}
              
              {/* Render category buttons */}
              {message.showCategories && (
                <div className="category-buttons">
                  {Object.keys(categories).map((categoryName) => (
                    <button
                      key={categoryName}
                      className="category-button"
                      onClick={() => handleCategoryClick(categoryName)}
                      style={{ backgroundColor: categories[categoryName].color }}
                    >
                      <span className="category-emoji">{categories[categoryName].emoji}</span>
                      <span className="category-text">{categoryName}</span>
                    </button>
                  ))}
                </div>
              )}
              
              {/* Render subcategory buttons */}
              {message.showSubcategories && message.subcategories && (
                <div className="subcategory-buttons">
                  {message.subcategories.map((subcategory, subIndex) => (
                    <button
                      key={subIndex}
                      className="subcategory-button"
                      onClick={() => handleSubcategoryClick(subcategory)}
                      style={{ borderColor: message.categoryColor }}
                    >
                      {subcategory}
                    </button>
                  ))}
                </div>
              )}
              
              {/* Render input options after answers */}
              {message.showInputOptions && (
                <div className="input-options">
                  <div className="input-options-text">Any other questions?</div>
                  <div className="input-option-buttons">
                    <button
                      className="input-option-button"
                      onClick={() => handleInputOptionClick('Show me all categories again')}
                    >
                      🔄 Browse Categories Again
                    </button>
                    <button
                      className="input-option-button"
                      onClick={() => handleInputOptionClick('I need help with something else')}
                    >
                      💬 Ask Something Else
                    </button>
                  </div>
                </div>
              )}
            </div>
            <div className="message-time">
              {message.timestamp.toLocaleTimeString()}
            </div>
          </div>
        ))}
        {isLoading && (
          <div className="message bot">
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

    </div>
  )
}

export default Chatbot
