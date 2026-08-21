const API_BASE = (() => {
  if (window.MAXCINE_PUBLIC_API_BASE) return window.MAXCINE_PUBLIC_API_BASE;
  if (location.hostname.includes("localhost") || location.hostname.includes("127.0.0.1")) return "http://localhost:8787";
  if (location.hostname.includes("staging") || location.hostname.includes("pages.dev")) return "https://maxcine-api-staging.maxcine-lab.workers.dev";
  return "https://maxcine-api.maxcine-lab.workers.dev";
})();

let challengeId = "";
let sliderToken = "";
let challengeLoading = false;

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

async function api(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) }
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(data?.error?.message || "请稍后重试。");
  return data;
}

async function ensureChallenge() {
  if (challengeId || challengeLoading) return;
  challengeLoading = true;
  try {
    const data = await api("/public/warranty/challenges", { method: "POST", body: "{}" });
    challengeId = data.challengeId;
    setSliderStatus("请拖动滑块完成验证");
  } catch {
    setSliderStatus("验证初始化失败，请稍后重试");
  } finally {
    challengeLoading = false;
  }
}

async function completeSlider() {
  if (!challengeId) await ensureChallenge();
  if (!challengeId) return;
  try {
    const data = await api(`/public/warranty/challenges/${encodeURIComponent(challengeId)}/complete`, {
      method: "POST",
      body: JSON.stringify({ sliderValue: 100 })
    });
    sliderToken = data.token;
    setSliderStatus("验证已完成，可查询一次");
    setMessage("");
  } catch (error) {
    sliderToken = "";
    challengeId = "";
    setSliderStatus(error.message || "验证失败，请重试");
  }
}

function resetSlider() {
  const slider = byId("slider-input");
  if (slider) slider.value = "0";
  challengeId = "";
  sliderToken = "";
  setSliderStatus("未完成验证");
  void ensureChallenge();
}

function statusClass(value) {
  if (value === "保修中" || value === "待生效") return "status-ok";
  if (value === "已过保" || value === "无保修") return "status-bad";
  return "status-neutral";
}

function setResult(data) {
  const result = byId("main");
  if (result) result.style.display = "grid";
  const img = byId("img");
  if (img) {
    img.src = "/assets/logo2.png";
    img.style.display = "block";
  }
  byId("name").textContent = [data.productName, data.productVersion].filter(Boolean).join(" ") || "MaxCINE 产品";
  byId("sn").textContent = `序列号：${data.serialNumber}`;
  byId("date").textContent = data.publicNote || "";
  byId("start").textContent = data.warrantyStartDate || "暂无数据";
  byId("end").textContent = data.warrantyEndDate || "暂无数据";
  const status = byId("status");
  status.textContent = data.warrantyStatus || "待确认";
  status.className = statusClass(data.warrantyStatus || "");
  byId("repair").textContent = data.publicNote || "无公开售后记录";
}

async function query(sn) {
  const normalized = sn.replace(/[\r\n\t]/g, "").trim().toUpperCase();
  if (!normalized) {
    setMessage("请输入序列号", "error");
    return;
  }
  if (!challengeId || !sliderToken) {
    setMessage("请先将滑块拖到最右端完成验证。", "error");
    return;
  }

  const button = byId("sn-btn");
  button.classList.add("loading");
  setMessage("");
  byId("main").style.display = "none";

  try {
    const data = await api(
      `/public/warranty/${encodeURIComponent(normalized)}?challengeId=${encodeURIComponent(challengeId)}&token=${encodeURIComponent(sliderToken)}`
    );
    button.classList.remove("loading");
    button.classList.add("success");
    setTimeout(() => button.classList.remove("success"), 1200);
    setResult(data);
  } catch (error) {
    button.classList.remove("loading");
    setMessage(error.message || "请稍后重试。", "error");
  } finally {
    resetSlider();
  }
}

document.addEventListener("DOMContentLoaded", () => {
  const button = byId("sn-btn");
  const input = byId("sn-input");
  const slider = byId("slider-input");

  void ensureChallenge();

  slider.addEventListener("input", () => {
    if (Number(slider.value) >= 100) void completeSlider();
  });
  slider.addEventListener("change", () => {
    if (Number(slider.value) < 100) {
      sliderToken = "";
      setSliderStatus("请拖到最右端完成验证");
    }
  });

  button.addEventListener("click", () => query(input.value));
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") query(input.value);
  });
});
