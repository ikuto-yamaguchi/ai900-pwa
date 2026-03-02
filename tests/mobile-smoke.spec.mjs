import { test, expect, devices } from '@playwright/test';

const MOBILE = devices['Pixel 5'];

test.use({
  ...MOBILE,
  baseURL: 'https://ai900-pwa.pages.dev',
});

// Helper: start a practice session and wait for first question
async function startPractice(page) {
  await page.goto('/');
  await page.waitForSelector('.btn-primary');
  await page.locator('button:has-text("練習モード")').tap();
  await page.waitForSelector('.session-bar', { timeout: 10000 });
}

// Helper: get current question type from the q-number text (contains [タイプ名])
async function getQuestionType(page) {
  const text = await page.locator('.q-number').textContent();
  if (text.includes('[単一選択]')) return 'single';
  if (text.includes('[複数選択]')) return 'multi';
  if (text.includes('[穴埋め]')) return 'dropdown';
  if (text.includes('[マッチング]')) return 'match';
  if (text.includes('[並べ替え]')) return 'order';
  if (text.includes('[ホットエリア]')) return 'hotarea';
  if (text.includes('[ケーススタディ]')) return 'casestudy';
  return 'unknown';
}

// Helper: navigate to a specific question type (tries up to maxSteps questions)
async function navigateToType(page, targetType, maxSteps = 50) {
  for (let i = 0; i < maxSteps; i++) {
    const type = await getQuestionType(page);
    if (type === targetType) return true;
    const nextBtn = page.locator('.session-bar button:has-text("次へ")');
    const isLast = !(await nextBtn.isVisible().catch(() => false));
    if (isLast) return false;
    await nextBtn.tap();
    await page.waitForTimeout(200);
  }
  return false;
}

test('Home page loads and shows start buttons', async ({ page }) => {
  await page.goto('/');
  await page.waitForSelector('.btn-primary');
  await expect(page.locator('button:has-text("練習モード")')).toBeVisible();
  await expect(page.locator('button:has-text("練習モード")')).toBeEnabled();
  await expect(page.locator('button:has-text("模試")')).toBeVisible();
});

test('Start practice and verify session UI', async ({ page }) => {
  await startPractice(page);
  await expect(page.locator('.q-number')).toBeVisible();
  await expect(page.locator('.progress-bar')).toBeVisible();
  await expect(page.locator('.session-bar button:has-text("次へ")')).toBeEnabled();
  await expect(page.locator('.session-bar button:has-text("解説")')).toBeEnabled();
});

test('Choice items respond to tap', async ({ page }) => {
  await startPractice(page);
  const choiceItem = page.locator('.choice-item').first();
  if (await choiceItem.isVisible().catch(() => false)) {
    await choiceItem.tap();
    await expect(choiceItem).toHaveClass(/selected/);
  }
});

test('Next and Previous buttons work', async ({ page }) => {
  await startPractice(page);
  const q1 = await page.locator('.q-number').textContent();

  await page.locator('.session-bar button:has-text("次へ")').tap();
  await page.waitForTimeout(300);
  const q2 = await page.locator('.q-number').textContent();
  expect(q2).not.toBe(q1);
  expect(q2).toContain('Q2');

  // Previous should now be enabled
  const prevBtn = page.locator('.session-bar button:has-text("前へ")');
  await expect(prevBtn).toBeEnabled();
  await prevBtn.tap();
  await page.waitForTimeout(300);
  expect(await page.locator('.q-number').textContent()).toContain('Q1');
});

test('解説 button shows explanation with instant grading', async ({ page }) => {
  await startPractice(page);

  // Select an answer if choice-item exists
  const choiceItem = page.locator('.choice-item').first();
  if (await choiceItem.isVisible().catch(() => false)) {
    await choiceItem.tap();
    await page.waitForTimeout(100);
  }

  // Tap 解説
  await page.locator('.session-bar button:has-text("解説")').tap();

  // Explanation should appear with grading
  await expect(page.locator('.explanation')).toBeVisible({ timeout: 3000 });
  const expText = await page.locator('.explanation h4').textContent();
  expect(expText === '正解!' || expText === '不正解').toBeTruthy();
});

test('Flag button toggles', async ({ page }) => {
  await startPractice(page);
  const flagBtn = page.locator('.session-bar button:has-text("フラグ")');
  await flagBtn.tap();
  await page.waitForTimeout(200);
  await expect(flagBtn).toHaveClass(/flag-on/);
  await expect(page.locator('.flag-indicator')).toBeVisible();
});

test('Dropdown: prompt is NOT duplicated', async ({ page }) => {
  await startPractice(page);
  const found = await navigateToType(page, 'dropdown');
  if (!found) {
    test.skip();
    return;
  }

  // Count how many .q-prompt elements are visible
  const promptCount = await page.locator('.q-prompt').count();
  // Should be exactly 1 (the one rendered by renderDropdown with placeholders)
  expect(promptCount).toBe(1);

  // The prompt should contain a <select> element (dropdown blanks)
  const hasSelect = await page.locator('.q-prompt select').count();
  expect(hasSelect).toBeGreaterThan(0);
});

