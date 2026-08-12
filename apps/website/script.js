// MaxCINE language toggle and utilities

const translations = { /* 保持你原来的，不动 */ };

// ===== 语言系统 =====
function setLanguage(lang) {
  const dict = translations[lang];
  if (!dict) return;

  document.documentElement.lang = lang === "cn" ? "zh-CN" : "en";

  document.querySelectorAll("[data-i18n]").forEach((el) => {
    const key = el.getAttribute("data-i18n");
    if (dict[key]) el.textContent = dict[key];
  });

  const toggle = document.querySelector(".mc-lang-toggle");
  if (toggle) {
    toggle.dataset.lang = lang;
    const options = toggle.querySelectorAll(".mc-lang-option");
    options.forEach((opt, index) => {
      opt.classList.toggle(
        "mc-lang-option--active",
        (lang === "cn" && index === 0) || (lang === "en" && index === 1)
      );
    });
  }
}

function initLanguage() {
  const toggle = document.querySelector(".mc-lang-toggle");
  if (!toggle) return;

  toggle.addEventListener("click", () => {
    const current = toggle.dataset.lang === "en" ? "en" : "cn";
    const next = current === "cn" ? "en" : "cn";
    setLanguage(next);
  });

  setLanguage("cn");
}

// ===== 年份 =====
function initYear() {
  const yearEl = document.getElementById("mc-year");
  if (yearEl) yearEl.textContent = new Date().getFullYear();
}

// ===== Header 动态 =====
function initHeaderVisibility() {
  const header = document.querySelector(".mc-header");
  const hero = document.querySelector(".mc-hero");
  if (!header || !hero) return;

  if ("IntersectionObserver" in window) {
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          header.classList.toggle("mc-header--hidden", !entry.isIntersecting);
        });
      },
      { threshold: 0.15 }
    );
    observer.observe(hero);
  }
}

// ===== SN 查询入口（已升级）=====
function initSupportActions() {
  const warrantyCard = document.querySelector('[data-support="warranty"]');
  if (!warrantyCard) return;

  const handler = () => {
    // ✅ 直接跳转，不再弹窗
    window.location.href = "./warranty.html";
  };

  warrantyCard.addEventListener("click", handler);
  warrantyCard.addEventListener("keydown", (e) => {
    if (["Enter", " "].includes(e.key)) {
      e.preventDefault();
      handler();
    }
  });

  warrantyCard.tabIndex = 0;
  warrantyCard.role = "button";
}

// ===== 平滑滚动 =====
function initSmoothScroll() {
  document.querySelectorAll('a.mc-nav-link[href^="#"], a.mc-btn[href^="#"]').forEach((link) => {
    link.addEventListener("click", (event) => {
      const target = document.querySelector(link.getAttribute("href"));
      if (!target) return;
      event.preventDefault();
      target.scrollIntoView({ behavior: "smooth" });
    });
  });
}

// ===== 初始化 =====
window.addEventListener("DOMContentLoaded", () => {
  initLanguage();
  initYear();
  initHeaderVisibility();
  initSupportActions();
  initSmoothScroll();
})
function checkStatus(){

  const sn = document.getElementById("sn").value.trim();
  const result = document.getElementById("result");

  if(!sn){
    alert("请输入序列号");
    return;
  }

  result.innerHTML = "正在查询...";

  fetch("../data/activate/" + sn + ".json?t=" + Date.now())
    .then(res => {

      if(res.ok){
        return res.json().then(data => {

          // ⭐ 直接显示已激活卡片
          showCard(data, true);
        });
      }

      throw new Error();
    })
    .catch(()=>{
      result.innerHTML = "❌ 未查询到激活记录";
    });
}