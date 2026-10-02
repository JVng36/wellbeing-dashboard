import { expect, request, test, type Locator, type Page } from '@playwright/test';

const password = 'synthetic browser correction password';

async function signIn(page: Page) {
  await page.goto('/');
  const username = page.getByLabel('Username');
  await expect(username).toBeVisible();
  const setup = page.getByRole('button', { name: 'Create owner' });
  if (await setup.isVisible()) {
    await username.fill('owner');
    await page.getByLabel('Password').fill(password);
    await setup.click();
  } else {
    await username.fill('owner');
    await page.getByLabel('Password').fill(password);
    await page.getByRole('button', { name: 'Sign in' }).click();
  }
  await expect(page.getByRole('heading', { name: 'Your wellbeing journal' })).toBeVisible();
}

async function createEvent(page: Page, minutes: string) {
  await page.getByRole('button', { name: /Add sleep record/ }).click();
  await page.getByLabel('Local date').fill('2026-09-28');
  await page.getByLabel('Duration in minutes').fill(minutes);
  await page.getByRole('button', { name: 'Save record' }).click();
  await expect(page.locator('.event-card').first()).toBeVisible();
}

async function assertTabContained(page: Page, dialog: Locator, steps = 10) {
  const close = dialog.getByRole('button', { name: /close/i });
  await close.focus();
  await expect(close).toBeFocused();
  for (let index = 0; index < steps; index += 1) {
    await page.keyboard.press('Tab');
    expect(await dialog.evaluate((node) => node.contains(document.activeElement))).toBe(true);
  }
  await page.keyboard.press('Shift+Tab');
  expect(await dialog.evaluate((node) => node.contains(document.activeElement))).toBe(true);
}

test('manual event edit saves current revision and exposes full history attribution', async ({ page }) => {
  await signIn(page);
  await createEvent(page, '420');
  const card = page.locator('.event-card').first();
  await card.getByRole('button', { name: /Edit|Correct/ }).click();
  const editor = page.getByRole('dialog', { name: /edit|correct/i });
  await expect(editor).toBeVisible();
  await editor.getByLabel(/Duration in minutes/i).fill('435');
  await editor.getByRole('button', { name: /Save (correction|changes|record)/i }).click();
  await expect(page.getByText('7h 15m')).toBeVisible();
  await page.locator('.event-card').filter({ hasText: '7h 15m' }).getByRole('button', { name: /View history/ }).click();
  const history = page.getByRole('dialog', { name: /Record history/i });
  await expect(history).toContainText(/owner:/i);
  await expect(history).toContainText(/435|7h 15m/);
  await expect(history).toContainText(/duration|event type|source/i);
});

test('stale browser event edit retains draft and offers refresh or reconcile', async ({ page }) => {
  await signIn(page);
  await createEvent(page, '420');
  const listed = await page.request.get('/api/v1/events');
  const event = (await listed.json()).find((row: { localDate: string }) => row.localDate === '2026-09-28');
  expect(event).toBeTruthy();
  const editorButton = page.locator('.event-card').first().getByRole('button', { name: /Edit|Correct/ });
  await editorButton.click();
  const editor = page.getByRole('dialog', { name: /edit|correct/i });
  await editor.getByLabel(/Duration in minutes/i).fill('435');

  const second = await request.newContext({ baseURL: new URL(page.url()).origin });
  try {
    const login = await second.post('/api/v1/auth/login', { headers: { origin: new URL(page.url()).origin }, data: { username: 'owner', password } });
    const csrf = (await login.json()).csrfToken;
    const changed = await second.put(`/api/v1/events/${event.id}`, { headers: { origin: new URL(page.url()).origin, 'x-csrf-token': csrf }, data: { expectedRevision: event.currentRevision, durationMinutes: 440, notes: 'concurrent untouched field' } });
    expect(changed.status()).toBe(200);
    await editor.getByRole('button', { name: /Save (correction|changes|record)/i }).click();
    await expect(page.getByRole('alert')).toContainText(/draft remains intact|save to rebase|latest values/i);
    await expect(editor.getByLabel(/Duration in minutes/i)).toHaveValue('435');
    await expect(editor.getByRole('button', { name: /refresh|reconcile/i })).toBeVisible();
    await editor.getByRole('button', { name: 'Refresh/reconcile latest' }).click();
    await expect(editor).toContainText(/newer|server duration|review/i);
    await editor.getByRole('button', { name: /Save correction/i }).click();
    await expect(page.getByText('7h 15m')).toBeVisible();
    await expect(page.locator('.event-card').filter({ hasText: '7h 15m' })).toContainText('concurrent untouched field');
    await page.locator('.event-card').filter({ hasText: '7h 15m' }).getByRole('button', { name: /View history/ }).click();
    await expect(page.getByRole('dialog', { name: /Record history/i })).toContainText(/synthetic|owner:|durationMinutes/);
  } finally { await second.dispose(); }
});

