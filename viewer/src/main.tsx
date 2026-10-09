import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles/app.css';

// No StrictMode: its double-mounted effects would create and dispose a
// renderer on the same canvas.
createRoot(document.getElementById('root')!).render(<App />);

if (import.meta.env.DEV) void import('./dev/thumbnails');
