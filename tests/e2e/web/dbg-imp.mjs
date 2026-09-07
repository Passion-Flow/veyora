const webUrl = 'http://127.0.0.1:3311';
let chromium;
try { ({ chromium } = await import('playwright')); }
catch { ({ chromium } = await import('playwright-core')); }
const browser = await chromium.launch({ headless: true });
const page = await (await browser.newContext()).newPage();
page.on('console', m => { if (m.type() === 'error' && !m.text().includes('status of')) console.log('CONSOLE', m.text().slice(0, 200)); });
page.on('pageerror', e => console.log('PAGEERROR', e.message.slice(0, 200)));
await page.goto(webUrl + '?e2e=' + Date.now(), { waitUntil: 'load' });
await page.evaluate(() => localStorage.clear());
await page.reload({ waitUntil: 'load' });
await page.locator('#wf-create').click();
await page.locator('#new-pw').fill('import-probe-pw-1');
await page.locator('#new-pw2').fill('import-probe-pw-1');
await page.locator('#btn-create').click();
await page.locator('#btn-new').waitFor({ timeout: 15000 });
await page.locator('#tb-settings').click();
await page.locator('#drawer').waitFor();
const csv = 'name,username,password\nImp One,u1,secret-pass-111\nImp Two,u2,secret-pass-222\nImp Three,u3,secret-pass-333\n';
const chooser = page.waitForEvent('filechooser');
await page.locator('#set-import').click();
(await chooser).setFiles({ name: 'import.csv', mimeType: 'text/csv', buffer: Buffer.from(csv, 'utf8') });
await page.waitForTimeout(6000);
console.log('TOAST:', JSON.stringify(await page.locator('#toast').textContent().catch(() => '?')));
console.log('ROWS:', await page.locator('.trow').count());
await browser.close();
