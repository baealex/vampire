import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './app/App.tsx';
import { initializeTheme } from './shared/theme/theme.ts';
import '@vampire/lib/shared/theme/tokens.css';
import '@vampire/app.css';

if (import.meta.env.DEV) void import('react-grab');

initializeTheme();

const root = document.getElementById('root');
if (!root) throw new Error('Vampire client root was not found.');

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
