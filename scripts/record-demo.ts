/**
 * Record a Logs Explorer demo video.
 *
 * Prerequisites:
 *   npm run server    — Grafana + ClickHouse running at http://localhost:3000
 *   npx playwright install chromium
 *
 * Usage:
 *   npm run demo
 *   GRAFANA_URL=http://localhost:3000 npm run demo
 *
 * Outputs (repo root):
 *   logs-explorer-demo.webm  (always — video saves even if a tour step fails)
 *   logs-explorer-demo.mp4   (if ffmpeg is on PATH)
 */

import path from 'path';
import os from 'os';
import fs from 'fs';
import { spawnSync } from 'child_process';
import { chromium, Page, Locator } from '@playwright/test';

// ── Config ────────────────────────────────────────────────────────────────────
const GRAFANA_URL = process.env.GRAFANA_URL ?? 'http://localhost:3000';
const PLUGIN_ID   = 'poortuna-clickhouse-observe-app';
const LOGS_URL    = `${GRAFANA_URL}/a/${PLUGIN_ID}/logs`;
const REPO_ROOT   = path.resolve(__dirname, '..');
const WEBM_OUT    = path.join(REPO_ROOT, 'logs-explorer-demo.webm');
const MP4_OUT     = path.join(REPO_ROOT, 'logs-explorer-demo.mp4');
const VIDEO_TMP   = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-demo-'));

// ── Helpers ───────────────────────────────────────────────────────────────────
const beat = (ms = 600): Promise<void> => new Promise((r) => setTimeout(r, ms));

function step(label: string) {
  process.stdout.write(`  ${label}\n`);
}

/** Hover then click — shows cursor travel on video. Only use on elements that
 *  don't have pointer-event interception (plain buttons, links, table rows). */
async function click(loc: Locator) {
  await loc.hover();
  await beat(200);
  await loc.click();
}

/** Click with force — bypasses pointer-interception checks.
 *  Use for react-select placeholder divs that intercept pointer events. */
async function forceClick(loc: Locator) {
  await loc.hover().catch(() => {}); // best-effort hover for cursor motion
  await loc.click({ force: true });
}

/** Type into whatever is currently focused, slowly enough to read on video. */
async function type(page: Page, text: string) {
  await page.keyboard.type(text, { delay: 95 });
}

/** Wait for the "Running query…" overlay to disappear (or timeout silently). */
async function queryDone(page: Page) {
  await page.waitForSelector('text=Running query…', { state: 'hidden', timeout: 12_000 })
    .catch(() => {});
  await beat(300);
}

/** Click the backdrop to close any open popover/portal. */
async function closePopover(page: Page) {
  await page.mouse.click(200, 200);
  await beat(300);
}

// ── Entry point ───────────────────────────────────────────────────────────────
async function run(): Promise<void> {
  console.log('\nLaunching browser…');
  const browser = await chromium.launch({ headless: false }).catch((err: Error) => {
    throw new Error(
      err.message.includes('Executable')
        ? 'Browser not found — run: npx playwright install chromium'
        : err.message
    );
  });

  const context = await browser.newContext({
    viewport:    { width: 1440, height: 900 },
    recordVideo: { dir: VIDEO_TMP, size: { width: 1440, height: 900 } },
  });
  const page  = await context.newPage();
  const video = page.video()!;

  try {
    await tour(page);
  } finally {
    await context.close();
    await video.saveAs(WEBM_OUT);
    await browser.close();
    console.log(`\n✓ webm: ${WEBM_OUT}`);
  }

  transcodeToMp4();
}

