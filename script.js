/* ============================================================
   نظام إدارة الصرافة وسحوبات شام كاش — المنطق البرمجي (نسخة v2)
   IndexedDB (تخزين أوفلاين) + Telegram Bot API + تعدد عملات +
   طباعة إيصالات + تصدير CSV/PDF + نسخ احتياطي يدوي + تقفيل يومي + PWA
   ============================================================ */

/* ------------------------------------------------------------
   0) إعدادات عامة — عدّل رقم الواتساب هنا فقط
   ------------------------------------------------------------ */
// رقم الواتساب الدولي بدون علامة + وبدون 00 في البداية (مثال سوريا: 963991234567)
const WHATSAPP_NUMBER = "963930621982";

const TRIAL_DURATION_MS = 72 * 60 * 60 * 1000; // 72 ساعة = 3 أيام
const LS_KEY_FIRST_RUN = "exchangeSys_firstRunTime";
const LS_KEY_LAST_VISIT = "exchangeSys_lastVisitedTime";

const CURRENCIES = [
  { code: "USD", label: "دولار أمريكي" },
  { code: "TRY", label: "ليرة تركية" },
  { code: "EUR", label: "يورو" },
  { code: "SAR", label: "ريال سعودي" },
];
function currencyLabel(code) {
  const c = CURRENCIES.find((c) => c.code === code);
  return c ? `${c.label} (${c.code})` : code;
}

/* ------------------------------------------------------------
   1) طبقة قاعدة البيانات (IndexedDB)
   ------------------------------------------------------------ */
const DB_NAME = "ShamCashExchangeDB";
const DB_VERSION = 2; // رُفع من 1 إلى 2 لإضافة مخزن "positions" (محرك المخزون WAC)
let db = null;

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const database = event.target.result;
      if (!database.objectStoreNames.contains("operations")) {
        const store = database.createObjectStore("operations", {
          keyPath: "id",
          autoIncrement: true,
        });
        store.createIndex("timestamp", "timestamp", { unique: false });
        store.createIndex("type", "type", { unique: false });
        store.createIndex("synced", "synced", { unique: false });
      }
      if (!database.objectStoreNames.contains("settings")) {
        database.createObjectStore("settings", { keyPath: "key" });
      }
      if (!database.objectStoreNames.contains("positions")) {
        // مخزن "مراكز العملات": سجل واحد لكل عملة {currency_code, balance, avg_cost}
        database.createObjectStore("positions", { keyPath: "currency_code" });
      }
    };

    request.onsuccess = (event) => resolve(event.target.result);
    request.onerror = (event) => reject(event.target.error);
  });
}

function dbGetPosition(currencyCode) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction("positions", "readonly");
    const req = tx.objectStore("positions").get(currencyCode);
    req.onsuccess = () =>
      resolve(req.result || { currency_code: currencyCode, balance: 0, avg_cost: 0 });
    req.onerror = () => reject(req.error);
  });
}

function dbSetPosition(position) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction("positions", "readwrite");
    tx.objectStore("positions").put(position);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

