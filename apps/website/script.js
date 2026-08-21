import { mavic4ProWideAngle, siteContent } from "/content/site.js";

const page = document.body.dataset.page || "home";
let lastFocusedElement = null;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function qs(selector, root = document) {
  return root.querySelector(selector);
}

function qsa(selector, root = document) {
  return [...root.querySelectorAll(selector)];
}

function clear(node) {
  if (node) node.replaceChildren();
}

function optimizedImageVariant(src, extension) {
  return src.replace(/\.(jpe?g|png)$/i, `.${extension}`);
}

function createImage(src, alt) {
  const picture = document.createElement("picture");
  if (/^\/assets\/optimized\/.+\.(jpe?g|png)$/i.test(src)) {
    const avif = document.createElement("source");
    avif.type = "image/avif";
    avif.srcset = optimizedImageVariant(src, "avif");
    const webp = document.createElement("source");
    webp.type = "image/webp";
    webp.srcset = optimizedImageVariant(src, "webp");
    picture.append(avif, webp);
  }
  const image = document.createElement("img");
  image.src = src;
  image.alt = alt;
  picture.append(image);
  return picture;
}

function setText(selector, text) {
  const node = qs(selector);
  if (node) node.textContent = text;
}

function buttonLikeLink(item) {
  const anchor = el("a", "text-link", item.label);
  anchor.href = item.href;
  return anchor;
}

function initChrome() {
  const header = qs("[data-site-header]");
  if (header) {
    const brand = el("a", "site-brand");
    brand.href = "/";
    brand.setAttribute("aria-label", "MaxCINE 首页");
    const logo = document.createElement("img");
    logo.src = "/assets/logo.png";
    logo.alt = "MaxCINE";
    brand.append(logo);

    const toggle = el("button", "nav-toggle");
    toggle.type = "button";
    toggle.setAttribute("aria-label", "打开导航菜单");
    toggle.setAttribute("aria-expanded", "false");
    toggle.setAttribute("aria-controls", "site-nav");
    toggle.append(el("span", "", ""));

    const nav = el("nav", "site-nav");
    nav.id = "site-nav";
    nav.setAttribute("aria-label", "主导航");
    const pathname = location.pathname.endsWith("/")
      ? location.pathname
      : `${location.pathname}`;
    siteContent.navigation.forEach((item) => {
      const link = el("a", "", item.label);
      link.href = item.href;
      if (pathname === item.href || (item.href !== "/" && pathname.startsWith(item.href))) {
        link.setAttribute("aria-current", "page");
      }
      nav.append(link);
    });

    toggle.addEventListener("click", () => {
      const open = document.body.classList.toggle("nav-open");
      toggle.setAttribute("aria-expanded", String(open));
      toggle.setAttribute("aria-label", open ? "关闭导航菜单" : "打开导航菜单");
    });

    nav.addEventListener("click", () => {
      document.body.classList.remove("nav-open");
      toggle.setAttribute("aria-expanded", "false");
      toggle.setAttribute("aria-label", "打开导航菜单");
    });

    header.replaceChildren(brand, toggle, nav);
  }

  const footer = qs("[data-site-footer]");
  if (footer) {
    const left = el("div", "footer-brand");
    const mark = el("strong", "", "MaxCINE");
    const copy = el(
      "span",
      "",
      `© ${new Date().getFullYear()} MaxCINE Imaging Systems. All rights reserved.`
    );
    left.append(mark, copy);

    const links = el("div", "footer-links");
    [
      { label: "产品详情", href: mavic4ProWideAngle.url },
      { label: "保修查询", href: "/warranty.html" },
      { label: "售后政策", href: "/support/policy.html" },
      { label: "维修价格", href: "/repair-pricing/" }
    ].forEach((item) => links.append(buttonLikeLink(item)));
    footer.replaceChildren(left, links);
  }
}

function setupHero() {
  const hero = siteContent.hero;
  setText("[data-hero-eyebrow]", hero.eyebrow);
  setText("[data-hero-title]", hero.title);
  setText("[data-hero-tagline]", hero.tagline);
  setText("[data-hero-body]", hero.body);
  const primary = qs("[data-hero-primary]");
  if (primary) {
    primary.textContent = hero.primaryAction.label;
    primary.href = hero.primaryAction.href;
  }

  const video = qs("[data-hero-video]");
  if (!video) return;
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!hero.video.enabled || reducedMotion) {
    video.hidden = true;
    return;
  }

  const source = document.createElement("source");
  source.src = window.matchMedia("(max-width: 760px)").matches
    ? hero.video.mobileSrc
    : hero.video.desktopSrc;
  source.type = "video/mp4";
  video.append(source);
  video.addEventListener("error", () => {
    video.hidden = true;
  });
  video.addEventListener("stalled", () => {
    video.hidden = true;
  });
  video.play().catch(() => {
    video.hidden = true;
  });
}

