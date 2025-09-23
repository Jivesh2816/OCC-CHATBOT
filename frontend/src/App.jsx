import React, { useState } from 'react';
import Chat from './components/Chat';
import './App.css';

function App() {
  return (
    <div className="app">
      <header className="app-header">
        <h1>🤖 Off-Campus Student Support Chatbot</h1>
        <p>Ask me anything about off-campus student life at University of Waterloo!</p>
      </header>
      <main className="app-main">
        <Chat />
      </main>
    </div>
  );
}

export default App;