import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { i18nReady } from './i18n';
import './index.css';
import App from './App.tsx';

// Apply the stored theme BEFORE first paint: useTheme() only runs inside Layout, so standalone
// routes (Login) otherwise flash the OS theme on reload even when the user explicitly picked one.
// Mirrors applyTheme: an explicit choice sets data-theme; system/absent leaves it to the media query.
const storedTheme = localStorage.getItem('openwa_theme');
if (storedTheme === 'light' || storedTheme === 'dark') {
  document.documentElement.setAttribute('data-theme', storedTheme);
}

// The active locale is fetched rather than bundled into the entry, so first paint waits for it —
// otherwise the shell renders raw keys and swaps to real copy a tick later. Rendering on rejection
// too: a locale that fails to load must degrade to untranslated text, never to a blank page.
const render = () =>
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );

void i18nReady.then(render, render);
