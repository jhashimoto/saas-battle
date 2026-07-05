import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import { initLiff } from './liff.js'

initLiff().then(() => {
  createRoot(document.getElementById('root')).render(<StrictMode><App /></StrictMode>)
})