function dbGetAllPositions() {
  return new Promise((resolve, reject) => {
    const tx = db.transaction("positions", "readonly");
    const req = tx.objectStore("positions").getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

function dbGetSetting(key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction("settings", "readonly");
    const req = tx.objectStore("settings").get(key);
    req.onsuccess = () => resolve(req.result ? req.result.value : null);
    req.onerror = () => reject(req.error);
  });
}

function dbSetSetting(key, value) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction("settings", "readwrite");
    tx.objectStore("settings").put({ key, value });
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

function dbAddOperation(op) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction("operations", "readwrite");
    const req = tx.objectStore("operations").add(op);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function dbUpdateOperation(op) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction("operations", "readwrite");
    tx.objectStore("operations").put(op);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

function dbDeleteOperation(id) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction("operations", "readwrite");
    tx.objectStore("operations").delete(id);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

function dbGetAllOperations() {
  return new Promise((resolve, reject) => {
    const tx = db.transaction("operations", "readonly");
    const req = tx.objectStore("operations").getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

function dbClearOperations() {
  return new Promise((resolve, reject) => {
    const tx = db.transaction("operations", "readwrite");
    tx.objectStore("operations").clear();
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

/* ------------------------------------------------------------
   2) الحالة العامة للتطبيق
   ------------------------------------------------------------ */
const state = {
  rates: {
    USD: { buy: 0, sell: 0 },
    TRY: { buy: 0, sell: 0 },
    EUR: { buy: 0, sell: 0 },
    SAR: { buy: 0, sell: 0 },
  },
  positions: {
    USD: { balance: 0, avg_cost: 0 },
    TRY: { balance: 0, avg_cost: 0 },
    EUR: { balance: 0, avg_cost: 0 },
    SAR: { balance: 0, avg_cost: 0 },
  },
  telegram: { botToken: "", chatId: "" },
  fxMode: "buy", // buy | sell
  printSize: "80", // 80 | 58
  logFilter: "all", // all | fx | sc
  operations: [],
};

const els = {};
let deferredInstallPrompt = null;

/* ------------------------------------------------------------
   3) أدوات مساعدة
   ------------------------------------------------------------ */
function fmt(num, maxDecimals = 2) {
  const n = Number(num) || 0;
  return n.toLocaleString("en-US", { maximumFractionDigits: maxDecimals });
}

function isSameDay(ts, ref) {
  const a = new Date(ts);
  return (
    a.getFullYear() === ref.getFullYear() &&
    a.getMonth() === ref.getMonth() &&
    a.getDate() === ref.getDate()
  );
}

function showToast(message, isError = false) {
  const toast = els.toast;
  toast.textContent = message;
  toast.className = "toast" + (isError ? " toast--error" : "");
  toast.hidden = false;
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => {
    toast.hidden = true;
  }, 2800);
}

function formatTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString("ar-SY", { hour: "2-digit", minute: "2-digit" });
}

function formatDateTime(ts) {
  const d = new Date(ts);
  return d.toLocaleString("ar-SY");
}

function csvEscape(value) {
  const s = String(value ?? "");
  if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function getOfficeName() {
  return document.querySelector(".brand__text strong")?.textContent?.trim() || "مكتب الصرافة";
}

/* ------------------------------------------------------------
   4) محرك تيليجرام (إرسال + طابور أوفلاين)
   ------------------------------------------------------------ */

/* حدث "online" في المتصفح قد يُطلَق قبل أن يصبح الاتصال الفعلي بالإنترنت
   جاهزاً تماماً، فتفشل أول محاولة إرسال بصمت وتبقى العملية "قيد الانتظار"
   بلا أي محاولة تلقائية لاحقة. لذلك نضيف فحصاً دورياً يعيد المحاولة تلقائياً
   طالما هناك عمليات غير مُرسَلة والاتصال متوفر — دون حذف أو تغيير زر
   "إعادة المحاولة" اليدوي، الذي يبقى يعمل كما هو. */
const AUTO_SYNC_RETRY_MS = 8000;
let autoSyncTimer = null;

function startAutoSyncWatcher() {
  if (autoSyncTimer) return;
  autoSyncTimer = setInterval(() => {
    if (navigator.onLine && state.operations.some((o) => !o.synced)) {
      syncPendingOperations();
    }
  }, AUTO_SYNC_RETRY_MS);
}

function buildTelegramText(op) {
  if (op.type === "fx") {
    const modeLabel = op.mode === "buy" ? "شراء من زبون" : "مبيع لزبون";
    const amount = op.amount ?? op.amountUsd ?? 0;
    const currency = op.currency || "USD";
    const profitLine =
      op.mode === "buy"
        ? `متوسط التكلفة الجديد: ${fmt(op.avgCostAfter, 0)} ل.س (لا يوجد ربح عند الشراء)`
        : `الربح المحقق: ${fmt(op.profit, 0)} ل.س (بناءً على تكلفة ${fmt(op.avgCostUsed, 0)} ل.س)`;
    return (
      `*عملية صرافة جديدة* 💱\n` +
      `العملة: ${currencyLabel(currency)}\n` +
      `النوع: ${modeLabel}\n` +
      `المبلغ: ${fmt(amount)} ${currency}\n` +
      `السعر المستخدم: ${fmt(op.rateUsed, 0)} ل.س\n` +
      `المبلغ المحوَّل: ${fmt(op.cashAmount, 0)} ل.س\n` +
      `${profitLine}\n` +
      `الوقت: ${formatTime(op.timestamp)}\n` +
      "```json\n" + JSON.stringify(op) + "\n```"
    );
  }
  return (
    `*عملية شام كاش جديدة* 📲\n` +
    `المبلغ المسحوب: ${fmt(op.amountSc, 0)} ل.س\n` +
    `نسبة العمولة: ${fmt(op.commissionPct)}٪\n` +
    `الصافي للزبون: ${fmt(op.cashAmount, 0)} ل.س\n` +
    `ربح الصراف: ${fmt(op.profit, 0)} ل.س (≈ ${fmt(op.profitUsd)} USD)\n` +
    `الوقت: ${formatTime(op.timestamp)}\n` +
    "```json\n" + JSON.stringify(op) + "\n```"
  );
}

async function sendTelegramMessage(text) {
  if (!state.telegram.botToken || !state.telegram.chatId) {
    return { ok: false, reason: "no-config" };
  }
  if (!navigator.onLine) {
    return { ok: false, reason: "offline" };
  }
  try {
    const url = `https://api.telegram.org/bot${state.telegram.botToken}/sendMessage`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: state.telegram.chatId,
        text: text,
        parse_mode: "Markdown",
      }),
    });
    const data = await res.json();
    if (data.ok) return { ok: true };
    return { ok: false, reason: "api-error", detail: data.description };
  } catch (err) {
    return { ok: false, reason: "network-error", detail: String(err) };
  }
}

async function trySendOperation(op) {
  const result = await sendTelegramMessage(buildTelegramText(op));
  op.synced = !!result.ok;
  await dbUpdateOperation(op);
  return result;
}

async function syncPendingOperations() {
  const pending = state.operations.filter((o) => !o.synced);
  if (pending.length === 0) {
    updateSyncBadge();
    return;
  }
  updateSyncBadge(true);
  for (const op of pending) {
    await trySendOperation(op);
  }
  await refreshOperationsFromDb();
  updateSyncBadge();
}

/* ------------------------------------------------------------
   5) حالة الاتصال والشارات
   ------------------------------------------------------------ */
function updateConnBadge() {
  const online = navigator.onLine;
  els.badgeConn.className = "badge " + (online ? "badge--ok" : "badge--warn");
  els.badgeConnText.textContent = online ? "متصل" : "غير متصل";
}

function updateSyncBadge(forcePending = false) {
  const hasPending = forcePending || state.operations.some((o) => !o.synced);
  const configured = !!(state.telegram.botToken && state.telegram.chatId);
  if (!configured) {
    els.badgeSync.className = "badge badge--muted";
    els.badgeSyncText.textContent = "تيليجرام غير مُفعّل";
  } else if (hasPending) {
    els.badgeSync.className = "badge badge--pending";
    const count = state.operations.filter((o) => !o.synced).length;
    els.badgeSyncText.textContent = `بانتظار المزامنة (${count})`;
  } else {
    els.badgeSync.className = "badge badge--ok";
    els.badgeSyncText.textContent = "متزامن";
  }
}

/* ------------------------------------------------------------
   6) حاسبة شام كاش
   ------------------------------------------------------------ */
function recalcSc() {
  const amount = parseFloat(els.scAmount.value) || 0;
  const commissionPct = parseFloat(els.scCommission.value) || 0;
  const commissionAmount = amount * (commissionPct / 100);
  const netToCustomer = amount - commissionAmount;
  const avgRate = (state.rates.USD.buy + state.rates.USD.sell) / 2 || 1;
  const profitUsd = commissionAmount / avgRate;

  els.scNetToCustomer.textContent = fmt(netToCustomer, 0) + " ل.س";
  els.scProfitSyp.textContent = fmt(commissionAmount, 0) + " ل.س";
  els.scProfitUsd.textContent = fmt(profitUsd) + " USD";

  return { amount, commissionPct, commissionAmount, netToCustomer, profitUsd };
}

async function saveScOperation() {
  const { amount, commissionPct, commissionAmount, netToCustomer, profitUsd } = recalcSc();
  if (amount <= 0) {
    showToast("أدخل مبلغاً صحيحاً أولاً", true);
    return;
  }
  const op = {
    type: "sc",
    amountSc: amount,
    commissionPct,
    cashAmount: netToCustomer,
    profit: commissionAmount,
    profitUsd,
    timestamp: Date.now(),
    synced: false,
  };
  const id = await dbAddOperation(op);
  op.id = id;
  state.operations.unshift(op);
  els.scAmount.value = "";
  els.scCommission.value = "";
  recalcSc();
  renderAll();
  showToast("تم حفظ عملية شام كاش");
  trySendOperation(op).then(() => refreshOperationsFromDb());
}

/* ------------------------------------------------------------
   7) حاسبة الصرافة (متعددة العملات) — مبنية على محرك المخزون WAC
   ------------------------------------------------------------ */
function recalcFx() {
  const currency = els.fxCurrency.value;
  const amount = parseFloat(els.fxAmount.value) || 0;
  const rates = state.rates[currency] || { buy: 0, sell: 0 };
  const position = state.positions[currency] || { balance: 0, avg_cost: 0 };
  const rateUsed = state.fxMode === "buy" ? rates.buy : rates.sell;
  const cashAmount = amount * rateUsed;

  // تحديث معلومات المركز الظاهرة فوق الحاسبة (رصيدك الحالي / متوسط تكلفتك)
  els.fxPosBalance.textContent = `${fmt(position.balance)} ${currency}`;
  els.fxPosAvgCost.textContent = fmt(position.avg_cost, 0);

  els.fxRateUsed.textContent = fmt(rateUsed, 0);
  els.fxResultAmount.textContent = fmt(cashAmount, 0) + " ل.س";

  let newAvgCost = position.avg_cost;
  let realizedProfit = 0;

  if (state.fxMode === "buy") {
    els.fxResultLabel.textContent = "المبلغ الواجب دفعه للزبون";
    const newBalance = position.balance + amount;
    newAvgCost = newBalance > 0
      ? ((position.balance * position.avg_cost) + (amount * rateUsed)) / newBalance
      : 0;
    els.fxNewAvgCostRow.hidden = false;
    els.fxNewAvgCost.textContent = fmt(newAvgCost, 0) + " ل.س";
    els.fxProfitRow.hidden = true;
  } else {
    els.fxResultLabel.textContent = "المبلغ الواجب استلامه من الزبون";
    realizedProfit = amount * (rateUsed - position.avg_cost);
    els.fxProfitRow.hidden = false;
    els.fxSpreadProfit.textContent = fmt(realizedProfit, 0) + " ل.س";
    els.fxNewAvgCostRow.hidden = true;
  }

  return { currency, amount, rateUsed, cashAmount, position, newAvgCost, realizedProfit };
}

async function saveFxOperation() {
  const { currency, amount, rateUsed, cashAmount, position, newAvgCost, realizedProfit } = recalcFx();
  if (amount <= 0) {
    showToast("أدخل مبلغاً صحيحاً أولاً", true);
    return;
  }

  if (state.fxMode === "sell" && amount > position.balance) {
    // حماية المخزون: لا يمكن بيع كمية أكبر مما هو متوفر فعلياً بالدرج
    showToast(`رصيدك الحالي من ${currency} فقط ${fmt(position.balance)} — لا يمكن بيع أكثر من المتوفر`, true);
    return;
  }

  const op = {
    type: "fx",
    mode: state.fxMode,
    currency,
    amount,
    rateUsed,
    cashAmount,
    timestamp: Date.now(),
    synced: false,
  };

  let updatedPosition;
  if (state.fxMode === "buy") {
    op.profit = 0;
    op.avgCostAfter = newAvgCost;
    updatedPosition = {
      currency_code: currency,
      balance: position.balance + amount,
      avg_cost: newAvgCost,
    };
  } else {
    op.profit = realizedProfit;
    op.avgCostUsed = position.avg_cost;
    updatedPosition = {
      currency_code: currency,
      balance: position.balance - amount,
      avg_cost: position.avg_cost, // متوسط التكلفة لا يتغيّر عند البيع
    };
  }

  await dbSetPosition(updatedPosition);
  state.positions[currency] = { balance: updatedPosition.balance, avg_cost: updatedPosition.avg_cost };
  renderPortfolio();

  const id = await dbAddOperation(op);
  op.id = id;
  state.operations.unshift(op);
  els.fxAmount.value = "";
  recalcFx();
  renderAll();

  if (state.fxMode === "buy") {
    showToast(`تم تحديث الرصيد — متوسط التكلفة الجديد: ${fmt(newAvgCost, 0)} ل.س`);
  } else {
    showToast("تم حفظ عملية البيع وتسجيل الربح المحقق");
  }
  trySendOperation(op).then(() => refreshOperationsFromDb());
}

/* ------------------------------------------------------------
   8) لوحة الإحصائيات (KPI) والمحفظة الحالية
   ------------------------------------------------------------ */
function renderPortfolio() {
  els.portfolioGrid.innerHTML = CURRENCIES.map((c) => {
    const pos = state.positions[c.code] || { balance: 0, avg_cost: 0 };
    const marketSell = (state.rates[c.code] || { sell: 0 }).sell;
    const unrealizedPnl = pos.balance * (marketSell - pos.avg_cost);
    const pnlClass = unrealizedPnl >= 0 ? "is-positive" : "is-negative";
    const pnlSign = unrealizedPnl >= 0 ? "+" : "";
    return `
      <div class="portfolio-card">
        <span class="portfolio-card__title">${c.label} (${c.code})</span>
        <div class="portfolio-card__row"><span>الرصيد المتوفر</span><b>${fmt(pos.balance)} ${c.code}</b></div>
        <div class="portfolio-card__row"><span>متوسط التكلفة</span><b>${fmt(pos.avg_cost, 0)} ل.س</b></div>
        <div class="portfolio-card__pnl ${pnlClass}">
          <span>ربح/خسارة نظرية</span>
          <b>${pnlSign}${fmt(unrealizedPnl, 0)} ل.س</b>
        </div>
      </div>
    `;
  }).join("");
}

function renderKpis() {
  const today = new Date();
  const todaysOps = state.operations.filter((o) => isSameDay(o.timestamp, today));

  let scTotal = 0;
  let fxCount = 0;
  let profitFx = 0;
  let profitSc = 0;

  todaysOps.forEach((o) => {
    if (o.type === "sc") {
      scTotal += o.amountSc;
      profitSc += o.profit;
    } else if (o.type === "fx") {
      fxCount += 1;
      profitFx += o.profit;
    }
  });

  els.kpiShamcashTotal.textContent = fmt(scTotal, 0);
  els.kpiFxCount.textContent = fmt(fxCount, 0);
  els.kpiProfitFx.textContent = fmt(profitFx, 0);
  els.kpiProfitSc.textContent = fmt(profitSc, 0);
  els.kpiProfitTotal.textContent = fmt(profitFx + profitSc, 0);
}

/* ------------------------------------------------------------
   9) جدول سجل العمليات
   ------------------------------------------------------------ */
function getFilteredOperations() {
  return state.operations.filter((o) => {
    if (state.logFilter === "all") return true;
    return o.type === state.logFilter;
  });
}

function opDetailsText(op) {
  if (op.type === "fx") {
    const amount = op.amount ?? op.amountUsd ?? 0;
    const currency = op.currency || "USD";
    return `${op.mode === "buy" ? "شراء" : "مبيع"} ${fmt(amount)} ${currency}`;
  }
  return `سحب ${fmt(op.amountSc, 0)} ل.س`;
}

function opRateText(op) {
  return op.type === "fx" ? `${fmt(op.rateUsed, 0)} ل.س` : `${fmt(op.commissionPct)}٪`;
}

/* عمليات الشراء لا تحقق ربحاً (WAC) — تُعرض بدلاً من ذلك متوسط التكلفة
   الجديد بعد الشراء. عمليات المبيع وشام كاش تعرض الربح المحقق كالمعتاد. */
function opProfitCellHtml(op) {
  if (op.type === "fx" && op.mode === "buy") {
    return `<span class="cost-cell">تكلفة جديدة: ${fmt(op.avgCostAfter, 0)} ل.س</span>`;
  }
  return `<span class="profit-cell">${fmt(op.profit, 0)} ل.س</span>`;
}

function renderLogTable() {
  const filtered = getFilteredOperations();

  els.logTableBody.innerHTML = "";
  els.logEmptyState.hidden = filtered.length > 0;

  filtered.forEach((op, idx) => {
    const tr = document.createElement("tr");

    const deptLabel =
      op.type === "fx"
        ? `<span class="tag-dept tag-dept--fx">صرافة</span>`
        : `<span class="tag-dept tag-dept--sc">شام كاش</span>`;

    const currencyCell = op.type === "fx" ? (op.currency || "USD") : "—";
    const cashGiven = fmt(op.cashAmount, 0) + " ل.س";

    const syncPill = op.synced
      ? `<span class="sync-pill sync-pill--synced">✓ متزامن</span>`
      : `<span class="sync-pill sync-pill--pending">⏳ بالانتظار</span>`;

    tr.innerHTML = `
      <td>${filtered.length - idx}</td>
      <td>${formatTime(op.timestamp)}</td>
      <td>${deptLabel}</td>
      <td>${currencyCell}</td>
      <td>${opDetailsText(op)}</td>
      <td>${opRateText(op)}</td>
      <td>${cashGiven}</td>
      <td>${opProfitCellHtml(op)}</td>
      <td>${syncPill}</td>
      <td>
        <div class="row-actions">
          <button class="btn-print" title="طباعة إيصال" data-id="${op.id}">🖨</button>
          <button class="btn-resend" title="إعادة إرسال لتيليجرام" data-id="${op.id}">↻</button>
          <button class="btn-delete" title="حذف العملية" data-id="${op.id}">🗑</button>
        </div>
      </td>
    `;
    els.logTableBody.appendChild(tr);
  });

  els.logTableBody.querySelectorAll(".btn-delete").forEach((btn) => {
    btn.addEventListener("click", () => handleDeleteOperation(Number(btn.dataset.id)));
  });
  els.logTableBody.querySelectorAll(".btn-resend").forEach((btn) => {
    btn.addEventListener("click", () => handleResendOperation(Number(btn.dataset.id)));
  });
  els.logTableBody.querySelectorAll(".btn-print").forEach((btn) => {
    btn.addEventListener("click", () => printReceipt(Number(btn.dataset.id)));
  });
}

async function handleDeleteOperation(id) {
  const op = state.operations.find((o) => o.id === id);

  if (op && op.type === "fx") {
    // نُعيد أثر العملية على رصيد المخزون فقط (وليس متوسط التكلفة، الذي
    // لا يمكن التراجع عنه رياضياً بدقة بعد عمليات لاحقة) حتى لا يبقى
    // الرصيد المعروض خاطئاً بعد حذف عملية شراء أو بيع قديمة.
    const currency = op.currency || "USD";
    const amount = op.amount ?? op.amountUsd ?? 0;
    const position = state.positions[currency] || { balance: 0, avg_cost: 0 };
    const newBalance =
      op.mode === "buy" ? Math.max(0, position.balance - amount) : position.balance + amount;
    const updatedPosition = { currency_code: currency, balance: newBalance, avg_cost: position.avg_cost };
    await dbSetPosition(updatedPosition);
    state.positions[currency] = { balance: updatedPosition.balance, avg_cost: updatedPosition.avg_cost };
  }

  await dbDeleteOperation(id);
  state.operations = state.operations.filter((o) => o.id !== id);
  renderAll();
  showToast("تم حذف العملية وتحديث رصيد المحفظة");
}

async function handleResendOperation(id) {
  const op = state.operations.find((o) => o.id === id);
  if (!op) return;
  showToast("جاري إعادة الإرسال...");
  const result = await trySendOperation(op);
  await refreshOperationsFromDb();
  if (result.ok) showToast("تم إرسال العملية إلى تيليجرام");
  else showToast("تعذّر الإرسال، سيُعاد المحاولة عند توفر الاتصال", true);
}

/* ------------------------------------------------------------
   10) طباعة إيصال حراري (58mm / 80mm)
   ------------------------------------------------------------ */
function buildReceiptHtml(op) {
  const officeName = getOfficeName();
  const deptLabel = op.type === "fx" ? "صرافة" : "شام كاش";
  return `
    <div class="receipt__title">${officeName}</div>
    <div class="receipt__divider"></div>
    <div class="receipt__row"><span>رقم العملية</span><span>#${op.id}</span></div>
    <div class="receipt__row"><span>التاريخ والوقت</span><span>${formatDateTime(op.timestamp)}</span></div>
    <div class="receipt__row"><span>القسم</span><span>${deptLabel}</span></div>
    <div class="receipt__divider"></div>
    <div class="receipt__row"><span>التفاصيل</span><span>${opDetailsText(op)}</span></div>
    <div class="receipt__row"><span>السعر / النسبة</span><span>${opRateText(op)}</span></div>
    <div class="receipt__row"><span>المبلغ المسلَّم</span><span>${fmt(op.cashAmount, 0)} ل.س</span></div>
    <div class="receipt__divider"></div>
    <div class="receipt__footer">شكراً لتعاملكم معنا</div>
  `;
}

function printReceipt(id) {
  const op = state.operations.find((o) => o.id === id);
  if (!op) return;
  const container = els.receiptPrintArea;
  container.className = `print-only receipt-${state.printSize}`;
  container.innerHTML = buildReceiptHtml(op);
  container.classList.add("is-printing");
  window.print();
}

/* ------------------------------------------------------------
   11) تصدير CSV / Excel وتقرير PDF (عبر طباعة المتصفح)
   ------------------------------------------------------------ */
function exportCsv() {
  const rows = [
    ["#", "الوقت", "التاريخ", "القسم", "العملة", "التفاصيل", "السعر/النسبة", "الكاش المسلم", "صافي الربح", "الحالة"],
  ];
  const filtered = getFilteredOperations();
  filtered.forEach((op, idx) => {
    const d = new Date(op.timestamp);
    rows.push([
      filtered.length - idx,
      formatTime(op.timestamp),
      d.toLocaleDateString("ar-SY"),
      op.type === "fx" ? "صرافة" : "شام كاش",
      op.type === "fx" ? op.currency || "USD" : "—",
      opDetailsText(op),
      opRateText(op),
      fmt(op.cashAmount, 0),
      fmt(op.profit, 0),
      op.synced ? "متزامن" : "بالانتظار",
    ]);
  });
  const csvContent = rows.map((r) => r.map(csvEscape).join(",")).join("\n");
  // إضافة BOM لضمان ظهور الحروف العربية بشكل صحيح عند فتح الملف في Excel
  const blob = new Blob(["\uFEFF" + csvContent], { type: "text/csv;charset=utf-8;" });
  const dateStr = new Date().toISOString().slice(0, 10);
  downloadBlob(blob, `سجل-العمليات-${dateStr}.csv`);
  showToast("تم تصدير ملف CSV بنجاح");
}

/* يعتمد تصدير PDF على أمر الطباعة المدمج في المتصفح (Save as PDF)،
   وهذا يعمل بشكل كامل بدون إنترنت ودون أي مكتبات خارجية. */
function buildReportHtml(ops) {
  const officeName = getOfficeName();
  const rowsHtml = ops
    .map(
      (op, idx) => `
      <tr>
        <td>${ops.length - idx}</td>
        <td>${formatTime(op.timestamp)}</td>
        <td>${op.type === "fx" ? "صرافة" : "شام كاش"}</td>
        <td>${op.type === "fx" ? op.currency || "USD" : "—"}</td>
        <td>${opDetailsText(op)}</td>
        <td>${opRateText(op)}</td>
        <td>${fmt(op.cashAmount, 0)} ل.س</td>
        <td>${fmt(op.profit, 0)} ل.س</td>
      </tr>`
    )
    .join("");

  return `
    <h1>${officeName}</h1>
    <div class="report__meta">تقرير سجل العمليات — تاريخ الطباعة: ${formatDateTime(Date.now())}</div>
    <table>
      <thead>
        <tr>
          <th>#</th><th>الوقت</th><th>القسم</th><th>العملة</th>
          <th>التفاصيل</th><th>السعر/النسبة</th><th>الكاش المسلم</th><th>صافي الربح</th>
        </tr>
      </thead>
      <tbody>${rowsHtml}</tbody>
    </table>
  `;
}

function exportPdfReport() {
  const filtered = getFilteredOperations();
  if (filtered.length === 0) {
    showToast("لا توجد عمليات لتصديرها", true);
    return;
  }
  const container = els.reportPrintArea;
  container.innerHTML = buildReportHtml(filtered);
  container.classList.add("is-printing");
  window.print();
}

/* بعد إغلاق نافذة الطباعة (سواء طُبعت أو أُلغيت) نعيد إخفاء منطقتي
   الطباعة حتى لا تبقيا ظاهرتين بالخطأ في أي طباعة لاحقة للصفحة */
window.addEventListener("afterprint", () => {
  els.receiptPrintArea?.classList.remove("is-printing");
  els.reportPrintArea?.classList.remove("is-printing");
});

/* ------------------------------------------------------------
   12) تبويب الإعدادات: أسعار العملات
   ------------------------------------------------------------ */
function renderRatesGrid() {
  els.ratesGrid.innerHTML = CURRENCIES.map((c) => {
    const r = state.rates[c.code] || { buy: 0, sell: 0 };
    return `
      <div class="rate-card">
        <span class="rate-card__title">${c.label} (${c.code})</span>
        <div class="rate-card__row">
          <div class="rate-card__field">
            <label>سعر الشراء</label>
            <input type="number" inputmode="decimal" id="rate-${c.code}-buy" value="${r.buy || ""}">
          </div>
          <div class="rate-card__field">
            <label>سعر المبيع</label>
            <input type="number" inputmode="decimal" id="rate-${c.code}-sell" value="${r.sell || ""}">
          </div>
        </div>
      </div>
    `;
  }).join("");
}

async function saveRatesFromGrid() {
  const newRates = {};
  CURRENCIES.forEach((c) => {
    const buyEl = document.getElementById(`rate-${c.code}-buy`);
    const sellEl = document.getElementById(`rate-${c.code}-sell`);
    newRates[c.code] = {
      buy: parseFloat(buyEl.value) || 0,
      sell: parseFloat(sellEl.value) || 0,
    };
  });
  state.rates = newRates;
  await dbSetSetting("ratesMulti", newRates);
  recalcFx();
  recalcSc();
  renderPortfolio();
  showToast("تم حفظ كل الأسعار بنجاح");
}

/* ------------------------------------------------------------
   12ب) نافذة الرصيد الافتتاحي / تصحيح الجرد (Capital Modal)
   تُستخدم لحالتين: الإعداد الأول الإجباري، والتصحيح اليدوي لاحقاً
   ------------------------------------------------------------ */
function renderCapitalModalGrid() {
  els.capitalModalGrid.innerHTML = CURRENCIES.map((c) => {
    const pos = state.positions[c.code] || { balance: 0, avg_cost: 0 };
    return `
      <div class="capital-card">
        <span class="capital-card__title">${c.label} (${c.code})</span>
        <div class="capital-card__row">
          <div class="capital-card__field">
            <label>الكمية المتوفرة حالياً</label>
            <input type="number" inputmode="decimal" id="capital-${c.code}-balance" value="${pos.balance || ""}">
          </div>
          <div class="capital-card__field">
            <label>متوسط سعر التكلفة (ل.س)</label>
            <input type="number" inputmode="decimal" id="capital-${c.code}-avgcost" value="${pos.avg_cost || ""}">
          </div>
        </div>
      </div>
    `;
  }).join("");
}

function openCapitalModal(forced) {
  els.capitalModalTitle.textContent = forced
    ? "الرصيد الافتتاحي لكل عملة (إعداد أول مرة)"
    : "جرد وتصحيح رصيد الصندوق";
  els.btnCloseCapitalModal.hidden = !!forced;
  renderCapitalModalGrid();
  els.capitalModal.hidden = false;
}

function closeCapitalModal() {
  els.capitalModal.hidden = true;
}

async function saveCapitalModal() {
  const updated = {};
  for (const c of CURRENCIES) {
    const balanceEl = document.getElementById(`capital-${c.code}-balance`);
    const avgCostEl = document.getElementById(`capital-${c.code}-avgcost`);
    const balance = parseFloat(balanceEl.value) || 0;
    const avg_cost = parseFloat(avgCostEl.value) || 0;
    updated[c.code] = { balance, avg_cost };
    await dbSetPosition({ currency_code: c.code, balance, avg_cost });
  }
  state.positions = updated;
  await dbSetSetting("capitalSetupDone", true);
  renderPortfolio();
  recalcFx();
  closeCapitalModal();
  showToast("تم حفظ رصيد المحفظة بنجاح");
}

/* ------------------------------------------------------------
   13) تبويب الإعدادات: تيليجرام
   ------------------------------------------------------------ */
async function saveTelegramSettings() {
  state.telegram.botToken = els.tgBotToken.value.trim();
  state.telegram.chatId = els.tgChatId.value.trim();
  await dbSetSetting("telegram", state.telegram);
  updateSyncBadge();
  showToast("تم حفظ إعدادات تيليجرام");
}

async function testTelegramMessage() {
  state.telegram.botToken = els.tgBotToken.value.trim();
  state.telegram.chatId = els.tgChatId.value.trim();
  if (!state.telegram.botToken || !state.telegram.chatId) {
    showToast("أدخل Bot Token و Chat ID أولاً", true);
    return;
  }
  const result = await sendTelegramMessage("✅ رسالة تجريبية من لوحة تحكم الصرافة");
  if (result.ok) showToast("تم إرسال الرسالة التجريبية بنجاح");
  else showToast("فشل الإرسال — تحقق من البيانات أو الاتصال", true);
}

/* ------------------------------------------------------------
   14) تبويب الإعدادات: النسخ الاحتياطي اليدوي (Export/Import)
   ------------------------------------------------------------ */
async function exportBackup() {
  const operations = await dbGetAllOperations();
  const positions = await dbGetAllPositions();
  const backup = {
    app: "shamcash-exchange",
    version: 3,
    exportedAt: Date.now(),
    operations,
    positions,
    settings: {
      ratesMulti: state.rates,
      telegram: state.telegram,
      printSize: state.printSize,
    },
  };
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
  const dateStr = new Date().toISOString().slice(0, 10);
  downloadBlob(blob, `backup-${dateStr}.json`);
  showToast("تم تصدير النسخة الاحتياطية بنجاح");
}

async function importBackupFile(file) {
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch (err) {
    showToast("ملف غير صالح، تأكد أنه ملف JSON صحيح", true);
    return;
  }
  if (!data || !Array.isArray(data.operations)) {
    showToast("صيغة الملف غير متوافقة مع هذا النظام", true);
    return;
  }

  const confirmed = window.confirm(
    "سيتم استبدال كل البيانات الحالية (العمليات، المحفظة، الأسعار، الإعدادات) بمحتوى الملف المستورد. هل أنت متأكد؟"
  );
  if (!confirmed) return;

  await dbClearOperations();
  for (const op of data.operations) {
    const clone = { ...op };
    delete clone.id; // نترك المعرّف يُولَّد تلقائياً لتفادي أي تعارض
    await dbAddOperation(clone);
  }

  if (Array.isArray(data.positions)) {
    for (const pos of data.positions) {
      await dbSetPosition(pos);
      state.positions[pos.currency_code] = { balance: pos.balance, avg_cost: pos.avg_cost };
    }
  }

  if (data.settings) {
    if (data.settings.ratesMulti) {
      state.rates = data.settings.ratesMulti;
      await dbSetSetting("ratesMulti", state.rates);
    }
    if (data.settings.telegram) {
      state.telegram = data.settings.telegram;
      await dbSetSetting("telegram", state.telegram);
    }
    if (data.settings.printSize) {
      state.printSize = data.settings.printSize;
      await dbSetSetting("printSize", state.printSize);
    }
  }

  renderRatesGrid();
  renderPortfolio();
  els.tgBotToken.value = state.telegram.botToken || "";
  els.tgChatId.value = state.telegram.chatId || "";
  applyPrintSizeToggleUI();
  await refreshOperationsFromDb();
  recalcFx();
  recalcSc();
  showToast("تم استيراد النسخة الاحتياطية بنجاح");
}

/* ------------------------------------------------------------
   15) تبويب الإعدادات: التقفيل اليومي وإرسال ملخص تيليجرام
   ------------------------------------------------------------ */
function buildClosingReportText(todaysOps) {
  const byCurrency = {};
  CURRENCIES.forEach((c) => (byCurrency[c.code] = { bought: 0, sold: 0, profit: 0 }));

  let scTotal = 0;
  let scProfit = 0;

  todaysOps.forEach((op) => {
    if (op.type === "fx") {
      const currency = op.currency || "USD";
      if (!byCurrency[currency]) byCurrency[currency] = { bought: 0, sold: 0, profit: 0 };
      const amount = op.amount ?? op.amountUsd ?? 0;
      if (op.mode === "buy") byCurrency[currency].bought += amount;
      else byCurrency[currency].sold += amount;
      byCurrency[currency].profit += op.profit;
    } else if (op.type === "sc") {
      scTotal += op.amountSc;
      scProfit += op.profit;
    }
  });

  let fxProfitTotal = 0;
  let currencyLines = "";
  CURRENCIES.forEach((c) => {
    const d = byCurrency[c.code];
    fxProfitTotal += d.profit;
    if (d.bought > 0 || d.sold > 0) {
      currencyLines += `  • ${c.label}: شراء ${fmt(d.bought)} / بيع ${fmt(d.sold)} — ربح ${fmt(d.profit, 0)} ل.س\n`;
    }
  });
  if (!currencyLines) currencyLines = "  لا توجد عمليات صرافة اليوم\n";

  let positionsLines = "";
  CURRENCIES.forEach((c) => {
    const pos = state.positions[c.code] || { balance: 0, avg_cost: 0 };
    if (pos.balance > 0) {
      const marketSell = (state.rates[c.code] || { sell: 0 }).sell;
      const unrealizedPnl = pos.balance * (marketSell - pos.avg_cost);
      const sign = unrealizedPnl >= 0 ? "+" : "";
      positionsLines += `  • ${c.label}: الرصيد ${fmt(pos.balance)} ${c.code} | التكلفة ${fmt(pos.avg_cost, 0)} ل.س | تقييم نظري: ${sign}${fmt(unrealizedPnl, 0)} ل.س\n`;
    }
  });
  if (!positionsLines) positionsLines = "  لا يوجد رصيد مفتوح حالياً بأي عملة\n";

  const grandProfit = fxProfitTotal + scProfit;
  const dateStr = new Date().toLocaleDateString("ar-SY");

  return (
    `*📊 تقرير تقفيل اليوم — ${dateStr}*\n\n` +
    `*عمليات الصرافة حسب العملة (الربح المحقق فقط):*\n${currencyLines}\n` +
    `*شام كاش:*\n` +
    `  إجمالي السحوبات: ${fmt(scTotal, 0)} ل.س\n` +
    `  ربح العمولات: ${fmt(scProfit, 0)} ل.س\n\n` +
    `*🗃️ المراكز المفتوحة (نهاية الوردية):*\n${positionsLines}\n` +
    `*الإجمالي العام (الربح المحقق فقط):*\n` +
    `  صافي ربح الصرافة: ${fmt(fxProfitTotal, 0)} ل.س\n` +
    `  صافي ربح شام كاش: ${fmt(scProfit, 0)} ل.س\n` +
    `  *الصافي الكلي لليوم: ${fmt(grandProfit, 0)} ل.س*`
  );
}

async function updateLastClosingHint() {
  const last = await dbGetSetting("lastClosingDate");
  if (last) {
    els.lastClosingHint.textContent = `آخر تقفيل تم إرساله: ${formatDateTime(last)}`;
  } else {
    els.lastClosingHint.textContent = "لم يتم تقفيل أي يوم بعد على هذا الجهاز.";
  }
}

async function performDailyClosing() {
  const today = new Date();
  const todaysOps = state.operations.filter((o) => isSameDay(o.timestamp, today));
  if (todaysOps.length === 0) {
    showToast("لا توجد عمليات اليوم لتقفيلها", true);
    return;
  }
  if (!state.telegram.botToken || !state.telegram.chatId) {
    showToast("فعّل إعدادات تيليجرام أولاً لإرسال تقرير التقفيل", true);
    return;
  }
  showToast("جاري إرسال تقرير التقفيل...");
  const text = buildClosingReportText(todaysOps);
  const result = await sendTelegramMessage(text);
  if (result.ok) {
    await dbSetSetting("lastClosingDate", Date.now());
    await updateLastClosingHint();
    showToast("تم إرسال تقرير التقفيل بنجاح");
  } else {
    showToast("تعذّر إرسال التقرير — تحقق من الاتصال وحاول مجدداً", true);
  }
}

/* ------------------------------------------------------------
   16) حجم ورق الطباعة الحرارية
   ------------------------------------------------------------ */
function applyPrintSizeToggleUI() {
  els.printSizeToggle.querySelectorAll(".segmented__btn").forEach((btn) => {
    btn.classList.toggle("is-active", btn.dataset.size === state.printSize);
  });
}

/* ------------------------------------------------------------
   17) التبويبات (Tabs)
   ------------------------------------------------------------ */
function switchTab(tabName) {
  document.querySelectorAll(".tabs__btn").forEach((btn) => {
    btn.classList.toggle("is-active", btn.dataset.tab === tabName);
  });
  document.querySelectorAll(".tab-panel").forEach((panel) => {
    panel.classList.toggle("is-active", panel.dataset.panel === tabName);
  });
}

/* ------------------------------------------------------------
   18) PWA — تسجيل Service Worker وزر التثبيت
   ------------------------------------------------------------ */
function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  // يفشل التسجيل بصمت عند الفتح المباشر من القرص (file://) أو بدون خادم،
  // وهذا قيد من المتصفح نفسه ولا يؤثر على عمل باقي التطبيق أوفلاين.
  navigator.serviceWorker.register("service-worker.js").catch(() => {
    // التثبيت لا يعمل من file:// أو من دون HTTPS/localhost.
    if (location.protocol === "file:") {
      showToast("افتح التطبيق عبر localhost أو HTTPS لتفعيل التثبيت", true);
    }
  });
}

function setupInstallPrompt() {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    els.btnInstallApp.hidden = false;
  });

  window.addEventListener("appinstalled", () => {
    els.btnInstallApp.hidden = true;
    deferredInstallPrompt = null;
    showToast("تم تثبيت التطبيق على الجهاز بنجاح");
  });

  els.btnInstallApp.addEventListener("click", async () => {
    if (!deferredInstallPrompt) {
      showToast("التثبيت غير متاح حالياً. افتح التطبيق عبر HTTPS أو localhost", true);
      return;
    }
    const installPrompt = deferredInstallPrompt;
    deferredInstallPrompt = null;
    try {
      await installPrompt.prompt();
      const choice = await installPrompt.userChoice;
      if (choice.outcome === "accepted") {
        els.btnInstallApp.hidden = true;
      } else {
        els.btnInstallApp.hidden = true;
        showToast("تم إلغاء التثبيت. أعد فتح الصفحة للمحاولة مجدداً", true);
      }
    } catch (error) {
      els.btnInstallApp.hidden = true;
      showToast("تعذر فتح نافذة التثبيت. أعد تحميل الصفحة وحاول مجدداً", true);
    }
  });
}

