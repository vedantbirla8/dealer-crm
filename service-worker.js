/*
 * Kubota Dealer Visit CRM — starter service worker
 * ---------------------------------------------------------------
 * Ready to drop onto a real HTTPS-hosted deployment. Two things it
 * cannot do from a local file:// preview: register at all (Chrome
 * blocks SW registration on file://), and receive push notifications
 * (requires a real push server + HTTPS + a registered endpoint).
 *
 * What this gives you out of the box:
 *   1. App-shell caching so the app opens instantly and works offline.
 *   2. A queue for writes made while offline (visits, action items,
 *      photos), flushed automatically when connectivity returns via
 *      the Background Sync API.
 *
 * Wire-up on the page:
 *   if ('serviceWorker' in navigator) {
 *     navigator.serviceWorker.register('/service-worker.js');
 *   }
 */

const CACHE_NAME = 'dealer-crm-shell-v1';
const APP_SHELL = [
  '/',
  '/index.html',
  '/manifest.json',
  // add built CSS/JS bundle paths here once the app is split from a single file
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Cache-first for the app shell, network-first for anything that looks like an API call.
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  const isApi = url.pathname.startsWith('/api/');

  if (isApi) {
    event.respondWith(
      fetch(event.request).catch(() => queueFailedWrite(event.request))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});

// ---- Offline write queue (visits, action items, photo uploads) ----
// Uses IndexedDB rather than localStorage since it supports structured
// clone (blobs/photos) and works inside a service worker.
const DB_NAME = 'dealer-crm-outbox';
const STORE_NAME = 'pending-writes';

function openOutbox() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function queueFailedWrite(request) {
  const body = await request.clone().text().catch(() => null);
  const db = await openOutbox();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).add({
      url: request.url,
      method: request.method,
      body,
      queuedAt: Date.now(),
    });
    tx.oncomplete = resolve;
    tx.onerror = reject;
  });

  if ('sync' in self.registration) {
    await self.registration.sync.register('flush-outbox');
  }

  return new Response(JSON.stringify({ queued: true }), {
    status: 202,
    headers: { 'Content-Type': 'application/json' },
  });
}

self.addEventListener('sync', (event) => {
  if (event.tag === 'flush-outbox') {
    event.waitUntil(flushOutbox());
  }
});

async function flushOutbox() {
  const db = await openOutbox();
  const all = await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

  for (const item of all) {
    try {
      await fetch(item.url, { method: item.method, body: item.body });
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(item.id);
    } catch (e) {
      // still offline — leave it queued, next sync event will retry
    }
  }
}

// ---- Push notifications (requires a real push server) ----
self.addEventListener('push', (event) => {
  const data = event.data ? event.data.json() : {};
  event.waitUntil(
    self.registration.showNotification(data.title || 'Dealer Visit CRM', {
      body: data.body || 'You have an update.',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      data: { url: data.url || '/' },
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(self.clients.openWindow(event.notification.data.url || '/'));
});
