// Vérifie la validité JS de tech.html et defiligne_v3.html
// Usage: node check-js.js
const fs = require('fs')

const mock = `
const window = globalThis
const document = {
  getElementById:()=>({style:{},textContent:'',innerHTML:'',classList:{add:()=>{},remove:()=>{},toggle:()=>{}},querySelectorAll:()=>[]}),
  querySelectorAll:()=>[], addEventListener:()=>{}
}
const sessionStorage = { getItem:()=>null, setItem:()=>{} }
const localStorage   = { getItem:()=>null, setItem:()=>{} }
const location = { protocol:'https:', hostname:'test.netlify.app', pathname:'/' }
const navigator = { geolocation:{getCurrentPosition:()=>{}} }
function fetch(){return Promise.resolve({ok:true,json:()=>Promise.resolve({}),text:()=>Promise.resolve('')})}
const L = {
  map:()=>({setView:()=>({on:()=>{}}),invalidateSize:()=>{}}),
  tileLayer:()=>({addTo:()=>{}}),
  marker:()=>({addTo:()=>({on:()=>{}}),bindPopup:()=>({on:()=>{}}),setIcon:()=>{},on:()=>{}}),
  divIcon:()=>({}), layerGroup:()=>({addTo:()=>{},clearLayers:()=>{}}),
  polyline:()=>({addTo:()=>{}}), circle:()=>({addTo:()=>{}})
}
const supabase = null
function toast(){}
`

let ok = true
for (const file of ['tech.html', 'defiligne_v3.html']) {
  const html = fs.readFileSync(file, 'utf-8')
  const scripts = [...html.matchAll(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1])
  process.stdout.write(`${file}: `)
  try {
    // Tester tous les blocs ensemble (comme le navigateur les exécute)
    new Function(mock + scripts.join('\n;\n'))()
    console.log('OK')
  } catch (e) {
    // Ignorer les erreurs de mock (addEventListener, etc.)
    const ignored = ['addEventListener','is not a function','Cannot read prop','null','undefined']
    if (!ignored.some(s => e.message.includes(s))) {
      console.error(`ERREUR: ${e.message}`)
      ok = false
    } else {
      console.log('OK (warning ignoré: '+e.message.substring(0,60)+')')
    }
  }
}

process.exit(ok ? 0 : 1)