test('journal date filters are independently available', async ({ page }) => {
  await signIn(page);
  await expect(page.getByLabel('From date')).toBeVisible();
  await expect(page.getByLabel('To date')).toBeVisible();
  await expect(page.getByRole('button', { name: /Apply filters/i })).toBeVisible();
});

test('trend detail independently shows boundaries, per-metric coverage, gaps, and freshness', async ({ page }) => {
  await signIn(page);
  await page.getByRole('button', { name: /Trends/ }).click();
  await expect(page.getByText(/Window start:\s*\d{4}-\d\d-\d\d/i)).toBeVisible();
  await expect(page.getByRole('table')).toBeVisible();
  await expect(page.getByRole('table')).toContainText(/Unknown|Date/);
  await expect(page.getByText(/per-metric coverage/i)).toBeVisible();
  await expect(page.getByText(/gap|missing/i)).toBeVisible();
  await expect(page.getByTestId('trend-summary-state')).toHaveText(/stale|fresh/i);
});

test('add, edit, event history, and note history dialogs contain Tab focus and restore focus on Escape', async ({ page }) => {
  await signIn(page);
  const add = page.getByRole('button', { name: /Add sleep record/ });
  await add.click();
  const addDialog = page.getByRole('dialog', { name: /What would you like to remember/ });
  await assertTabContained(page, addDialog);
  await page.keyboard.press('Escape');
  await expect(addDialog).toBeHidden();
  await expect(add).toBeFocused();

  await createEvent(page, '10');
  const card = page.locator('.event-card').first();
  await card.getByRole('button', { name: /Edit|Correct/ }).click();
  const editDialog = page.getByRole('dialog', { name: /edit|correct/i });
  await assertTabContained(page, editDialog);
  await page.keyboard.press('Escape');
  await expect(editDialog).toBeHidden();
  await expect(card.getByRole('button', { name: /Edit|Correct/ })).toBeFocused();

  await card.getByRole('button', { name: /View history/ }).click();
  const eventHistory = page.getByRole('dialog', { name: /Record history/i });
  await assertTabContained(page, eventHistory);
  await page.keyboard.press('Escape');
  await expect(eventHistory).toBeHidden();

  await page.getByRole('button', { name: /Notes/ }).click();
  await page.getByLabel('New note').fill('Synthetic history modal note');
  await page.getByRole('button', { name: 'Save note' }).click();
  await page.getByRole('button', { name: 'History' }).click();
  const noteHistory = page.getByRole('dialog', { name: 'Note history' });
  await assertTabContained(page, noteHistory);
  await page.keyboard.press('Escape');
  await expect(noteHistory).toBeHidden();
});

test('note ambiguous transport retry commits once with the same idempotency key', async ({ page }) => {
  await signIn(page);
  await page.getByRole('button', { name: /Notes/ }).click();
  const keys: string[] = [];
  let first = true;
  await page.route('**/api/v1/notes', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    keys.push(route.request().headers()['idempotency-key'] ?? '');
    if (first) { first = false; await route.fetch(); await route.abort(); return; }
    await route.continue();
  });
  const body = page.getByLabel('New note');
  await body.fill('Synthetic committed retry note');
  await page.getByRole('button', { name: 'Save note' }).click();
  await expect(page.locator('.error').first()).toBeVisible();
  await expect(body).toHaveValue('Synthetic committed retry note');
  await page.getByRole('button', { name: 'Save note' }).click();
  await expect(page.getByText('Synthetic committed retry note')).toHaveCount(1);
  expect(keys).toHaveLength(2); expect(keys[0]).toBeTruthy(); expect(keys[1]).toBe(keys[0]);
  const notes = await page.request.get('/api/v1/notes');
  expect((await notes.json()).filter((row: { body: string }) => row.body === 'Synthetic committed retry note')).toHaveLength(1);
});

