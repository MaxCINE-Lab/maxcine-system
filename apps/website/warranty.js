const API_BASE = (location.hostname === "maxcine-website-staging.pages.dev" || location.hostname.endsWith(".maxcine-website-staging.pages.dev"))
  ? "https://maxcine-api-staging.maxcine-lab.workers.dev"
  : "https://dealersystem.maxcine.cn/api";
const SERIAL_PATTERN = /^[A-Z0-9._\-/]{4,100}$/;
const NOT_FOUND_MESSAGE = "未查询到可公开的保修信息，请检查序列号后重试。";
const SLIDER_MESSAGE = "请先完成滑块验证。";
const REGION_MESSAGE = "您访问的页面不存在";
const RETRY_MESSAGE = "请稍后重试。";

let challengeId = "";
let sliderToken = "";
let challengeLoading = false;
let challengeCompleting = false;

function byId(id) {
  return document.getElementById(id);
}

function setMessage(text, tone = "") {
  const node = byId("message");
  if (!node) return;
  node.textContent = text || "";
  node.dataset.tone = tone;
}

function setSliderStatus(text) {
  const node = byId("slider-status");
  if (node) node.textContent = text;
}

function setQueryEnabled(enabled) {
  const button = byId("sn-btn");
  if (button) button.disabled = !enabled;
}

function setSliderProgress(value) {
  const slider = byId("slider-input");
  const progress = Math.min(100, Math.max(0, value));
  if (!slider) return;

  slider.style.setProperty("--slider-progress", `${progress}%`);
  const track = slider.closest(".mc-slider-track");
  if (!track) return;

  const handleOffset = Math.max(0, track.clientWidth - 48) * (progress / 100);
  track.style.setProperty("--slider-handle-offset", `${Math.round(handleOffset)}px`);
}

function createApiError(status, body) {
  const error = new Error("Public Warranty API request failed");
  error.status = status;
  error.body = body;
  return error;
}

async function api(path, options = {}) {
  let response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers: { "Content-Type": "application/json", ...(options.headers || {}) }
    });
  } catch {
    throw createApiError(0, "");
  }

  const body = await response.text();
  if (!response.ok) throw createApiError(response.status, body);
  if (!body) return null;

  try {
    return JSON.parse(body);
  } catch {
    throw createApiError(0, "");
  }
}

function isRegionalBlock(error) {
  return error.status === 403 && typeof error.body === "string" && error.body.includes(REGION_MESSAGE);
}

function friendlyMessage(error) {
  if (error?.status === 404) return NOT_FOUND_MESSAGE;
  if (isRegionalBlock(error)) return REGION_MESSAGE;
  if (error?.status === 403) return SLIDER_MESSAGE;
  return RETRY_MESSAGE;
}

function resetChallenge(status = "请拖动滑块完成验证") {
  const slider = byId("slider-input");
  if (slider) slider.value = "0";
  challengeId = "";
  sliderToken = "";
  challengeCompleting = false;
  byId("slider-box")?.classList.remove("is-verified");
  setQueryEnabled(false);
  setSliderProgress(0);
  setSliderStatus(status);
  void ensureChallenge();
}

async function ensureChallenge() {
  if (challengeId || challengeLoading) return;
  challengeLoading = true;
  try {
    const data = await api("/public/warranty/challenges", { method: "POST", body: "{}" });
    if (!data?.challengeId) throw createApiError(0, "");
    challengeId = data.challengeId;
    setSliderStatus("请拖动滑块完成验证");
  } catch (error) {
    setSliderStatus(friendlyMessage(error));
    if (isRegionalBlock(error)) setMessage(REGION_MESSAGE, "error");
  } finally {
    challengeLoading = false;
  }
}

async function completeSlider(sliderValue) {
  if (sliderValue < 98 || challengeCompleting) return;
  if (!challengeId) await ensureChallenge();
  if (!challengeId) return;

  challengeCompleting = true;
  try {
    const data = await api(`/public/warranty/challenges/${encodeURIComponent(challengeId)}/complete`, {
      method: "POST",
      body: JSON.stringify({ sliderValue })
    });
    if (!data?.token) throw createApiError(0, "");
    sliderToken = data.token;
    byId("slider-box")?.classList.add("is-verified");
    setSliderProgress(100);
    setSliderStatus("验证完成");
    setQueryEnabled(true);
    setMessage("");
  } catch (error) {
    setMessage(friendlyMessage(error), "error");
    resetChallenge(friendlyMessage(error));
  } finally {
    challengeCompleting = false;
  }
}

