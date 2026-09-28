import React, { useEffect, useState } from 'react'
import Chatbot from './components/Chatbot'
import StaffDashboard from './components/StaffDashboard'
import './App.css'

// Hash routing keeps the static Vercel deploy working without rewrite rules:
// "/#/staff" opens the staff queue, everything else is the student app.
const currentRoute = () => (window.location.hash.startsWith('#/staff') ? 'staff' : 'chat')

function App() {
  const [route, setRoute] = useState(currentRoute)

  useEffect(() => {
    const onHashChange = () => setRoute(currentRoute())
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  return (
    <div className="App">
      {route === 'staff' ? <StaffDashboard /> : <Chatbot />}
    </div>
  )
}

export default App