test('note pending guard prevents delayed double-submit duplicates', async ({ page }) => {
  await signIn(page);
  await page.getByRole('button', { name: /Notes/ }).click();
  let postCount = 0;
  await page.route('**/api/v1/notes', async (route) => {
    if (route.request().method() === 'POST') { postCount += 1; await new Promise((resolve) => setTimeout(resolve, 300)); }
    await route.continue();
  });
  const body = page.getByLabel('New note');
  await body.fill('Synthetic delayed double-submit note');
  await page.getByRole('button', { name: 'Save note' }).dblclick();
  await expect.poll(() => postCount).toBe(1);
  await expect.poll(async () => (await page.request.get('/api/v1/notes')).json()).toEqual(expect.arrayContaining([expect.objectContaining({ body: 'Synthetic delayed double-submit note' })]));
  await expect(page.locator('.notes-grid article').filter({ hasText: 'Synthetic delayed double-submit note' })).toHaveCount(1);
  const notes = await page.request.get('/api/v1/notes');
  expect((await notes.json()).filter((row: { body: string }) => row.body === 'Synthetic delayed double-submit note')).toHaveLength(1);
});

test('event ambiguous transport retry commits once with one stable key', async ({ page }) => {
  await signIn(page);
  const keys: string[] = []; let first = true;
  await page.route('**/api/v1/events', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    keys.push(route.request().headers()['idempotency-key'] ?? '');
    if (first) { first = false; await route.fetch(); await route.abort(); return; }
    await route.continue();
  });
  await page.getByRole('button', { name: /Add sleep record/ }).click();
  await page.getByLabel('Local date').fill('2026-09-28');
  await page.getByLabel('Duration in minutes').fill('33');
  await page.getByRole('button', { name: 'Save record' }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await page.getByRole('button', { name: 'Save record' }).click();
  await expect(page.getByText('0h 33m')).toBeVisible();
  expect(keys).toHaveLength(2); expect(keys[0]).toBeTruthy(); expect(keys[1]).toBe(keys[0]);
  const events = await page.request.get('/api/v1/events?from=2026-09-28&to=2026-09-28');
  expect((await events.json()).filter((row: { durationMinutes: number }) => row.durationMinutes === 33)).toHaveLength(1);
});

test('session grouping ambiguous retry commits one group with one stable key', async ({ page }) => {
  await signIn(page);
  await createEvent(page, '20');
  await page.getByRole('checkbox').first().check();
  const keys: string[] = []; let first = true;
  await page.route('**/api/v1/sessions', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    keys.push(route.request().headers()['idempotency-key'] ?? '');
    if (first) { first = false; await route.fetch(); await route.abort(); return; }
    await route.continue();
  });
  await page.getByRole('button', { name: 'Group selected' }).click();
  await expect(page.locator('.session-panel .error')).toBeVisible();
  await page.getByRole('button', { name: 'Group selected' }).click();
  await expect(page.getByText(/1 explicit session/)).toBeVisible();
  expect(keys).toHaveLength(2); expect(keys[0]).toBeTruthy(); expect(keys[1]).toBe(keys[0]);
  const sessions = await page.request.get('/api/v1/sessions');
  expect((await sessions.json()).filter((row: { kind: string }) => row.kind === 'overnight')).toHaveLength(1);
});

