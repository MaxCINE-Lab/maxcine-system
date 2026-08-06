import { chromium } from '@playwright/test';
import bwipjs from 'bwip-js';

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
  if (decoded !== expected) throw new Error(`Barcode decode mismatch: expected ${expected}, got ${decoded}`);
  console.log(`Barcode scanner decode test passed: ${decoded}`);
} finally {
  await browser.close();
}