/* ------------------------------------------------------------
   19) الفترة التجريبية (3 أيام) ومنع التلاعب
   ------------------------------------------------------------ */
async function checkTrialLock() {
  const now = Date.now();

  const lsFirstRaw = localStorage.getItem(LS_KEY_FIRST_RUN);
  const lsFirst = lsFirstRaw !== null ? Number(lsFirstRaw) : null;
  const idbFirst = await dbGetSetting("firstRunTime");

  let locked = false;
  let reason = "";

  if (lsFirst === null && idbFirst === null) {
    await dbSetSetting("firstRunTime", now);
    localStorage.setItem(LS_KEY_FIRST_RUN, String(now));
  } else if (lsFirst === null || idbFirst === null || lsFirst !== idbFirst) {
    locked = true;
    reason = "storage-mismatch";
  } else {
    const elapsed = now - idbFirst;
    if (elapsed >= TRIAL_DURATION_MS) {
      locked = true;
      reason = "expired";
    }
  }

  const lsLastRaw = localStorage.getItem(LS_KEY_LAST_VISIT);
  const idbLast = await dbGetSetting("lastVisitedTime");
  const lastVisited = Math.max(Number(lsLastRaw) || 0, Number(idbLast) || 0);

  if (!locked && lastVisited && now < lastVisited) {
    locked = true;
    reason = "clock-rollback";
  }

  if (!locked) {
    localStorage.setItem(LS_KEY_LAST_VISIT, String(now));
    await dbSetSetting("lastVisitedTime", now);
  }

  return { locked, reason };
}