test('mixed uncertain corrected nap and note data renders at both viewport widths', async ({ page }, testInfo) => {
  await signIn(page);
  const status = await (await page.request.get('/api/v1/auth/status')).json(); const headers = { origin: new URL(page.url()).origin, 'x-csrf-token': status.csrfToken };
  const post = (data: unknown) => page.request.post('/api/v1/events', { headers, data });
  for (const event of [
    { id: 'mixed-onset', eventType: 'sleep_onset', localDate: '2026-09-28', timezone: 'UTC', startAtLocal: '2026-09-28T23:00', localOffset: '+00:00', uncertainty: { prose: 'synthetic uncertain onset' } },
    { id: 'mixed-wake', eventType: 'final_wake', localDate: '2026-09-29', timezone: 'UTC', endAtLocal: '2026-09-29T07:00', endLocalOffset: '+00:00' },
    { id: 'mixed-correction', eventType: 'duration_report', localDate: '2026-09-28', timezone: 'UTC', durationMinutes: 300, sourceReference: 'corrected-duration', metricOverrides: { durationMinutes: { value: 420, basis: 'explicit_user_correction' } } },
    { id: 'mixed-nap', eventType: 'nap', localDate: '2026-09-28', timezone: 'UTC', durationMinutes: 25 },
    { id: 'mixed-orphan', eventType: 'nap_start', localDate: '2026-09-28', timezone: 'UTC', startAtLocal: '2026-09-28T13:00', localOffset: '+00:00' },
    { id: 'mixed-outside', eventType: 'duration_report', localDate: '2026-09-20', timezone: 'UTC', durationMinutes: 12, sourceReference: 'outside-filter-marker' }
  ]) { expect((await post(event)).status()).toBe(201); }
  expect((await page.request.post('/api/v1/sessions', { headers, data: { id: 'mixed-overnight', kind: 'overnight', localDate: '2026-09-28', timezone: 'UTC', events: [{ id: 'mixed-onset', expectedRevision: 1 }, { id: 'mixed-wake', expectedRevision: 1 }] } })).status()).toBe(201);
  expect((await page.request.post('/api/v1/notes', { headers, data: { id: 'mixed-note', body: 'mixed synthetic note', rangeStart: '2026-09-28', rangeEnd: '2026-09-29' } })).status()).toBe(201);
  await page.getByRole('button', { name: /Refresh records/i }).click(); await expect(page.getByText(/Overnight group/)).toBeVisible(); await expect(page.getByText('outside-filter-marker')).toBeVisible();
  await page.getByLabel('From date').fill('2026-09-28'); await page.getByLabel('To date').fill('2026-09-29'); await page.getByRole('button', { name: /Apply filters/i }).click(); await expect(page.getByText('outside-filter-marker')).toHaveCount(0);
  await page.getByRole('button', { name: /Trends/ }).click(); await expect(page.getByRole('columnheader', { name: 'Completed naps' })).toBeVisible(); const provenance = page.locator('section.trend-detail').filter({ hasText: 'Selected metric provenance' }); await expect(provenance).toHaveCount(1); await expect(provenance.getByRole('heading', { name: 'Selected metric provenance' })).toBeVisible(); const selectedDuration = provenance.locator('article').filter({ hasText: 'mixed-correction' }); await expect(selectedDuration).toHaveCount(1); await expect(selectedDuration).toContainText('420'); await expect(selectedDuration).toContainText('explicit_user_correction');
  const mixedDay = page.getByRole('row').filter({ has: page.getByRole('rowheader', { name: '2026-09-28', exact: true }) }); await expect(mixedDay).toHaveCount(1); await expect(mixedDay.locator('td').nth(0)).toHaveText('445'); await expect(mixedDay.locator('td').nth(1)).toHaveText('480'); await expect(mixedDay.locator('td').nth(3)).toHaveText('1'); const unknownDay = page.getByRole('row').filter({ has: page.getByRole('rowheader', { name: '2026-09-27', exact: true }) }); await expect(unknownDay).toHaveCount(1); await expect(unknownDay.locator('td').nth(0)).toHaveText('Unknown');
  const windowCard = page.locator('.metric-grid article').filter({ hasText: 'Window start:' }); await expect(windowCard).toHaveCount(1); const sevenDayWindow = await windowCard.innerText(); const sevenBoundary = sevenDayWindow.match(/Window start:\s*(\S+)[\s\S]*Window end:\s*(\S+)/); expect(sevenBoundary).not.toBeNull(); const selectWindow = async (days: 30 | 90) => { const [response] = await Promise.all([page.waitForResponse((candidate) => candidate.ok() && new URL(candidate.url()).pathname.endsWith(`/api/v1/trends/${days}`)), page.getByRole('button', { name: `${days} days`, exact: true }).click()]); const payload = await response.json() as { windowDays: number; windowStart: string; windowEnd: string }; expect(payload.windowDays).toBe(days); await expect(windowCard).toContainText(`Window start: ${payload.windowStart}`); await expect(windowCard).toContainText(`Window end: ${payload.windowEnd}`); return payload; }; const thirtyDay = await selectWindow(30); expect(`${thirtyDay.windowStart}/${thirtyDay.windowEnd}`).not.toBe(`${sevenBoundary?.[1]}/${sevenBoundary?.[2]}`); const ninetyDay = await selectWindow(90); expect(`${ninetyDay.windowStart}/${ninetyDay.windowEnd}`).not.toBe(`${thirtyDay.windowStart}/${thirtyDay.windowEnd}`);
  const [sevenResponse] = await Promise.all([page.waitForResponse((candidate) => candidate.ok() && new URL(candidate.url()).pathname.endsWith('/api/v1/trends/7')), page.getByRole('button', { name: '7 days', exact: true }).click()]); const sevenPayload = await sevenResponse.json() as { windowDays: number; windowStart: string; windowEnd: string }; expect(sevenPayload.windowDays).toBe(7); await expect(windowCard).toContainText(`Window start: ${sevenPayload.windowStart}`); await expect(windowCard).toContainText(`Window end: ${sevenPayload.windowEnd}`); for (const width of [390, 1440]) { await page.setViewportSize({ width, height: width === 390 ? 844 : 900 }); await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true); await page.screenshot({ path: testInfo.outputPath(`mixed-${width}.png`), fullPage: true }); }
});