function renderStatement(target, section) {
  if (!target || !section) return;
  clear(target);
  const copy = el("div", "statement-copy");
  copy.append(el("p", "eyebrow", section.eyebrow), el("h2", "", section.title), el("p", "", section.body));
  target.append(copy);
}

function renderPerformance() {
  const target = qs("[data-home-performance]");
  const section = mavic4ProWideAngle.homeSections.find((item) => item.id === "image-performance");
  if (!target || !section) return;
  clear(target);
  const media = el("figure", "wide-media");
  media.append(createImage(section.media, "MaxCINE Mavic 4 Pro 增广镜实际影像表现占位图"));
  const copy = el("div", "section-copy");
  copy.append(el("p", "eyebrow", section.eyebrow), el("h2", "", section.title), el("p", "", section.body));
  const metrics = el("div", "metric-row");
  section.metrics.forEach((metric) => metrics.append(el("span", "", metric)));
  copy.append(metrics);
  target.append(media, copy);
}

function renderFeatureBand(target, section) {
  if (!target || !section) return;
  clear(target);
  const copy = el("div", "section-copy");
  copy.append(el("p", "eyebrow", section.eyebrow), el("h2", "", section.title), el("p", "", section.body));
  if (section.media) {
    const media = el("figure", "side-media");
    media.append(createImage(section.media, section.title));
    target.append(copy, media);
  } else {
    target.append(copy);
  }
}

function renderVersions(root = document) {
  const grid = qs("[data-version-grid]", root);
  if (!grid) return;
  clear(grid);
  mavic4ProWideAngle.versions.forEach((version) => {
    const card = el("article", "version-card");
    card.append(el("p", "sku", version.sku), el("h3", "", version.name), el("p", "", version.role));
    const list = el("ul", "");
    version.items.forEach((item) => list.append(el("li", "", item)));
    card.append(list, el("small", "", version.note));
    grid.append(card);
  });
}

function renderSupportLinks(root = document) {
  const grid = qs("[data-support-links]", root);
  if (!grid) return;
  clear(grid);
  siteContent.supportLinks.forEach((item) => {
    const card = el("a", "support-card");
    card.href = item.href;
    card.append(el("h3", "", item.title), el("p", "", item.body), el("span", "", "进入"));
    grid.append(card);
  });
}

function renderChannels(root = document) {
  const grid = qs("[data-channel-groups]", root);
  if (!grid) return;
  clear(grid);
  siteContent.channels.forEach((group) => {
    const column = el("article", "channel-group");
    column.append(el("h3", "", group.title));
    const list = el("ul", "");
    group.items.forEach((item) => list.append(el("li", "", item)));
    column.append(list);
    grid.append(column);
  });
}

function renderBrandStatement() {
  const target = qs("[data-brand-statement]");
  if (!target) return;
  clear(target);
  const statement = siteContent.brandStatement;
  target.append(el("p", "eyebrow", statement.eyebrow), el("h2", "", statement.title), el("p", "", statement.body));
}

function renderHome() {
  setupHero();
  renderStatement(
    qs("[data-home-positioning]"),
    mavic4ProWideAngle.homeSections.find((item) => item.id === "positioning")
  );
  renderPerformance();
  renderFeatureBand(
    qs("[data-home-optics]"),
    mavic4ProWideAngle.homeSections.find((item) => item.id === "optics")
  );
  renderFeatureBand(
    qs("[data-home-engineering]"),
    mavic4ProWideAngle.homeSections.find((item) => item.id === "engineering")
  );
  renderVersions();
  renderSupportLinks();
  renderChannels();
  renderBrandStatement();
}

function renderProduct() {
  setText("[data-product-title]", mavic4ProWideAngle.name);
  setText("[data-product-tagline]", mavic4ProWideAngle.tagline);
  setText("[data-product-summary]", mavic4ProWideAngle.summary);
  renderStatement(qs("[data-product-positioning]"), {
    eyebrow: "POSITIONING",
    title: "不是夸张变形，而是更完整的空间叙事。",
    body: mavic4ProWideAngle.summary
  });

  const list = qs("[data-detail-sections]");
  if (list) {
    clear(list);
    mavic4ProWideAngle.detailSections.forEach((section, index) => {
      const row = el("article", `detail-row ${index % 2 ? "detail-row-reverse" : ""}`);
      const copy = el("div", "section-copy");
      copy.append(el("p", "eyebrow", section.eyebrow), el("h2", "", section.title), el("p", "", section.body));
      const media = el("figure", "side-media");
      media.append(createImage(index % 2 ? mavic4ProWideAngle.media.engineeringImage : mavic4ProWideAngle.media.opticsImage, section.title));
      row.append(copy, media);
      list.append(row);
    });
  }

  const todos = qs("[data-package-todos]");
  if (todos) {
    clear(todos);
    mavic4ProWideAngle.packageContentTodos.forEach((item) => todos.append(el("li", "", item)));
  }

  const faq = qs("[data-faq-list]");
  if (faq) {
    clear(faq);
    mavic4ProWideAngle.faq.forEach((item) => {
      const details = el("details", "faq-item");
      const summary = el("summary", "", item.question);
      const answer = el("p", "", item.answer);
      details.append(summary, answer);
      faq.append(details);
    });
  }

  renderVersions();
  renderChannels();
}