function applyTrialLockScreen() {
  document.querySelectorAll("input, button, select, textarea").forEach((el) => {
    el.disabled = true;
  });

  const whatsappMessage = encodeURIComponent(
    "مرحباً، انتهت الفترة التجريبية لنظام إدارة الصرافة وشام كاش وأرغب بالحصول على النسخة الكاملة."
  );
  const whatsappLink = `https://wa.me/${WHATSAPP_NUMBER}?text=${whatsappMessage}`;

  const overlay = document.createElement("div");
  overlay.id = "trialLockOverlay";
  overlay.innerHTML = `
    <div class="trial-lock__box">
      <div class="trial-lock__icon">🔒</div>
      <h2>انتهت الفترة التجريبية للنظام</h2>
      <p>للحصول على النسخة الكاملة يرجى التواصل مع الدعم الفني</p>
      <a class="trial-lock__btn" href="${whatsappLink}" target="_blank" rel="noopener noreferrer">
        تواصل عبر واتساب للتفعيل
      </a>
    </div>
  `;
  document.body.appendChild(overlay);
}

/* ------------------------------------------------------------
   20) دوال العرض الشاملة + التحميل الأولي
   ------------------------------------------------------------ */
function renderAll() {
  renderKpis();
  renderPortfolio();
  renderLogTable();
  updateSyncBadge();
}

