import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import WelcomeWindow from './components/WelcomeWindow';
import VoicePill from './components/VoicePill';
import { ThemeProvider } from './context/ThemeContext';
import './styles/index.css';

// Same Vite bundle serves three BrowserWindows, selected by URL hash:
//   #welcome → first-run onboarding, #pill → the dictation overlay, else → dock.
const route = typeof window !== 'undefined' ? window.location.hash : '';
const isWelcome = route === '#welcome';
const isPill = route === '#pill';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ThemeProvider>
      {isWelcome ? <WelcomeWindow /> : isPill ? <VoicePill /> : <App />}
    </ThemeProvider>
  </React.StrictMode>
);
