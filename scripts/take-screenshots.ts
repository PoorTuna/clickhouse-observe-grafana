/**
 * Retake the README screenshots against a live docker-compose stack.
 * Prereqs: npm run server (or docker compose up -d), a ClickHouse datasource
 * already added in Grafana, seed data loaded.
 *
 * Usage: GRAFANA_URL=http://localhost:3000 npx ts-node --transpile-only scripts/take-screenshots.ts
 */
import path from 'path';
import { chromium } from '@playwright/test';

const GRAFANA_URL = process.env.GRAFANA_URL ?? 'http://localhost:3000';
const PLUGIN_ID = 'poortuna-clickhouse-observe-app';
const REPO_ROOT = path.resolve(__dirname, '..');
const IMG_DIR = path.join(REPO_ROOT, 'src', 'img');

const beat = (ms = 500) => new Promise((r) => setTimeout(r, ms));

async function run() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  // ── Configuration page ──────────────────────────────────────────────────
  await page.goto(`${GRAFANA_URL}/plugins/${PLUGIN_ID}?page=configuration`, {
    waitUntil: 'networkidle',
    timeout: 25_000,
  });
  const alreadyConfigured = await page.getByText('Production OTel').count();
  if (!alreadyConfigured) {
    await page.getByRole('button', { name: 'Add view' }).click();
    await beat(300);

    await page.getByPlaceholder('My logs view').fill('Production OTel');
    await beat(200);

    // ClickHouse datasource select (react-select placeholder intercepts pointer events)
    await page.getByText('Select datasource…').click({ force: true });
    await beat(300);
    await page.locator('[role="option"]').first().click();
    await beat(300);

    await page.getByPlaceholder('default').fill('default');
    await page.getByPlaceholder('otel_logs').fill('otel_logs');
    await beat(200);

    await page.getByRole('button', { name: /Apply OTel preset/i }).click();
    await beat(500);

    await page.getByText('Shared Data Views').scrollIntoViewIfNeeded();
    await beat(300);
    await page.screenshot({ path: path.join(IMG_DIR, 'screenshot-config.png'), fullPage: false });

    await page.getByRole('button', { name: /Save configuration/i }).click();
    await page.waitForSelector('text=Configuration saved', { timeout: 8_000 }).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
    await beat(1_500);
  } else {
    await page.getByText('Production OTel').first().click();
    await beat(300);
    await page.getByText('Shared Data Views').scrollIntoViewIfNeeded();
    await beat(300);
    await page.screenshot({ path: path.join(IMG_DIR, 'screenshot-config.png'), fullPage: false });
  }

  // ── Logs Explorer ────────────────────────────────────────────────────────
  // A leftover saved-search default doesn't match our seeded OTel columns/time
  // window, so widen the time range and clear the KQL filter before shooting.
  await page.goto(`${GRAFANA_URL}/a/${PLUGIN_ID}/logs?from=now-6h&to=now`, {
    waitUntil: 'networkidle',
    timeout: 25_000,
  });
  try {
    const clearBtn = page.getByTitle('Clear search');
    if (await clearBtn.count()) {
      await clearBtn.click();
    }
    await page.waitForSelector('table tbody tr', { timeout: 20_000 });
    await page.waitForSelector('svg', { timeout: 10_000 });
    await beat(1_500);
    await page.screenshot({ path: path.join(IMG_DIR, 'screenshot-logs.png'), fullPage: false });
  } catch (e) {
    await page.screenshot({ path: path.join(IMG_DIR, 'DEBUG-logs.png'), fullPage: true });
    console.error('LOGS PAGE BODY TEXT:', (await page.textContent('body'))?.slice(0, 2000));
    throw e;
  }

  await browser.close();
  console.log('Screenshots saved to', IMG_DIR);
}

run().catch((err) => {
  console.error('Failed:', err);
  process.exit(1);
});