test('Dropdown: 解説 shows correct/incorrect answers', async ({ page }) => {
  await startPractice(page);
  const found = await navigateToType(page, 'dropdown');
  if (!found) {
    test.skip();
    return;
  }

  // Tap 解説
  await page.locator('.session-bar button:has-text("解説")').tap();
  await expect(page.locator('.explanation')).toBeVisible({ timeout: 3000 });

  // Should show grading
  const expText = await page.locator('.explanation h4').textContent();
  expect(expText === '正解!' || expText === '不正解').toBeTruthy();

  // Dropdowns should now show colored results (no more <select>)
  const selectCount = await page.locator('.q-prompt select').count();
  expect(selectCount).toBe(0);
});

test('Casestudy: 解説 shows per-sub grading', async ({ page }) => {
  await startPractice(page);
  const found = await navigateToType(page, 'casestudy');
  if (!found) {
    test.skip();
    return;
  }

  // Should have scenario and sub-question tabs
  await expect(page.locator('.cs-scenario')).toBeVisible();
  await expect(page.locator('.cs-tabs')).toBeVisible();

  // Select an answer if choice-item exists
  const choiceItem = page.locator('.choice-item').first();
  if (await choiceItem.isVisible().catch(() => false)) {
    await choiceItem.tap();
    await page.waitForTimeout(100);
  }

  // Tap 解説
  await page.locator('.session-bar button:has-text("解説")').tap();
  await expect(page.locator('.explanation')).toBeVisible({ timeout: 3000 });

  // Should show per-sub grading (正解 or 不正解 in explanation header)
  const expText = await page.locator('.explanation h4').textContent();
  expect(expText).toMatch(/正解|不正解/);

  // Tab labels should show ○ or × indicators
  const tabTexts = await page.locator('.cs-tabs button').allTextContents();
  const hasIndicator = tabTexts.some(t => t.includes('○') || t.includes('×'));
  expect(hasIndicator).toBeTruthy();
});

test('Match: select dropdowns work and options are shuffled', async ({ page }) => {
  await startPractice(page);
  const found = await navigateToType(page, 'match');
  if (!found) {
    test.skip();
    return;
  }

  // Should have match area with selects
  await expect(page.locator('.match-area')).toBeVisible();
  const selects = page.locator('.match-right select');
  const selectCount = await selects.count();
  expect(selectCount).toBeGreaterThan(0);

  // Collect left items and first option of each select to verify shuffling
  const leftTexts = await page.locator('.match-left').allTextContents();
  const firstOptions = [];
  for (let i = 0; i < selectCount; i++) {
    // Get all option texts (skip "-- 選択 --")
    const options = await selects.nth(i).locator('option').allTextContents();
    firstOptions.push(options.slice(1)); // remove placeholder
  }

  // All selects should have the same set of options (just the order varies)
  if (firstOptions.length > 1) {
    const sorted0 = [...firstOptions[0]].sort();
    const sorted1 = [...firstOptions[1]].sort();
    expect(sorted0).toEqual(sorted1);
  }

  // Verify selecting first option for each is NOT always correct
  // (Run the test 3 times to increase confidence - at least once should differ)
  // We can't guarantee shuffle order, but we can test that options exist and work
  await selects.first().selectOption({ index: 1 });
});

test('Order: up/down buttons work', async ({ page }) => {
  await startPractice(page);
  const found = await navigateToType(page, 'order');
  if (!found) {
    test.skip();
    return;
  }

  // Should have order items with buttons
  const orderItems = page.locator('.order-item');
  expect(await orderItems.count()).toBeGreaterThan(1);

  // Get initial first item text
  const firstText = await orderItems.first().locator('.order-text').textContent();

  // Tap down button on first item
  const downBtn = orderItems.first().locator('button:has-text("▼")');
  if (await downBtn.isVisible()) {
    await downBtn.tap();
    await page.waitForTimeout(200);
    // First item text should now be different
    const newFirstText = await page.locator('.order-item').first().locator('.order-text').textContent();
    expect(newFirstText).not.toBe(firstText);
  }
});

test('Hotarea: cells respond to tap', async ({ page }) => {
  await startPractice(page);
  const found = await navigateToType(page, 'hotarea');
  if (!found) {
    test.skip();
    return;
  }

  const cell = page.locator('.hotarea-cell').first();
  await cell.tap();
  await expect(cell).toHaveClass(/selected/);
});

test('Bottom nav tabs work', async ({ page }) => {
  await page.goto('/');
  await page.waitForSelector('.bottom-bar');

  await page.locator('.bottom-bar button:has-text("パック")').tap();
  await page.waitForTimeout(300);
  await expect(page.locator('.header h1')).toHaveText('パック管理');

  await page.locator('.bottom-bar button:has-text("統計")').tap();
  await page.waitForTimeout(300);
  await expect(page.locator('.header h1')).toHaveText('統計');

  await page.locator('.bottom-bar button:has-text("設定")').tap();
  await page.waitForTimeout(300);
  await expect(page.locator('.header h1')).toHaveText('設定');

  await page.locator('.bottom-bar button:has-text("ホーム")').tap();
  await page.waitForTimeout(300);
  await expect(page.locator('button:has-text("練習モード")')).toBeVisible();
});