// ── Tour ──────────────────────────────────────────────────────────────────────
async function tour(page: Page): Promise<void> {

  // ── ① Land ──────────────────────────────────────────────────────────────
  step('① landing…');
  await page.goto(LOGS_URL, { waitUntil: 'networkidle', timeout: 25_000 });
  await page.waitForSelector('h2', { timeout: 15_000 });

  if (await page.getByText('No ClickHouse datasource configured').count()) {
    throw new Error(
      `Datasource not configured.\n` +
      `Open ${GRAFANA_URL}/plugins/${PLUGIN_ID} and set up ClickHouse.`
    );
  }

  await page.waitForSelector('svg',             { timeout: 15_000 }); // histogram
  await page.waitForSelector('table tbody tr',  { timeout: 15_000 }); // data rows
  await page.waitForSelector('.field-item-row', { timeout: 15_000 }); // sidebar fields
  await beat(1_500); // let viewer take in the full UI

  // ── ② KQL search bar + live autocomplete ────────────────────────────────
  // Type the full known-good query letter by letter — autocomplete suggestions
  // appear naturally during typing and the viewer can see them live.
  // Press Enter to commit (works regardless of dropdown state, no strict-mode
  // issues from multiple Search buttons).
  step('② KQL search…');
  try {
    const kqlInput = page.getByPlaceholder(/Filter logs with KQL/);
    await click(kqlInput);
    await beat(400);

    await type(page, 'SeverityText:ERROR');
    await beat(700); // pause so viewer sees the autocomplete dropdown
    await page.keyboard.press('Enter');
    await queryDone(page);
    await beat(1_000);

    await click(page.getByTitle('Clear search'));
    await queryDone(page);
    await beat(800);
  } catch (e) {
    console.warn('  ⚠ KQL step skipped:', (e as Error).message);
    await closePopover(page);
  }

  // ── ③ Structured Add-filter builder (new feature) ───────────────────────
  step('③ Add-filter popover…');
  try {
    await click(page.getByTitle('Add a structured filter'));
    await beat(700);

    // ── Field ──
    // react-select placeholder divs intercept pointer events — use force.
    await forceClick(page.getByText('Select field'));
    await beat(400);
    await type(page, 'Service');
    await beat(500);
    // Options appear in a Portal; pick ServiceName
    await page.locator('[role="option"]').filter({ hasText: /^ServiceName/ }).first().click();
    await beat(700);

    // ── Operator stays at default 'is' — viewer can see it pre-selected ──

    // ── Value ──
    // Placeholder changes to 'Select or type a value…' once a field is chosen.
    await forceClick(page.getByText('Select or type a value…'));
    await beat(300);
    await type(page, 'payment');
    await beat(1_100); // ClickHouse async value fetch

    const payOpt = page.locator('[role="option"]').filter({ hasText: /payment-gateway/i });
    if (await payOpt.first().isVisible()) {
      await payOpt.first().click();
    } else {
      await page.keyboard.press('Enter'); // accept custom value
    }
    await beat(600);

    // Submit — there are exactly 2 'Add filter' buttons in DOM order:
    //   [0] trigger (in main tree)   [1] submit (in Portal appended to body)
    await page.getByRole('button', { name: 'Add filter', exact: true }).last().click();
    await queryDone(page);
    await beat(1_200); // viewer sees the pill appear and table re-filter
  } catch (e) {
    console.warn('  ⚠ Add-filter step skipped:', (e as Error).message);
    await closePopover(page); // click backdrop to close portal
  }

  // ── ④ SQL Inspect — shows generated WHERE clause ─────────────────────────
  step('④ SQL inspect…');
  try {
    const inspectBtn = page.getByTitle('Inspect the SQL query that will be sent to ClickHouse');
    await click(inspectBtn);
    await page.waitForSelector('pre', { timeout: 5_000 });
    await beat(1_800); // viewer reads the SQL WITH the active filter's WHERE clause

    await click(page.getByRole('button', { name: 'Copy' }));
    await beat(900); // viewer sees 'Copied!' flash

    await click(inspectBtn); // toggle closed
    await beat(600);
  } catch (e) {
    console.warn('  ⚠ SQL inspect step skipped:', (e as Error).message);
  }

  // ── ⑤ Log row → detail drawer → include filter ───────────────────────────
  step('⑤ log detail drawer…');
  try {
    await click(page.locator('table tbody tr').first());
    await page.waitForSelector('text=Log Detail', { timeout: 8_000 });
    await beat(900);

    // attr-row buttons are opacity:0; Playwright hover triggers CSS :hover
    // which sets opacity:1 — then we click the now-visible button.
    const attrRow = page.locator('.attr-row').first();
    await attrRow.scrollIntoViewIfNeeded();
    await attrRow.hover();
    await beat(500);
    await attrRow.getByTitle('Include in filter').click();
    await beat(900); // drawer closes, pill appears
  } catch (e) {
    console.warn('  ⚠ Drawer step skipped:', (e as Error).message);
    await page.keyboard.press('Escape');
    await beat(400);
  }

  // ── ⑥ Field sidebar → top-values popover → filter for value ──────────────
  step('⑥ field sidebar top values…');
  try {
    await click(page.locator('.field-item-row').first());
    await page.waitForSelector('text=Top values', { timeout: 6_000 });

    const loading = page.locator('text=Loading…');
    if (await loading.isVisible()) {
      await loading.waitFor({ state: 'hidden', timeout: 8_000 });
    }
    await beat(800); // viewer reads top-values distribution

    // Filter buttons are opacity:0 until hover (CSS :hover on parent row)
    const filterBtn = page.getByTitle(/^Filter for /i).first();
    await filterBtn.hover();
    await beat(400);
    await filterBtn.click();
    await queryDone(page);
    await beat(1_000);
  } catch (e) {
    console.warn('  ⚠ Field sidebar step skipped:', (e as Error).message);
    await closePopover(page);
  }

  // ── ⑦ Clear all pills ────────────────────────────────────────────────────
  step('⑦ clear all…');
  try {
    const clearAll = page.getByText('Clear all');
    if (await clearAll.isVisible()) {
      await click(clearAll);
      await queryDone(page);
      await beat(800);
    }
  } catch (e) {
    console.warn('  ⚠ Clear-all step skipped:', (e as Error).message);
  }

  // ── ⑧ Histogram zoom ─────────────────────────────────────────────────────
  step('⑧ histogram zoom…');
  try {
    const bars = page.locator('svg rect');
    const n = await bars.count();
    if (n > 2) {
      const bar = bars.nth(Math.floor(n / 2));
      await bar.hover();
      await beat(500);
      await bar.click();
      await queryDone(page);
      await beat(900);
    }
  } catch (e) {
    console.warn('  ⚠ Histogram step skipped:', (e as Error).message);
  }

  await beat(800);
  step('Tour complete.');
}

// ── mp4 transcode ─────────────────────────────────────────────────────────────
function transcodeToMp4(): void {
  console.log('\nTranscoding to mp4…');
  const r = spawnSync(
    'ffmpeg',
    ['-y', '-i', WEBM_OUT,
     '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
     '-movflags', '+faststart', '-crf', '23', '-preset', 'veryfast',
     MP4_OUT],
    { stdio: 'inherit' }
  );
  if (r.status !== 0) {
    console.warn('⚠ ffmpeg failed — webm saved, mp4 not created.');
    console.warn(`  Manually: ffmpeg -y -i "${WEBM_OUT}" -c:v libx264 -pix_fmt yuv420p "${MP4_OUT}"`);
  } else {
    console.log(`✓ mp4:  ${MP4_OUT}`);
  }
}

// ── Run ───────────────────────────────────────────────────────────────────────
run().catch((err: unknown) => {
  console.error('\nFailed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
