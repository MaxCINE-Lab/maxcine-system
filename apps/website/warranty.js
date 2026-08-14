const API_BASE = (() => {
  if (window.MAXCINE_PUBLIC_API_BASE) return window.MAXCINE_PUBLIC_API_BASE;
  if (location.hostname.includes('localhost') || location.hostname.includes('127.0.0.1')) return 'http://localhost:8787';
  if (location.hostname.includes('staging') || location.hostname.includes('pages.dev')) return 'https://maxcine-api-staging.maxcine-lab.workers.dev';
  return 'https://maxcine-api.maxcine-lab.workers.dev';
})();

let challengeId = '';
let sliderToken = '';
let challengeLoading = false;

function setMessage(text) {
  const el = document.getElementById('message');
  if (el) el.innerText = text || '';
}

function setSliderStatus(text) {
  const el = document.getElementById('slider-status');
  if (el) el.innerText = text;
}

async function api(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(data?.error?.message || '请稍后重试。');
  return data;
}

async function ensureChallenge() {
  if (challengeId || challengeLoading) return;
  challengeLoading = true;
  try {
    const data = await api('/public/warranty/challenges', { method: 'POST', body: '{}' });
    challengeId = data.challengeId;
    setSliderStatus('请拖动滑块完成验证');
  } catch {
    setSliderStatus('验证初始化失败，请稍后重试');
  } finally {
    challengeLoading = false;
  }
}

async function completeSlider() {
  if (!challengeId) await ensureChallenge();
  if (!challengeId) return;
  try {
    const data = await api(`/public/warranty/challenges/${encodeURIComponent(challengeId)}/complete`, {
      method: 'POST',
      body: JSON.stringify({ sliderValue: 100 })
    });
    sliderToken = data.token;
    setSliderStatus('验证已完成，可查询一次');
  } catch (error) {
    sliderToken = '';
    challengeId = '';
    setSliderStatus(error.message || '验证失败，请重试');
  }
}

function resetSlider() {
  const slider = document.getElementById('slider-input');
  if (slider) slider.value = '0';
  challengeId = '';
  sliderToken = '';
  setSliderStatus('未完成验证');
  void ensureChallenge();
}

function statusClass(value) {
  return value === '保修中' || value === '待生效' ? 'ok' : value === '已过保' || value === '无保修' ? 'bad' : '';
}

async function query(sn) {
  const normalized = sn.replace(/[\r\n\t]/g, '').trim().toUpperCase();
  if (!normalized) {
    setMessage('请输入序列号');
    return;
  }
  if (!challengeId || !sliderToken) {
    setMessage('请先将滑块拖到最右端完成验证。');
    return;
  }

  const btn = document.getElementById('sn-btn');
  btn.classList.add('loading');
  setMessage('');
  document.getElementById('main').style.display = 'none';

  try {
    const data = await api(`/public/warranty/${encodeURIComponent(normalized)}?challengeId=${encodeURIComponent(challengeId)}&token=${encodeURIComponent(sliderToken)}`);
    btn.classList.remove('loading');
    btn.classList.add('success');
    setTimeout(() => btn.classList.remove('success'), 1200);
    document.getElementById('main').style.display = 'block';

    const img = document.getElementById('img');
    img.src = './assets/logo2.png';
    img.style.display = 'block';
    document.getElementById('name').innerText = [data.productName, data.productVersion].filter(Boolean).join(' ') || 'MaxCINE 产品';
    document.getElementById('sn').innerText = `序列号：${data.serialNumber}`;
    document.getElementById('date').innerText = data.publicNote || '';
    document.getElementById('start').innerText = data.warrantyStartDate || '暂无数据';
    document.getElementById('end').innerText = data.warrantyEndDate || '暂无数据';
    const statusEl = document.getElementById('status');
    statusEl.innerText = data.warrantyStatus || '待确认';
    statusEl.className = statusClass(data.warrantyStatus || '');
    document.getElementById('repair').innerText = data.publicNote || '无公开售后记录';
  } catch (error) {
    btn.classList.remove('loading');
    setMessage(error.message || '请稍后重试。');
  } finally {
    resetSlider();
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const btn = document.getElementById('sn-btn');
  const input = document.getElementById('sn-input');
  const slider = document.getElementById('slider-input');

  void ensureChallenge();

  slider.addEventListener('input', () => {
    if (Number(slider.value) >= 100) void completeSlider();
  });
  slider.addEventListener('change', () => {
    if (Number(slider.value) < 100) {
      sliderToken = '';
      setSliderStatus('请拖到最右端完成验证');
    }
  });

  btn.addEventListener('click', () => query(input.value));
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') query(input.value);
  });
});
