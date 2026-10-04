import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import './certified.css';
import { App } from './App';
import { installTheme } from './theme';
import './design-system.css';

installTheme();

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