async function refreshOperationsFromDb() {
  const all = await dbGetAllOperations();
  state.operations = all.sort((a, b) => b.timestamp - a.timestamp);
  renderAll();
}

function cacheElements() {
  const ids = [
    "btnInstallApp",
    "badgeConn", "badgeConnText", "badgeSync", "badgeSyncText",
    "kpiShamcashTotal", "kpiFxCount",
    "kpiProfitTotal", "kpiProfitFx", "kpiProfitSc",
    "portfolioGrid", "btnOpenInventoryAdjust",
    "scAmount", "scCommission", "scNetToCustomer", "scProfitSyp", "scProfitUsd", "btnSaveSc",
    "fxMode", "fxCurrency", "fxAmount", "fxRateUsed", "fxResultLabel", "fxResultAmount",
    "fxPosBalance", "fxPosAvgCost", "fxNewAvgCostRow", "fxNewAvgCost", "fxProfitRow",
    "fxSpreadProfit", "btnSaveFx",
    "logFilter", "btnExportCsv", "btnExportPdf", "logTableBody", "logEmptyState",
    "ratesGrid", "btnSaveRates", "printSizeToggle",
    "btnOpenInitialCapital",
    "capitalModal", "capitalModalTitle", "capitalModalGrid", "btnCloseCapitalModal", "btnSaveCapitalModal",
    "tgBotToken", "tgChatId", "btnTestTelegram", "btnSaveSettings",
    "btnExportBackup", "fileImportBackup",
    "btnDailyClosing", "lastClosingHint",
    "toast", "receiptPrintArea", "reportPrintArea",
  ];
  ids.forEach((id) => (els[id] = document.getElementById(id)));
}

