import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { setupInstall } from './lib/install'

setupInstall()

createRoot(document.getElementById('root')!).render(
  <App />
)
