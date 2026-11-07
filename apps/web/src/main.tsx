import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { installLocalBackend, isLocalMode } from './lib/localBackend';
import { registerServiceWorker } from './lib/push';
import './styles.css';

// Android ships the whole client in the APK: install the in-device database
// before React runs so every /api request and the realtime socket are local.
if (isLocalMode()) installLocalBackend();

const container = document.getElementById('root');
if (container) {
  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  window.addEventListener('load', () => void registerServiceWorker());
}