function renderPolicy() {
  const root = qs("[data-policy-content]");
  if (!root) return;
  clear(root);
  root.append(el("p", "eyebrow", "POLICY"), el("h2", "", siteContent.policy.title), el("p", "", siteContent.policy.description));
  siteContent.policy.sections.forEach((section) => {
    const block = el("section", "legal-section");
    block.append(el("h3", "", section.title));
    const list = el("ul", "");
    section.body.forEach((item) => list.append(el("li", "", item)));
    block.append(list);
    root.append(block);
  });
}

function renderRepair() {
  const root = qs("[data-repair-content]");
  if (!root) return;
  clear(root);
  root.append(el("p", "section-intro", siteContent.repairPricing.description));
  const grid = el("div", "pricing-grid");
  siteContent.repairPricing.groups.forEach((group) => {
    const block = el("article", "pricing-group");
    block.append(el("h2", "", group.title));
    const table = el("div", "pricing-table");
    group.items.forEach(([name, price]) => {
      const row = el("div", "price-row");
      row.append(el("span", "", name), el("strong", "", price));
      table.append(row);
    });
    block.append(table);
    grid.append(block);
  });
  root.append(grid, el("p", "note", siteContent.repairPricing.note));
}

function renderDownloads() {
  const root = qs("[data-downloads-content]");
  if (!root) return;
  clear(root);
  root.append(el("p", "section-intro", siteContent.downloads.description));
  const grid = el("div", "download-grid");
  siteContent.downloads.resources.forEach((item) => {
    const card = el("article", "download-card");
    card.append(el("h2", "", item.title), el("p", "", "旧资源入口保留，正式权限策略待确认。"));
    const link = el("a", "button button-ghost", "下载");
    link.href = item.file;
    link.setAttribute("download", "");
    card.append(link);
    grid.append(card);
  });
  root.append(grid);
}

function renderLegacy() {
  const target = qs("[data-legacy-content]");
  if (!target) return;
  const data = page === "legacy-activate" ? siteContent.legacyPages.activate : siteContent.legacyPages.booking;
  clear(target);
  target.append(el("p", "eyebrow", "LEGACY"), el("h1", "", data.title), el("p", "", data.body));
  const link = el("a", "button button-primary", "返回首页");
  link.href = "/";
  target.append(link);
}

function buildSampleModal() {
  const sample = mavic4ProWideAngle.sampleFilm;
  const overlay = el("div", "sample-modal");
  overlay.hidden = true;
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-labelledby", "sample-modal-title");
  overlay.dataset.sampleModal = "";

  const dialog = el("div", "sample-dialog");
  const close = el("button", "modal-close", "×");
  close.type = "button";
  close.setAttribute("aria-label", "关闭样片");
  close.dataset.sampleClose = "";

  const media = el("div", "sample-media");
  media.append(createImage(sample.poster, ""));
  const badge = el("span", "sample-badge", sample.note);
  media.append(badge);

  const copy = el("div", "sample-copy");
  copy.append(
    el("p", "eyebrow", "SAMPLE FILM"),
    el("h2", "", sample.title),
    el("p", "", `${sample.duration}。正式视频素材待替换，当前只展示 poster 与交互结构。`)
  );

  dialog.append(close, media, copy);
  overlay.append(dialog);
  document.body.append(overlay);

  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) closeSampleModal();
  });
  close.addEventListener("click", closeSampleModal);
}

function openSampleModal() {
  const modal = qs("[data-sample-modal]");
  if (!modal) return;
  lastFocusedElement = document.activeElement;
  modal.hidden = false;
  document.body.classList.add("modal-open");
  qs("[data-sample-close]", modal)?.focus();
}

function closeSampleModal() {
  const modal = qs("[data-sample-modal]");
  if (!modal || modal.hidden) return;
  modal.hidden = true;
  document.body.classList.remove("modal-open");
  if (lastFocusedElement && typeof lastFocusedElement.focus === "function") {
    lastFocusedElement.focus();
  }
}

function initSampleModal() {
  buildSampleModal();
  qsa("[data-sample-open]").forEach((button) => button.addEventListener("click", openSampleModal));
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeSampleModal();
  });
}

function initPage() {
  initChrome();
  initSampleModal();
  if (page === "home") renderHome();
  if (page === "product") renderProduct();
  if (page === "support") renderSupportLinks();
  if (page === "policy") renderPolicy();
  if (page === "repair") renderRepair();
  if (page === "downloads") renderDownloads();
  if (page.startsWith("legacy")) renderLegacy();
  if (page === "warranty") renderSupportLinks();
}

document.addEventListener("DOMContentLoaded", initPage);
