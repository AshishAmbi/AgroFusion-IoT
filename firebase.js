// Lightweight compat-mode Firebase client for the dashboard
// Uses the global `firebase` object provided by the compat CDN scripts

const firebaseConfig = {
  apiKey: "AIzaSyCvUb7uUIRUAT0_kvmfQgVpq15uXVf6BNQ",
  authDomain: "smart-agriculture-dashboard.firebaseapp.com",
  databaseURL: "https://smart-agriculture-dashboard-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "smart-agriculture-dashboard",
  storageBucket: "smart-agriculture-dashboard.firebasestorage.app",
  messagingSenderId: "179928465532",
  appId: "1:179928465532:web:71c8f79434b967c3f7c9f9"
};

const DB_ROOT = "SmartAgriculture";

let db = null;
let hasReceivedLiveReading = false;

function safeLog(...args) { if (window.location.hostname === "localhost") console.log(...args); }

function initFirebaseCompat() {
  if (typeof firebase === "undefined") {
    console.error("Firebase SDK not found. Make sure the <script> tags for firebase-app-compat.js and firebase-database-compat.js are present before this file.");
    if (typeof window.startDemoDataStream === "function") window.startDemoDataStream();
    return;
  }

  try {
    if (!firebase.apps || !firebase.apps.length) firebase.initializeApp(firebaseConfig);
    db = firebase.database();
    listenConnection();
    listenData();
    listenHardware();
    safeLog("Firebase initialized (compat)");

    // Helpful debug: attempt a REST GET of the DB root and log result.
    // Use `window.debugFetchDatabase()` in the console to re-run on demand.
    (async function tryRest() {
      try {
        await window.debugFetchDatabase();
      } catch (e) { safeLog('REST debug fetch failed', e); }
    })();
  } catch (err) {
    console.error("Firebase init error:", err);
    if (typeof window.startDemoDataStream === "function") window.startDemoDataStream();
  }
}

function listenConnection() {
  try {
    db.ref(".info/connected").on("value", (snap) => {
      const connected = snap.val() === true;
      if (typeof window.handleFirebaseConnectionChange === "function") window.handleFirebaseConnectionChange(connected);
    });
  } catch (e) { console.warn("Connection listener error:", e); }
}

function parseNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function toHwState(raw) {
  if (raw === undefined || raw === null || raw === "") return "offline";
  const v = String(raw).trim().toLowerCase();
  if (["online","true","1","connected"].includes(v)) return "online";
  if (["offline","false","0","disconnected"].includes(v)) return "offline";
  if (["sending","syncing","busy"].includes(v)) return "sending";
  return "sending"; // unknown placeholder values treated as 'sending'
}

function listenData() {
  try {
    // Listen at the DB root and resolve the actual SmartAgriculture node
    const refRoot = db.ref('/');
    refRoot.on("value", (snap) => {
      const root = snap.val();
      if (!root) return;

      // Prefer exact key, otherwise try to find a close match (trimmed / case-insensitive)
      let data = root[DB_ROOT];
      if (!data) {
        const matchKey = Object.keys(root || {}).find((k) => k && String(k).trim() === DB_ROOT) ||
                         Object.keys(root || {}).find((k) => k && String(k).trim().toLowerCase() === DB_ROOT.toLowerCase());
        if (matchKey) {
          console.warn(`Firebase: using fallback root key '${matchKey}' for '${DB_ROOT}'`);
          data = root[matchKey];
        }
      }

      if (!data) return;

      const reading = {
        temperature: parseNumber(data.Temperature),
        humidity: parseNumber(data.Humidity),
        soil: parseNumber(data.Soil),
        airQuality: parseNumber(data.AirQuality),
        pressure: parseNumber(data.Pressure),
        timestamp: data.Timestamp || Date.now()
      };

      if (typeof window.handleIncomingReading === "function") {
        hasReceivedLiveReading = true;
        window.handleIncomingReading(reading);
      }
    }, (err) => { console.error("Realtime read error:", err); });
  } catch (err) { console.error("listenData error:", err); }
}

function listenHardware() {
  try {
    // Hardware information is stored under SmartAgriculture/Hardware — resolve the parent node first
    const refRoot = db.ref('/');
    refRoot.on("value", (snap) => {
      const root = snap.val();
      if (!root) return;

      let node = root[DB_ROOT];
      if (!node) {
        const matchKey = Object.keys(root || {}).find((k) => k && String(k).trim() === DB_ROOT) ||
                         Object.keys(root || {}).find((k) => k && String(k).trim().toLowerCase() === DB_ROOT.toLowerCase());
        if (matchKey) {
          console.warn(`Firebase: using fallback root key '${matchKey}' for '${DB_ROOT}'`);
          node = root[matchKey];
        }
      }
      const hw = (node && node.Hardware) ? node.Hardware : {};
      const mapped = {
        esp32: toHwState(hw.ESP32),
        wifi: toHwState(hw.WiFi),
        firebase: toHwState(hw.Firebase),
        sensors: toHwState(hw.Sensors)
      };
      if (typeof window.handleHardwareStatus === "function") window.handleHardwareStatus(mapped);
    }, (err) => { console.error("Hardware listener error:", err); });
  } catch (err) { console.error("listenHardware error:", err); }
}

// Debug helper: fetch one snapshot and log it to the console
window.testFirebaseSnapshot = async function () {
  try {
    if (!db) return console.warn("DB not ready");
    // Read the DB root and resolve the actual node used by listeners
    const rootSnap = await db.ref('/').once('value');
    const root = rootSnap.val();
    if (!root) return console.log('root is empty');

    // Exact key check
    if (root[DB_ROOT]) {
      console.log(`Resolved exact key '${DB_ROOT}'`);
      console.log('snapshot:', root[DB_ROOT]);
      return root[DB_ROOT];
    }

    // Try trimmed / case-insensitive matches
    const matchKey = Object.keys(root).find((k) => k && String(k).trim() === DB_ROOT) ||
                     Object.keys(root).find((k) => k && String(k).trim().toLowerCase() === DB_ROOT.toLowerCase());
    if (matchKey) {
      console.warn(`Firebase: test helper detected fallback root key '${matchKey}' (mapped to '${DB_ROOT}')`);
      console.log('snapshot:', root[matchKey]);
      return root[matchKey];
    }

    console.log('No matching SmartAgriculture key found at root. Keys at root:', Object.keys(root));
    return null;
  } catch (err) { console.error(err); }
};

// REST debug helper (shows HTTP status + response body for the DB root)
window.debugFetchDatabase = async function () {
  try {
    const base = (firebaseConfig && firebaseConfig.databaseURL) ? firebaseConfig.databaseURL.replace(/\/+$/, '') : null;
    if (!base) return console.warn('No databaseURL in config');
    const url = `${base}/.json`;
    const resp = await fetch(url, { cache: 'no-store' });
    const text = await resp.text();
    console.log('REST GET', url, 'status', resp.status);
    try { console.log('body:', JSON.parse(text)); } catch (_) { console.log('body (raw):', text); }
    return { status: resp.status, body: text };
  } catch (err) { console.error('debugFetchDatabase error:', err); throw err; }
};

document.addEventListener("DOMContentLoaded", () => {
  initFirebaseCompat();

  // Fallback to demo stream if no live readings arrive after a short delay
  setTimeout(() => {
    if (!hasReceivedLiveReading && typeof window.startDemoDataStream === "function") {
      window.startDemoDataStream();
    }
  }, 3000);
});