function statusClass(value) {
  if (value === "保修中" || value === "待生效" || value === "有效") return "status-ok";
  if (value === "已过保" || value === "无保修" || value === "已到期") return "status-bad";
  return "status-neutral";
}

function setHidden(id, hidden) {
  const node = byId(id);
  if (node) node.hidden = hidden;
}

function setResult(response) {
  const publicWarranty = {
    serialNumber: response.serialNumber,
    productName: response.productName,
    productVersion: response.productVersion,
    warrantyStatus: response.warrantyStatus,
    warrantyStartDate: response.warrantyStartDate,
    warrantyEndDate: response.warrantyEndDate,
    purchaseDate: response.purchaseDate,
    publicNote: response.publicNote,
    publicEntitlements: Array.isArray(response.publicEntitlements) ? response.publicEntitlements : []
  };
  const result = byId("main");
  if (result) result.hidden = false;

  byId("name").textContent = publicWarranty.productName || "MaxCINE 产品";
  byId("sn").textContent = `序列号：${publicWarranty.serialNumber || "暂无数据"}`;
  const purchaseDate = byId("date");
  if (purchaseDate) {
    purchaseDate.hidden = !publicWarranty.purchaseDate;
    purchaseDate.textContent = publicWarranty.purchaseDate ? `购买日期：${publicWarranty.purchaseDate}` : "";
  }
  byId("start").textContent = publicWarranty.warrantyStartDate || "暂无数据";
  byId("end").textContent = publicWarranty.warrantyEndDate || "暂无数据";
  const status = byId("status");
  status.textContent = publicWarranty.warrantyStatus || "暂无数据";
  status.className = statusClass(publicWarranty.warrantyStatus || "");
  const entitlements = byId("entitlements");
  if (entitlements) {
    entitlements.textContent = "";
    for (const entitlement of publicWarranty.publicEntitlements) {
      const item = document.createElement("div");
      const details = document.createElement("div");
      const name = document.createElement("strong");
      const period = document.createElement("span");
      const entitlementStatus = document.createElement("span");
      name.textContent = entitlement.name || "额外权益";
      period.textContent = entitlement.endDate
        ? `有效期：${entitlement.startDate || "—"} ～ ${entitlement.endDate}`
        : "有效期：待确认";
      entitlementStatus.textContent = entitlement.status || "待确认";
      entitlementStatus.className = `entitlement-status ${statusClass(entitlement.status || "")}`;
      details.append(name, period);
      item.append(details, entitlementStatus);
      entitlements.append(item);
    }
  }
  setHidden("entitlements-card", publicWarranty.publicEntitlements.length === 0);
  setHidden("service-card", true);
  const note = publicWarranty.publicNote ? publicWarranty.publicNote.trim() : "";
  byId("repair").textContent = note;
  setHidden("note-card", !note);
}

function normalizeSerialNumber(value) {
  return value.trim().toUpperCase();
}

async function query(serialNumber) {
  const normalized = normalizeSerialNumber(serialNumber);
  if (!SERIAL_PATTERN.test(normalized)) {
    setMessage(NOT_FOUND_MESSAGE, "error");
    return;
  }
  if (!challengeId || !sliderToken) {
    setMessage(SLIDER_MESSAGE, "error");
    return;
  }

  const button = byId("sn-btn");
  button.classList.add("loading");
  setMessage("");
  byId("main").hidden = true;

  try {
    const data = await api(
      `/public/warranty/${encodeURIComponent(normalized)}?challengeId=${encodeURIComponent(challengeId)}&token=${encodeURIComponent(sliderToken)}`
    );
    button.classList.add("success");
    setTimeout(() => button.classList.remove("success"), 1200);
    setResult(data);
  } catch (error) {
    setMessage(friendlyMessage(error), "error");
  } finally {
    button.classList.remove("loading");
    resetChallenge();
  }
}

document.addEventListener("DOMContentLoaded", () => {
  const button = byId("sn-btn");
  const input = byId("sn-input");
  const slider = byId("slider-input");

  void ensureChallenge();
  setQueryEnabled(false);
  setSliderProgress(0);

  slider.addEventListener("input", () => {
    const sliderValue = Number(slider.value);
    byId("slider-box")?.classList.remove("is-verified");
    setSliderProgress(sliderValue);
    if (sliderValue >= 98) void completeSlider(sliderValue);
  });
  slider.addEventListener("change", () => {
    if (Number(slider.value) < 98 && !sliderToken) setSliderStatus("请拖到最右端完成验证");
  });
  window.addEventListener("resize", () => setSliderProgress(Number(slider.value)), { passive: true });

  button.addEventListener("click", () => query(input.value));
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") query(input.value);
  });
});
