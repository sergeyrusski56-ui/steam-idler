import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';

// Intercept and ignore benign Vite HMR websocket reconnection failures
if (typeof window !== 'undefined') {
  const ignoreHMRPattern = (str: any) => {
    if (!str) return false;
    const s = String(str).toLowerCase();
    return s.includes('websocket') || s.includes('closed without opened') || s.includes('hmr');
  };

  window.addEventListener('unhandledrejection', (e) => {
    const reason = e.reason;
    if (
      ignoreHMRPattern(reason) ||
      ignoreHMRPattern(reason?.message) ||
      ignoreHMRPattern(reason?.stack)
    ) {
      e.preventDefault();
      e.stopPropagation();
    }
  });

  window.addEventListener('error', (e) => {
    if (
      ignoreHMRPattern(e.message) ||
      ignoreHMRPattern(e.error) ||
      ignoreHMRPattern(e.error?.message)
    ) {
      e.preventDefault();
      e.stopPropagation();
    }
  }, true);
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
