import React, { useEffect, useState } from 'react'
import Chatbot from './components/Chatbot'
import './App.css'

// Students never open the staff queue, so its code is only fetched for /#/staff.
const StaffDashboard = React.lazy(() => import('./components/StaffDashboard'))

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
      {route === 'staff' ? (
        <React.Suspense fallback={null}>
          <StaffDashboard />
        </React.Suspense>
      ) : (
        <Chatbot />
      )}
    </div>
  )
}

export default App
