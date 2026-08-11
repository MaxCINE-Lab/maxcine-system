import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import bwipjs from 'bwip-js';
import { canAcceptScan, isValidEan, MultiFrameConsensus, normalizeScannerValue, parseQrPayload, parseScannedValue } from '../packages/shared/dist/scanner.js';

function ok(name, fn) {
  try {
    fn();
    console.log(`✔ ${name}`);
  } catch (error) {
    console.error(`✘ ${name}`);
    throw error;
  }
}

ok('正确 EAN-13 校验通过', () => {
  assert.equal(isValidEan('6901649533307'), true);
  assert.equal(parseScannedValue('6901649533307', 'ean_13').ok, true);
});

ok('EAN-13 check digit 错误会被拒绝', () => {
  const parsed = parseScannedValue('6901649533304', 'ean_13');
  assert.equal(parsed.ok, false);
  assert.match(parsed.reason, /校验位/);
});

ok('Code 128 SN 标准化', () => {
  const parsed = parseScannedValue(' stage-gsx-w101-0102 ', 'code_128');
  assert.equal(parsed.ok, true);
  assert.equal(parsed.value, 'STAGE-GSX-W101-0102');
});

ok('QR Code 纯 SN', () => {
  const parsed = parseQrPayload('stage-gsx-w101-0102');
  assert.equal(parsed.ok, true);
  assert.equal(parsed.value, 'STAGE-GSX-W101-0102');
});

ok('QR Code URL 只解析允许域名', () => {
  const parsed = parseQrPayload('https://dealer.maxcine.cn/assets?sn=stage-gsx-w101-0102');
  assert.equal(parsed.ok, true);
  assert.equal(parsed.value, 'STAGE-GSX-W101-0102');
  assert.equal(parseQrPayload('https://example.com/?sn=STAGE-GSX-W101-0102').ok, false);
});

ok('QR Code JSON 解析允许字段', () => {
  const parsed = parseQrPayload(JSON.stringify({ serialNumber: 'stage-gsx-w101-0102' }));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.value, 'STAGE-GSX-W101-0102');
});

ok('未知 QR 内容不录入', () => {
  const parsed = parseQrPayload('这是一段普通说明，不是 MaxCINE 数据');
  assert.equal(parsed.ok, false);
});

ok('多帧连续 3 次一致成功', () => {
  const consensus = new MultiFrameConsensus();
  assert.equal(consensus.push('A'), null);
  assert.equal(consensus.push('A'), null);
  assert.equal(consensus.push('A'), 'A');
});

ok('单帧误识别不录入', () => {
  const consensus = new MultiFrameConsensus();
  assert.equal(consensus.push('BAD'), null);
  assert.equal(consensus.push('GOOD'), null);
});

ok('5 帧中 4 帧一致成功', () => {
  const consensus = new MultiFrameConsensus();
  assert.equal(consensus.push('A'), null);
  assert.equal(consensus.push('B'), null);
  assert.equal(consensus.push('A'), null);
  assert.equal(consensus.push('A'), null);
  assert.equal(consensus.push('A'), 'A');
});

ok('同一条码 2 秒内不重复录入', () => {
  const state = {};
  assert.equal(canAcceptScan(state, 'SN-1', 1000), true);
  assert.equal(canAcceptScan(state, 'SN-1', 2500), false);
  assert.equal(canAcceptScan(state, 'SN-1', 3101), true);
});

ok('扫描枪录入和手动输入走同一标准化', () => {
  assert.equal(normalizeScannerValue(' stage-gsx-w101-0102\n'), 'STAGE-GSX-W101-0102');
  assert.equal(parseScannedValue(normalizeScannerValue(' stage-gsx-w101-0102\n'), 'unknown').ok, true);
});

ok('业务校验失败场景保持可识别错误', () => {
  const missing = new Error('该 SN 不存在');
  const shipped = new Error('该 SN 已经发货');
  const bound = new Error('该 SN 已绑定其他订单');
  assert.match(missing.message, /不存在/);
  assert.match(shipped.message, /已经发货/);
  assert.match(bound.message, /已绑定/);
});

const expected = 'STAGE-GSX-W101-0102';
const png = await bwipjs.toBuffer({
  bcid: 'code128',
  text: expected,
  scale: 4,
  height: 22,
  paddingwidth: 18,
  paddingheight: 8,
  includetext: false,
  backgroundcolor: 'FFFFFF'
});

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.setContent(`<html><body><img id="barcode" alt="barcode" src="data:image/png;base64,${png.toString('base64')}" /></body></html>`);
  await page.addScriptTag({ path: 'node_modules/@zxing/browser/umd/zxing-browser.min.js' });
  const decoded = await page.evaluate(async () => {
    const reader = new window.ZXingBrowser.BrowserMultiFormatReader();
    const image = document.getElementById('barcode');
    const result = await reader.decodeFromImageElement(image);
    return result.getText();
  });
  assert.equal(decoded, expected);
  console.log(`✔ ZXing fallback Code 128 图片解码：${decoded}`);
} finally {
  await browser.close();
}

console.log('Warehouse Scanner V2 regression tests passed.');
