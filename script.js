/* ==========================================================================
   script.js
   Core dashboard logic: UI rendering, gauges, charts, notifications,
   navigation, and the demo data fallback stream.
   ========================================================================== */

/* --------------------------------------------------------------------------
   State
   -------------------------------------------------------------------------- */
const MAX_HISTORY = 50;

const state = {
  latest: { temperature: null, humidity: null, soil: null, airQuality: null, pressure: null },
  previous: { temperature: null, humidity: null, soil: null, airQuality: null, pressure: null },
  history: {
    labels: [],
    temperature: [],
    humidity: [],
    soil: [],
    airQuality: [],
    pressure: []
  },
  hardware: { esp32: "offline", wifi: "offline", firebase: "offline", sensors: "offline" },
  firebaseConnected: false,
  lastUpdated: null,
  demoActive: false
};

const charts = {};

/* --------------------------------------------------------------------------
   Utility helpers
   -------------------------------------------------------------------------- */
function $(id) { return document.getElementById(id); }

function clamp(val, min, max) { return Math.max(min, Math.min(max, val)); }

function formatTime(date) {
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatDate(date) {
  return date.toLocaleDateString([], { weekday: "short", year: "numeric", month: "short", day: "numeric" });
}

function timeAgo(date) {
  const secs = Math.floor((Date.now() - date.getTime()) / 1000);
  if (secs < 5) return "Just now";
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ago`;
}

/* Smoothly animates a number counting up/down to a target value */
function countUpTo(el, target, decimals = 0, suffix = "") {
  if (!el) return;
  const start = parseFloat(el.dataset.rawValue || "0");
  const end = target;
  const duration = 800;
  const startTime = performance.now();

  function tick(now) {
    const progress = clamp((now - startTime) / duration, 0, 1);
    const eased = 1 - Math.pow(1 - progress, 3); // ease-out-cubic
    const current = start + (end - start) * eased;
    el.textContent = current.toFixed(decimals) + suffix;
    if (progress < 1) {
      requestAnimationFrame(tick);
    } else {
      el.dataset.rawValue = String(end);
    }
  }
  requestAnimationFrame(tick);
}

/* --------------------------------------------------------------------------
   Clock (date / time in navbar)
   -------------------------------------------------------------------------- */
function startClock() {
  function update() {
    const now = new Date();
    $("current-date").textContent = formatDate(now);
    $("current-time").textContent = formatTime(now);
  }
  update();
  setInterval(update, 1000);
}

/* --------------------------------------------------------------------------
   "Last updated" ticker
   -------------------------------------------------------------------------- */
function startAgoTicker() {
  setInterval(() => {
    if (state.lastUpdated) {
      $("last-updated-ago").textContent = `Synced ${timeAgo(state.lastUpdated)}`;
    }
  }, 1000);
}

/* --------------------------------------------------------------------------
   Toast Notifications
   -------------------------------------------------------------------------- */
const TOAST_ICONS = {
  success: "fa-circle-check",
  info: "fa-circle-info",
  warn: "fa-triangle-exclamation",
  error: "fa-circle-xmark"
};

function showToast(message, type = "info", duration = 4000) {
  const container = $("toast-container");
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.innerHTML = `
    <i class="fa-solid ${TOAST_ICONS[type] || TOAST_ICONS.info} toast-icon"></i>
    <span>${message}</span>
  `;
  container.appendChild(toast);

  setTimeout(() => {
    toast.classList.add("leaving");
    setTimeout(() => toast.remove(), 350);
  }, duration);
}

/* --------------------------------------------------------------------------
   Loading screen
   -------------------------------------------------------------------------- */
function initLoadingScreen() {
  // Spawn floating particles
  const particleWrap = $("loading-particles");
  for (let i = 0; i < 24; i++) {
    const p = document.createElement("span");
    p.style.left = `${Math.random() * 100}%`;
    p.style.animationDuration = `${4 + Math.random() * 5}s`;
    p.style.animationDelay = `${Math.random() * 4}s`;
    p.style.opacity = String(0.2 + Math.random() * 0.4);
    particleWrap.appendChild(p);
  }

  const messages = ["Connecting to Firebase...", "Syncing ESP32 node...", "Fetching sensor data...", "Preparing dashboard..."];
  let step = 0;
  const fill = $("loading-bar-fill");
  const text = $("loading-text");

  const interval = setInterval(() => {
    step++;
    fill.style.width = `${Math.min(step * 24, 92)}%`;
    text.textContent = messages[Math.min(step, messages.length - 1)];
  }, 450);

  window.dismissLoadingScreen = function () {
    clearInterval(interval);
    fill.style.width = "100%";
    setTimeout(() => {
      $("loading-screen").classList.add("hidden");
    }, 400);
  };

  // Safety net: never block the UI for more than 6s
  setTimeout(() => {
    if (window.dismissLoadingScreen) window.dismissLoadingScreen();
  }, 6000);
}

/* --------------------------------------------------------------------------
   Sidebar navigation
   -------------------------------------------------------------------------- */
function initNavigation() {
  const links = document.querySelectorAll(".side-link");
  const sections = document.querySelectorAll(".page-section");

  links.forEach((link) => {
    link.addEventListener("click", (e) => {
      e.preventDefault();
      const target = link.dataset.target;

      links.forEach((l) => l.classList.remove("active"));
      link.classList.add("active");

      sections.forEach((s) => s.classList.toggle("active-section", s.id === target));

      // Redraw charts when navigating to history/analytics (canvas sizing fix)
      if (target === "history" || target === "analytics") {
        Object.values(charts).forEach((c) => c && c.resize());
      }

      // Show the latest generated advice as soon as the tab is opened
      if (target === "advisory") {
        renderAdvisory();
      }

      closeSidebarOnMobile();
    });
  });

  $("sidebar-toggle").addEventListener("click", () => {
    $("sidebar").classList.toggle("open");
    $("sidebar-overlay").classList.toggle("show");
  });

  $("sidebar-overlay").addEventListener("click", closeSidebarOnMobile);
}

function closeSidebarOnMobile() {
  $("sidebar").classList.remove("open");
  $("sidebar-overlay").classList.remove("show");
}

/* --------------------------------------------------------------------------
   Status classification rules
   -------------------------------------------------------------------------- */
function classifySoil(v) {
  if (v < 30) return { key: "dry", label: "Dry", cls: "state-bad" };
  if (v > 70) return { key: "wet", label: "Wet", cls: "state-info" };
  return { key: "normal", label: "Normal", cls: "" };
}
function classifyTemp(v) {
  if (v < 15) return { key: "cold", label: "Cold", cls: "state-info" };
  if (v > 35) return { key: "hot", label: "Hot", cls: "state-bad" };
  return { key: "normal", label: "Normal", cls: "" };
}
function classifyHumidity(v) {
  if (v < 30) return { key: "low", label: "Low", cls: "state-warn" };
  if (v > 70) return { key: "high", label: "High", cls: "state-info" };
  return { key: "normal", label: "Normal", cls: "" };
}
function classifyAir(v) {
  if (v < 50) return { key: "excellent", label: "Excellent", cls: "" };
  if (v < 100) return { key: "good", label: "Good", cls: "" };
  if (v < 150) return { key: "moderate", label: "Moderate", cls: "state-warn" };
  if (v < 200) return { key: "poor", label: "Poor", cls: "state-bad" };
  return { key: "danger", label: "Danger", cls: "state-bad" };
}

/* --------------------------------------------------------------------------
   Advisory: fertilizer & farm action rules (based on temperature + humidity)
   -------------------------------------------------------------------------- */
const ADVISORY_RULES = {
  "cold_low": {
    fertilizer: { title: "Potassium-rich fertilizer (e.g. NPK 10-10-20)", detail: "Cold, dry air slows nutrient uptake — favor potassium over nitrogen to improve cold and drought tolerance." },
    actions: [
      "Cover crops with mulch or row covers to retain soil heat and moisture",
      "Irrigate lightly in the late morning once temperatures rise",
      "Avoid nitrogen-heavy feeds until conditions warm up"
    ],
    summary: { title: "Cold & Dry — Protect and Conserve", detail: "Low temperature combined with low humidity stresses young plants through both cold and moisture loss. Focus on insulation and light, well-timed watering." }
  },
  "cold_normal": {
    fertilizer: { title: "Balanced fertilizer (e.g. NPK 10-10-10)", detail: "Moderate humidity in cold weather calls for a balanced feed rather than a heavy nitrogen boost." },
    actions: [
      "Reduce watering frequency since evaporation is naturally low",
      "Protect young seedlings from possible night frost",
      "Delay heavy fertilizer application until temperatures stabilize"
    ],
    summary: { title: "Cold Conditions — Steady and Cautious", detail: "Growth slows in cool weather. Keep inputs modest and prioritize frost protection over feeding." }
  },
  "cold_high": {
    fertilizer: { title: "Phosphorus-potassium fertilizer, avoid excess nitrogen", detail: "Cold and humid conditions raise fungal disease risk — nitrogen encourages soft growth that is more vulnerable." },
    actions: [
      "Improve field drainage and air circulation between plants",
      "Apply a preventive fungicide or neem spray if disease pressure is expected",
      "Avoid overhead irrigation; water at the base of plants instead"
    ],
    summary: { title: "Cold & Humid — Watch for Fungal Disease", detail: "This combination favors mold and fungal growth. Prioritize airflow and drainage over additional feeding." }
  },
  "normal_low": {
    fertilizer: { title: "Balanced NPK with micronutrients", detail: "Warm, dry air increases water demand — a balanced feed with trace minerals supports steady growth." },
    actions: [
      "Increase irrigation frequency, watering early morning or evening",
      "Apply mulch around the root zone to conserve soil moisture",
      "Monitor for signs of wilting during the hottest part of the day"
    ],
    summary: { title: "Warm & Dry — Support Soil Moisture", detail: "Comfortable temperatures but low humidity mean plants lose water quickly. Keep the soil consistently moist." }
  },
  "normal_normal": {
    fertilizer: { title: "Standard balanced fertilizer (e.g. NPK 20-20-20)", detail: "Conditions are within the ideal growth range — apply fertilizer according to the crop's regular growth-stage schedule." },
    actions: [
      "Maintain routine field monitoring and watering schedule",
      "Continue standard pest and weed management",
      "Good window for general fertilizer application if due"
    ],
    summary: { title: "Optimal Conditions — Maintain Routine", detail: "Temperature and humidity are both in a healthy range. Stick to your normal crop care schedule." }
  },
  "normal_high": {
    fertilizer: { title: "Balanced fertilizer, monitor nitrogen levels", detail: "High humidity with mild temperature can favor fungal disease, so avoid over-applying nitrogen which promotes soft, susceptible growth." },
    actions: [
      "Ensure proper drainage and avoid waterlogging",
      "Apply preventive fungicide if humid conditions persist for several days",
      "Space plants and prune for better airflow if possible"
    ],
    summary: { title: "Warm & Humid — Guard Against Disease", detail: "Growth conditions are favorable, but humidity raises fungal and bacterial disease risk. Balance feeding with disease prevention." }
  },
  "hot_low": {
    fertilizer: { title: "Potassium & micronutrient-rich fertilizer", detail: "Heat and drought stress together call for potassium, which strengthens plant resilience; avoid heavy nitrogen during heat stress." },
    actions: [
      "Irrigate more frequently, ideally early morning and evening",
      "Use mulching or shade netting to reduce heat and moisture loss",
      "Avoid fertilizing during the hottest hours of the day"
    ],
    summary: { title: "Hot & Dry — High Stress Alert", detail: "This is the most stressful combination for most crops. Prioritize cooling and irrigation over feeding right now." }
  },
  "hot_normal": {
    fertilizer: { title: "Balanced fertilizer with extra potassium", detail: "Heat increases metabolic demand — potassium helps regulate water use even when humidity is moderate." },
    actions: [
      "Water deeply in the early morning to reduce evaporation loss",
      "Monitor plants for signs of heat stress such as leaf curling",
      "Avoid disturbing roots or transplanting during peak heat"
    ],
    summary: { title: "Hot Conditions — Manage Heat Stress", detail: "Moderate humidity offsets some heat stress, but plants still need extra water and careful timing of field work." }
  },
  "hot_high": {
    fertilizer: { title: "Potassium-rich fertilizer, minimize nitrogen", detail: "Combined heat and humidity stress plants while also encouraging fungal and bacterial growth — keep nitrogen low." },
    actions: [
      "Improve ventilation and spacing between plants",
      "Monitor closely for pests and disease, which thrive in hot, humid air",
      "Avoid waterlogging; ensure excess water can drain away quickly"
    ],
    summary: { title: "Hot & Humid — Double Risk", detail: "Heat stress and disease pressure combine in this condition. Focus on airflow, drainage, and close monitoring." }
  }
};

function generateAdvisory(temp, humidity) {
  const tempKey = classifyTemp(temp).key;       // cold | normal | hot
  const humidKey = classifyHumidity(humidity).key; // low | normal | high
  const rule = ADVISORY_RULES[`${tempKey}_${humidKey}`] || ADVISORY_RULES.normal_normal;
  return rule;
}

/* --------------------------------------------------------------------------
   Rendering: sensor cards
   -------------------------------------------------------------------------- */
function renderSoil(v) {
  const status = classifySoil(v);
  countUpTo($("soil-value"), v, 0);
  $("soil-bar").style.width = `${clamp(v, 0, 100)}%`;

  const circumference = 326.7; // 2 * PI * 52
  const offset = circumference - (clamp(v, 0, 100) / 100) * circumference;
  $("soil-gauge").style.strokeDashoffset = offset;

  const gaugeColor = status.key === "dry" ? "#f87171" : status.key === "wet" ? "#38bdf8" : "#34d399";
  $("soil-gauge").style.stroke = gaugeColor;
  $("soil-bar").style.background = `linear-gradient(90deg, ${gaugeColor}, ${gaugeColor}aa)`;

  updateBadge("soil-status", status.label, status.cls);
  document.querySelector('[data-status].sensor-card .card-icon.soil')?.closest(".sensor-card")?.setAttribute("data-status", status.key);
}

function renderTemperature(v) {
  const status = classifyTemp(v);
  countUpTo($("temp-value"), v, 1);

  const pct = clamp(((v + 10) / 60) * 100, 4, 100); // map -10..50C to 0..100%
  $("thermo-fill").style.height = `${pct}%`;

  const color = status.key === "cold" ? "#38bdf8" : status.key === "hot" ? "#f87171" : "#fb923c";
  $("thermo-fill").style.background = `linear-gradient(180deg, ${color}aa, ${color})`;
  $("thermo-bulb-fill").style.background = color;

  updateBadge("temp-status", status.label, status.cls);
  document.getElementById("temp-status").closest(".sensor-card").setAttribute("data-status", status.key);
}

function renderHumidity(v) {
  const status = classifyHumidity(v);
  countUpTo($("humidity-value"), v, 0);
  $("water-level").style.height = `${clamp(v, 0, 100)}%`;

  const color = status.key === "low" ? "#fbbf24" : status.key === "high" ? "#38bdf8" : "#0ea5e9";
  $("water-level").style.background = `linear-gradient(180deg, ${color}aa, ${color})`;

  updateBadge("humidity-status", status.label, status.cls);
  document.getElementById("humidity-status").closest(".sensor-card").setAttribute("data-status", status.key);
}

function renderAirQuality(v) {
  const status = classifyAir(v);
  countUpTo($("air-value"), v, 0);

  const colorMap = { excellent: "#34d399", good: "#a3e635", moderate: "#fbbf24", poor: "#fb923c", danger: "#f87171" };
  $("air-value").parentElement.style.borderColor = colorMap[status.key];

  const pct = clamp((v / 250) * 100, 2, 100);
  $("aqi-marker").style.left = `${pct}%`;

  updateBadge("air-status", status.label, status.cls);
  document.getElementById("air-status").closest(".sensor-card").setAttribute("data-status", status.key);
}

function renderPressure(v, prevV) {
  countUpTo($("pressure-value"), v, 0);

  const trendEl = $("pressure-trend");
  let trendIcon = "fa-arrow-right", trendLabel = "Stable";
  if (prevV !== null && v - prevV > 0.5) { trendIcon = "fa-arrow-trend-up"; trendLabel = "Rising"; }
  else if (prevV !== null && prevV - v > 0.5) { trendIcon = "fa-arrow-trend-down"; trendLabel = "Falling"; }
  trendEl.innerHTML = `<i class="fa-solid ${trendIcon}"></i> <span>${trendLabel}</span>`;

  const status = (v < 980 || v > 1030) ? { label: "Out of range", cls: "state-warn" } : { label: "Normal", cls: "" };
  updateBadge("pressure-status", status.label, status.cls);
}

function updateBadge(id, label, cls) {
  const el = $(id);
  if (!el) return;
  el.textContent = label;
  el.className = `badge ${cls}`;
}

/* --------------------------------------------------------------------------
   Rendering: weather summary strip
   -------------------------------------------------------------------------- */
function renderWeatherSummary() {
  const { temperature, humidity, pressure, airQuality } = state.latest;
  const { temperature: pt, humidity: ph, pressure: pp, airQuality: pa } = state.previous;

  if (temperature !== null) $("w-temp").textContent = `${temperature.toFixed(1)}°C`;
  if (humidity !== null) $("w-humidity").textContent = `${humidity.toFixed(0)}%`;
  if (pressure !== null) $("w-pressure").textContent = `${pressure.toFixed(0)} hPa`;
  if (airQuality !== null) $("w-air").textContent = classifyAir(airQuality).label;

  setTrendIcon("w-temp-trend", temperature, pt);
  setTrendIcon("w-humidity-trend", humidity, ph);
  setTrendIcon("w-pressure-trend", pressure, pp);
  setTrendIcon("w-air-trend", airQuality, pa);
}

function setTrendIcon(id, current, previous) {
  const el = $(id);
  if (!el || current === null || previous === null) return;
  if (current > previous) {
    el.className = "fa-solid fa-arrow-trend-up trend";
  } else if (current < previous) {
    el.className = "fa-solid fa-arrow-trend-down trend down";
  } else {
    el.className = "fa-solid fa-minus trend";
  }
}

/* --------------------------------------------------------------------------
   Rendering: irrigation prediction
   -------------------------------------------------------------------------- */
function renderPrediction(soil) {
  let level, title, subtitle, need;

  if (soil < 30) {
    level = "dry";
    title = "Irrigation Required";
    subtitle = "Soil moisture has dropped below the healthy threshold. Start irrigation soon to prevent crop stress.";
    need = `${Math.round((30 - soil) * 1.4)} mm`;
  } else if (soil > 70) {
    level = "wet";
    title = "Soil is Wet";
    subtitle = "Moisture levels are high. Hold off on irrigation to avoid waterlogging and root damage.";
    need = "0 mm";
  } else {
    level = "normal";
    title = "Soil Moisture Normal";
    subtitle = "Your field moisture is within the optimal range. No action needed right now.";
    need = "0 mm";
  }

  [["prediction-card", "prediction-title", "prediction-subtitle", "prediction-need"],
   [null, "prediction-title-2", "prediction-subtitle-2", "prediction-need-2"]]
    .forEach(([cardId, titleId, subId, needId]) => {
      if (cardId) $(cardId).dataset.level = level;
      $(titleId).textContent = title;
      $(subId).textContent = subtitle;
      $(needId).textContent = need;
    });

  document.querySelectorAll(".prediction-card").forEach((c) => (c.dataset.level = level));
}

/* --------------------------------------------------------------------------
   Rendering: Advisory page (fertilizer & farm action guidance)
   Refreshes on its own 1-minute cycle, independent of live sensor updates.
   -------------------------------------------------------------------------- */
const ADVISORY_REFRESH_SECONDS = 60;
let advisoryCountdown = ADVISORY_REFRESH_SECONDS;

function renderAdvisory() {
  const temp = state.latest.temperature;
  const humidity = state.latest.humidity;

  if ($("adv-temp")) $("adv-temp").textContent = temp !== null ? `${temp.toFixed(1)}°C` : "--°C";
  if ($("adv-humidity")) $("adv-humidity").textContent = humidity !== null ? `${humidity.toFixed(0)}%` : "--%";

  if (temp === null || humidity === null) {
    if ($("adv-temp-tag")) $("adv-temp-tag").textContent = "Awaiting data";
    if ($("adv-humidity-tag")) $("adv-humidity-tag").textContent = "Awaiting data";
    return; // nothing to advise on yet
  }

  $("adv-temp-tag").textContent = classifyTemp(temp).label;
  $("adv-humidity-tag").textContent = classifyHumidity(humidity).label;

  const advice = generateAdvisory(temp, humidity);

  $("adv-fertilizer-title").textContent = advice.fertilizer.title;
  $("adv-fertilizer-detail").textContent = advice.fertilizer.detail;

  $("adv-actions-list").innerHTML = advice.actions.map((a) => `<li>${a}</li>`).join("");

  $("adv-summary-title").textContent = advice.summary.title;
  $("adv-summary-detail").textContent = advice.summary.detail;

  $("adv-last-updated").textContent = `Advice last generated: ${formatTime(new Date())}`;
}

/* Ticks every second: counts down the "next refresh" chip and regenerates
   the advisory once per minute, independent of how often sensor data arrives. */
function startAdvisoryCycle() {
  renderAdvisory(); // initial render (shows "waiting" state until data arrives)

  setInterval(() => {
    advisoryCountdown -= 1;
    if (advisoryCountdown <= 0) {
      advisoryCountdown = ADVISORY_REFRESH_SECONDS;
      renderAdvisory();
    }
    if ($("adv-next-update")) $("adv-next-update").textContent = `${advisoryCountdown}s`;
  }, 1000);
}

/* --------------------------------------------------------------------------
   Rendering: hardware status
   -------------------------------------------------------------------------- */
function applyHwDot(id, status) {
  const el = $(id);
  if (!el) return;
  el.classList.remove("online", "offline", "sending");
  if (status === "online") el.classList.add("online");
  else if (status === "sending") el.classList.add("sending");
  else el.classList.add("offline");
}

function renderHardwareStatus(hw) {
  const prev = { ...state.hardware };
  state.hardware = hw;

  ["esp32", "wifi", "firebase", "sensors"].forEach((key) => {
    applyHwDot(`hw-${key}`, hw[key]);
    const dpId = { esp32: "dp-esp32", wifi: "dp-wifi", firebase: "dp-firebase" }[key];
    if (dpId) applyHwDot(dpId, hw[key]);
  });

  const overall = Object.values(hw).every((s) => s === "online") ? "online" :
                   Object.values(hw).some((s) => s === "offline") ? "offline" : "sending";
  applyHwDot("hw-system", overall);

  $("sidebar-hw-status").textContent =
    overall === "online" ? "All systems online" : overall === "offline" ? "Attention needed" : "Sending data…";

  // Toast on meaningful transitions
  Object.keys(hw).forEach((key) => {
    if (prev[key] && prev[key] !== hw[key]) {
      const name = { esp32: "ESP32", wifi: "WiFi", firebase: "Firebase", sensors: "Sensors" }[key];
      if (hw[key] === "online") showToast(`${name} Connected`, "success");
      else if (hw[key] === "offline") showToast(`${name} Offline`, "error");
    }
  });
}

/* --------------------------------------------------------------------------
   WiFi / Firebase status chips (top navbar)
   -------------------------------------------------------------------------- */
function setConnectionChip(chipPrefix, connected, sending = false) {
  const dot = $(`${chipPrefix}-dot`);
  const text = $(`${chipPrefix}-status-text`);
  dot.classList.remove("online", "offline");
  if (connected) {
    dot.classList.add("online");
    text.textContent = sending ? "Sending" : "Connected";
  } else {
    dot.classList.add("offline");
    text.textContent = "Offline";
  }
}

window.handleFirebaseConnectionChange = function (connected) {
  const wasConnected = state.firebaseConnected;
  state.firebaseConnected = connected;
  setConnectionChip("firebase", connected);
  setConnectionChip("wifi", connected); // WiFi mirrors Firebase reachability in this demo

  if (window.dismissLoadingScreen) window.dismissLoadingScreen();

  if (connected && !wasConnected) {
    showToast("Firebase Connected", "success");
    showToast("WiFi Connected", "success");
  } else if (!connected && wasConnected) {
    showToast("Hardware Offline", "error");
  }
};

/* --------------------------------------------------------------------------
   Incoming reading handler (called by firebase.js or the demo stream)
   -------------------------------------------------------------------------- */
window.handleIncomingReading = function (reading) {
  state.previous = { ...state.latest };

  if (reading.temperature !== null) state.latest.temperature = reading.temperature;
  if (reading.humidity !== null) state.latest.humidity = reading.humidity;
  if (reading.soil !== null) state.latest.soil = reading.soil;
  if (reading.airQuality !== null) state.latest.airQuality = reading.airQuality;
  if (reading.pressure !== null) state.latest.pressure = reading.pressure;

  const now = new Date(typeof reading.timestamp === "number" ? reading.timestamp : Date.now());
  state.lastUpdated = now;
  $("last-updated-time").textContent = formatTime(now);

  if (state.latest.soil !== null) renderSoil(state.latest.soil);
  if (state.latest.temperature !== null) renderTemperature(state.latest.temperature);
  if (state.latest.humidity !== null) renderHumidity(state.latest.humidity);
  if (state.latest.airQuality !== null) renderAirQuality(state.latest.airQuality);
  if (state.latest.pressure !== null) renderPressure(state.latest.pressure, state.previous.pressure);
  if (state.latest.soil !== null) renderPrediction(state.latest.soil);

  renderWeatherSummary();
  pushHistory(now);
  updateCharts();

  showToast("Sensor Updated", "info", 2200);
};

window.handleHardwareStatus = function (hw) {
  renderHardwareStatus(hw);
};

/* --------------------------------------------------------------------------
   History buffer (last 50 readings) + Charts
   -------------------------------------------------------------------------- */
function pushHistory(date) {
  const h = state.history;
  h.labels.push(formatTime(date));
  h.temperature.push(state.latest.temperature);
  h.humidity.push(state.latest.humidity);
  h.soil.push(state.latest.soil);
  h.airQuality.push(state.latest.airQuality);
  h.pressure.push(state.latest.pressure);

  Object.keys(h).forEach((key) => {
    if (h[key].length > MAX_HISTORY) h[key].shift();
  });
}

function baseChartOptions(yLabel) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 650, easing: "easeOutCubic" },
    interaction: { mode: "index", intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: "rgba(15,47,39,0.9)",
        titleColor: "#fff",
        bodyColor: "#d1fae5",
        borderColor: "rgba(255,255,255,0.2)",
        borderWidth: 1,
        padding: 10,
        cornerRadius: 10
      }
    },
    scales: {
      x: {
        ticks: { color: "rgba(255,255,255,0.55)", maxTicksLimit: 8, font: { size: 10 } },
        grid: { color: "rgba(255,255,255,0.06)" }
      },
      y: {
        ticks: { color: "rgba(255,255,255,0.55)", font: { size: 10 } },
        grid: { color: "rgba(255,255,255,0.08)" },
        title: { display: !!yLabel, text: yLabel, color: "rgba(255,255,255,0.5)", font: { size: 10 } }
      }
    }
  };
}

function makeGradient(ctx, colorStart, colorEnd) {
  const gradient = ctx.createLinearGradient(0, 0, 0, 260);
  gradient.addColorStop(0, colorStart);
  gradient.addColorStop(1, colorEnd);
  return gradient;
}

function initCharts() {
  const specs = [
    { id: "chart-temperature", key: "temperature", label: "°C", color: "#f87171" },
    { id: "chart-humidity", key: "humidity", label: "%", color: "#38bdf8" },
    { id: "chart-soil", key: "soil", label: "%", color: "#34d399" },
    { id: "chart-air", key: "airQuality", label: "MQ135", color: "#a78bfa" },
    { id: "chart-pressure", key: "pressure", label: "hPa", color: "#fbbf24" }
  ];

  specs.forEach((spec) => {
    const canvas = $(spec.id);
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const gradient = makeGradient(ctx, `${spec.color}55`, `${spec.color}00`);

    charts[spec.key] = new Chart(ctx, {
      type: "line",
      data: {
        labels: state.history.labels,
        datasets: [{
          data: state.history[spec.key],
          borderColor: spec.color,
          backgroundColor: gradient,
          borderWidth: 2.5,
          fill: true,
          tension: 0.4,
          pointRadius: 0,
          pointHoverRadius: 5,
          pointHoverBackgroundColor: spec.color
        }]
      },
      options: baseChartOptions(spec.label)
    });
  });

  // Overview (all metrics normalized) chart for Analytics tab
  const overviewCanvas = $("chart-overview");
  if (overviewCanvas) {
    charts.overview = new Chart(overviewCanvas.getContext("2d"), {
      type: "line",
      data: {
        labels: state.history.labels,
        datasets: [
          { label: "Temperature (°C)", data: state.history.temperature, borderColor: "#f87171", backgroundColor: "transparent", borderWidth: 2, tension: 0.4, pointRadius: 0 },
          { label: "Humidity (%)", data: state.history.humidity, borderColor: "#38bdf8", backgroundColor: "transparent", borderWidth: 2, tension: 0.4, pointRadius: 0 },
          { label: "Soil (%)", data: state.history.soil, borderColor: "#34d399", backgroundColor: "transparent", borderWidth: 2, tension: 0.4, pointRadius: 0 },
          { label: "Air Quality", data: state.history.airQuality, borderColor: "#a78bfa", backgroundColor: "transparent", borderWidth: 2, tension: 0.4, pointRadius: 0 },
          { label: "Pressure (hPa)", data: state.history.pressure, borderColor: "#fbbf24", backgroundColor: "transparent", borderWidth: 2, tension: 0.4, pointRadius: 0 }
        ]
      },
      options: {
        ...baseChartOptions(""),
        plugins: {
          ...baseChartOptions("").plugins,
          legend: { display: true, labels: { color: "rgba(255,255,255,0.75)", boxWidth: 12, font: { size: 10 } } }
        }
      }
    });
  }
}

function updateCharts() {
  Object.entries(charts).forEach(([key, chart]) => {
    if (!chart) return;
    chart.data.labels = state.history.labels;
    if (key === "overview") {
      chart.data.datasets[0].data = state.history.temperature;
      chart.data.datasets[1].data = state.history.humidity;
      chart.data.datasets[2].data = state.history.soil;
      chart.data.datasets[3].data = state.history.airQuality;
      chart.data.datasets[4].data = state.history.pressure;
    } else {
      chart.data.datasets[0].data = state.history[key];
    }
    chart.update("none");
  });
}

/* --------------------------------------------------------------------------
   Demo data stream (fallback when Firebase isn't configured yet)
   -------------------------------------------------------------------------- */
window.startDemoDataStream = function () {
  if (state.demoActive) return;
  state.demoActive = true;

  showToast("Using demo data — connect Firebase to go live", "warn", 5000);

  let sim = { temperature: 26, humidity: 55, soil: 45, airQuality: 55, pressure: 1012 };

  function randomWalk(val, step, min, max) {
    const next = val + (Math.random() - 0.5) * step;
    return clamp(next, min, max);
  }

  function tick() {
    sim = {
      temperature: randomWalk(sim.temperature, 1.2, 5, 42),
      humidity: randomWalk(sim.humidity, 3, 10, 95),
      soil: randomWalk(sim.soil, 4, 5, 95),
      airQuality: randomWalk(sim.airQuality, 4, 40, 70),
      pressure: randomWalk(sim.pressure, 1.5, 970, 1035)
    };

    window.handleIncomingReading({ ...sim, timestamp: Date.now() });
  }

  // Simulate hardware coming online
  window.handleHardwareStatus({ esp32: "online", wifi: "online", firebase: "sending", sensors: "online" });
  window.handleFirebaseConnectionChange(true);
  setTimeout(() => window.handleHardwareStatus({ esp32: "online", wifi: "online", firebase: "online", sensors: "online" }), 2000);

  tick();
  setInterval(tick, 4000);

  // Occasional signal strength refresh for the settings panel
  setInterval(() => {
    const bars = document.querySelectorAll("#dp-signal i");
    const activeCount = Math.floor(Math.random() * 2) + 3; // 3-4 bars
    bars.forEach((bar, i) => bar.classList.toggle("active", i < activeCount));
    $("dp-last-sync").textContent = formatTime(new Date());
  }, 6000);
};

/* --------------------------------------------------------------------------
   Init
   -------------------------------------------------------------------------- */
document.addEventListener("DOMContentLoaded", () => {
  $("footer-year").textContent = new Date().getFullYear();

  initLoadingScreen();
  startClock();
  startAgoTicker();
  initNavigation();
  initCharts();
  startAdvisoryCycle();

  // Pre-seed signal bars in settings panel
  document.querySelectorAll("#dp-signal i").forEach((bar, i) => bar.classList.toggle("active", i < 3));
});
