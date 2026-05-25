// Service Worker pour OptiTechX Technicien
const CACHE_NAME = 'optitechx-tech-v1'
const STATIC_ASSETS = [
  '/tech.html',
  '/manifest.json',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css'
]

// Installation du service worker
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(STATIC_ASSETS).catch(() => {
        console.log('Certains assets statiques ne peuvent pas être mis en cache offline')
      })
    })
  )
  self.skipWaiting()
})

// Activation - nettoyer les anciens caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          if (cacheName !== CACHE_NAME) {
            return caches.delete(cacheName)
          }
        })
      )
    })
  )
  self.clients.claim()
})

// Stratégie: network-first avec fallback cache
self.addEventListener('fetch', event => {
  const {request} = event
  const url = new URL(request.url)

  // Ignorer les requêtes cross-origin et les blob
  if (url.origin !== location.origin || request.method !== 'GET') return

  // API calls: network-first avec cache fallback
  if (url.pathname.includes('/api/') || url.pathname.includes('notion')) {
    event.respondWith(
      fetch(request).then(response => {
        if (response.ok) {
          const cache = caches.open(CACHE_NAME)
          cache.then(c => c.put(request, response.clone()))
        }
        return response
      }).catch(() => {
        return caches.match(request).then(cached => {
          return cached || new Response(JSON.stringify({offline: true, cached: true}), {
            headers: {'Content-Type': 'application/json'}
          })
        })
      })
    )
    return
  }

  // Ressources statiques: cache-first
  event.respondWith(
    caches.match(request).then(cached => {
      return cached || fetch(request).then(response => {
        if (response.ok && (url.pathname.endsWith('.html') || url.pathname.endsWith('.js') || url.pathname.endsWith('.css'))) {
          caches.open(CACHE_NAME).then(cache => cache.put(request, response.clone()))
        }
        return response
      })
    })
  )
})

// Sync en arrière-plan
self.addEventListener('sync', event => {
  if (event.tag === 'sync-interventions') {
    event.waitUntil(syncInterventions())
  }
})

async function syncInterventions() {
  try {
    const response = await fetch('/api/notion', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({action: 'query'})
    })
    if (response.ok) {
      const data = await response.json()
      const cache = await caches.open(CACHE_NAME)
      await cache.put('/api/notion-sync', response.clone())
    }
  } catch (e) {
    console.log('Sync offline, données mises en cache')
  }
}