function attachEventListeners() {
  document.querySelectorAll(".tabs__btn").forEach((btn) => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  });

  // شام كاش
  els.scAmount.addEventListener("input", recalcSc);
  els.scCommission.addEventListener("input", recalcSc);
  [els.scAmount, els.scCommission].forEach((input) => {
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") saveScOperation();
    });
  });
  els.btnSaveSc.addEventListener("click", saveScOperation);

  // الصرافة
  els.fxMode.querySelectorAll(".segmented__btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.fxMode = btn.dataset.mode;
      els.fxMode.querySelectorAll(".segmented__btn").forEach((b) => b.classList.remove("is-active"));
      btn.classList.add("is-active");
      recalcFx();
    });
  });
  els.fxCurrency.addEventListener("change", recalcFx);
  els.fxAmount.addEventListener("input", recalcFx);
  els.fxAmount.addEventListener("keydown", (e) => {
    if (e.key === "Enter") saveFxOperation();
  });
  els.btnSaveFx.addEventListener("click", saveFxOperation);

  // السجل
  els.logFilter.querySelectorAll(".segmented__btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.logFilter = btn.dataset.filter;
      els.logFilter.querySelectorAll(".segmented__btn").forEach((b) => b.classList.remove("is-active"));
      btn.classList.add("is-active");
      renderLogTable();
    });
  });
  els.btnExportCsv.addEventListener("click", exportCsv);
  els.btnExportPdf.addEventListener("click", exportPdfReport);

  // الإعدادات: الأسعار
  els.btnSaveRates.addEventListener("click", saveRatesFromGrid);

  // المحفظة: جرد وتصحيح الصندوق + الرصيد الافتتاحي (نفس النافذة، غير إجبارية هنا)
  els.btnOpenInventoryAdjust.addEventListener("click", () => openCapitalModal(false));
  els.btnOpenInitialCapital.addEventListener("click", () => openCapitalModal(false));
  els.btnCloseCapitalModal.addEventListener("click", closeCapitalModal);
  els.capitalModal.addEventListener("click", (e) => {
    if (e.target === els.capitalModal && !els.btnCloseCapitalModal.hidden) closeCapitalModal();
  });
  els.btnSaveCapitalModal.addEventListener("click", saveCapitalModal);

  // الإعدادات: حجم ورق الطباعة
  els.printSizeToggle.querySelectorAll(".segmented__btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      state.printSize = btn.dataset.size;
      applyPrintSizeToggleUI();
      await dbSetSetting("printSize", state.printSize);
    });
  });

  // الإعدادات: تيليجرام
  els.btnSaveSettings.addEventListener("click", saveTelegramSettings);
  els.btnTestTelegram.addEventListener("click", testTelegramMessage);

  // الإعدادات: النسخ الاحتياطي
  els.btnExportBackup.addEventListener("click", exportBackup);
  els.fileImportBackup.addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (file) importBackupFile(file);
    e.target.value = "";
  });

  // الإعدادات: التقفيل اليومي
  els.btnDailyClosing.addEventListener("click", performDailyClosing);

  // حالة الاتصال
  window.addEventListener("online", () => {
    updateConnBadge();
    syncPendingOperations();
    showToast("عاد الاتصال بالإنترنت — جاري المزامنة");
  });
  window.addEventListener("offline", () => {
    updateConnBadge();
    showToast("انقطع الاتصال بالإنترنت — سيتم الحفظ محلياً", true);
  });
}

async function init() {
  cacheElements();
  attachEventListeners();
  setupInstallPrompt();
  registerServiceWorker();

  db = await openDatabase();

  const savedRates = await dbGetSetting("ratesMulti");
  if (savedRates) state.rates = { ...state.rates, ...savedRates };
  renderRatesGrid();

  const savedPositions = await dbGetAllPositions();
  savedPositions.forEach((p) => {
    state.positions[p.currency_code] = { balance: p.balance, avg_cost: p.avg_cost };
  });

  const savedTelegram = await dbGetSetting("telegram");
  if (savedTelegram) {
    state.telegram = savedTelegram;
    els.tgBotToken.value = state.telegram.botToken || "";
    els.tgChatId.value = state.telegram.chatId || "";
  }

  const savedPrintSize = await dbGetSetting("printSize");
  if (savedPrintSize) state.printSize = savedPrintSize;
  applyPrintSizeToggleUI();

  await updateLastClosingHint();
  await refreshOperationsFromDb();
  updateConnBadge();
  recalcFx();
  recalcSc();
  renderPortfolio();

  if (navigator.onLine) syncPendingOperations();
  startAutoSyncWatcher();

  // عند أول تشغيل على الإطلاق لهذا الجهاز (لا يوجد رصيد افتتاحي مُدخَل بعد)،
  // نفتح نافذة الرصيد الافتتاحي إجبارياً (بدون زر إغلاق) حتى تُحسب التكلفة صحيحة.
  const capitalSetupDone = await dbGetSetting("capitalSetupDone");
  if (!capitalSetupDone) openCapitalModal(true);

  const trial = await checkTrialLock();
  if (trial.locked) applyTrialLockScreen();
}

document.addEventListener("DOMContentLoaded", init);
