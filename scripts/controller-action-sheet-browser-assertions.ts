import type { Locator, Page } from "playwright";

export async function assertControllerActionSheet(page: Page, stage: string) {
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 412, height: 915 },
  ]) {
    await page.setViewportSize(viewport);
    const navigation = page.locator('[data-controller-action-navigation="true"]');
    await navigation.waitFor();
    assert(
      (await page.locator('[data-controller-action-panel="true"]').count()) === 0,
      `${stage} opened with an action panel selected at ${viewport.width}x${viewport.height}`,
    );
    const navigationBox = await navigation.boundingBox();
    assert(navigationBox !== null, `${stage} action navigation was not laid out`);
    assert(
      navigationBox.y + navigationBox.height <= viewport.height + 1,
      `${stage} action navigation crossed the safe viewport edge`,
    );

    const cards = page.getByRole("button", { name: "Cards", exact: true });
    const timeout = page.getByRole("button", { name: "Timeout", exact: true });
    const gameEnd = page.getByRole("button", { name: "Game end", exact: true });
    if (
      viewport.width === 390 &&
      (await page.locator('button[aria-label="Start game"]').count()) > 0
    ) {
      await assertAdHocCompletionJourney(page, cards, timeout, stage);
    }
    await cards.click();
    await assertOpenPanel(page, "Cards", cards, navigation, stage, viewport);
    await cards.click();
    assert(
      (await page.locator('[data-controller-action-panel="true"]').count()) === 0,
      `${stage} same-action close did not close Cards`,
    );
    assert(
      (await page.evaluate(() => document.activeElement?.textContent?.trim())) === "Cards",
      `${stage} closing Cards did not restore focus to its disclosure button`,
    );
    await timeout.click();
    await assertOpenPanel(page, "Timeout", timeout, navigation, stage, viewport);
    await gameEnd.click();
    await assertOpenPanel(page, "Game end", gameEnd, navigation, stage, viewport);
    await gameEnd.click();
    assert(
      (await page.locator('[data-controller-action-panel="true"]').count()) === 0,
      `${stage} selected Game end action did not close`,
    );
    assert(
      (await page.evaluate(() => document.activeElement?.textContent?.trim())) === "Game end",
      `${stage} closing Game end did not restore focus to its disclosure button`,
    );

    const clock = page.locator(
      'button[aria-label="Start game"], button[aria-label="Start game clock"], button[aria-label="Pause game"], button[aria-label="Pause game clock"]',
    );
    const scoreControls = page.locator('button[data-primary-score="up"]');
    const scoreDownControls = page.locator('button[data-primary-score="down"]');
    assert(
      (await scoreControls.count()) >= 2,
      `${stage} did not render both primary score controls`,
    );
    await cards.click();
    const panel = page.locator('[data-controller-action-panel="true"]');
    await panel.waitFor();
    await assertPrimaryControlsDoNotIntersect(
      panel,
      navigation,
      clock,
      scoreControls,
      scoreDownControls,
      stage,
      viewport,
    );
    if ((await clock.count()) > 0) {
      await clock.first().click();
      await page.locator('[data-controller-action-panel="true"]').waitFor();
    }
    for (let index = 0; index < (await scoreControls.count()); index += 1) {
      await scoreControls.nth(index).click();
      await page.locator('[data-controller-action-panel="true"]').waitFor();
    }
    for (let index = 0; index < (await scoreDownControls.count()); index += 1) {
      await scoreDownControls.nth(index).click();
      await page.locator('[data-controller-action-panel="true"]').waitFor();
    }
    assert(
      (await page.locator('[data-controller-action-panel="true"]').count()) === 1,
      `${stage} primary controls cleared the open action draft`,
    );
    if ((await clock.count()) > 0) {
      const runningClock = page.locator(
        'button[aria-label="Pause game"], button[aria-label="Pause game clock"]',
      );
      if ((await runningClock.count()) > 0) await runningClock.first().click();
      await page.locator('[data-controller-action-panel="true"]').waitFor();
    }
    await cards.click();
  }
}

async function assertAdHocCompletionJourney(
  page: Page,
  cards: Locator,
  timeout: Locator,
  stage: string,
) {
  await cards.click();
  const panel = page.locator('[data-controller-action-panel="true"]');
  const ok = panel.getByRole("button", { name: "OK", exact: true });
  const blue = panel.getByRole("button", { name: "Blue", exact: true });
  await blue.scrollIntoViewIfNeeded();
  await blue.click();
  const home = panel.getByRole("button", { name: "Home", exact: true });
  await home.scrollIntoViewIfNeeded();
  await home.click();
  assert(
    (await panel.getByRole("alert").count()) > 0,
    `${stage} missing Ad Hoc player number was not retained`,
  );
  await panel.getByRole("button", { name: "7", exact: true }).click();
  await ok.scrollIntoViewIfNeeded();
  await ok.click();
  assert(
    (await page.locator('[data-controller-action-panel="true"]').count()) === 0,
    `${stage} accepted Ad Hoc card did not close its panel`,
  );
  assert(
    (await page.evaluate(() => document.activeElement?.textContent?.trim())) === "Cards",
    `${stage} accepted Ad Hoc card did not restore Cards focus`,
  );

  await timeout.click();
  const homeTimeout = page.getByRole("button", { name: "Home timeout", exact: true });
  await homeTimeout.scrollIntoViewIfNeeded();
  await homeTimeout.click();
  assert(
    (await page.locator('[data-controller-action-panel="true"]').count()) === 1,
    `${stage} incomplete Ad Hoc timeout stoppage closed its panel`,
  );
  const startTimeout = page.getByRole("button", { name: "Start", exact: true });
  await startTimeout.scrollIntoViewIfNeeded();
  await startTimeout.click();
  assert(
    (await page.locator('[data-controller-action-panel="true"]').count()) === 0,
    `${stage} accepted Ad Hoc timeout start did not close its panel`,
  );
  assert(
    (await page.evaluate(() => document.activeElement?.textContent?.trim())) === "Timeout",
    `${stage} accepted Ad Hoc timeout did not restore Timeout focus`,
  );
}

async function assertOpenPanel(
  page: Page,
  label: string,
  action: Locator,
  navigation: Locator,
  stage: string,
  viewport: { width: number; height: number },
) {
  const panel = page.locator('[data-controller-action-panel="true"]');
  await panel.waitFor();
  assert(
    (await action.getAttribute("aria-expanded")) === "true",
    `${stage} ${label} action was not expanded`,
  );
  const panelBox = await panel.boundingBox();
  const navigationBox = await navigation.boundingBox();
  assert(panelBox !== null && navigationBox !== null, `${stage} ${label} panel was not laid out`);
  assert(
    panelBox.y + panelBox.height <= navigationBox.y + 1,
    `${stage} ${label} panel overlapped navigation at ${viewport.width}x${viewport.height}`,
  );
}

async function assertPrimaryControlsDoNotIntersect(
  panel: Locator,
  navigation: Locator,
  clock: Locator,
  scoreControls: Locator,
  scoreDownControls: Locator,
  stage: string,
  viewport: { width: number; height: number },
) {
  const covered = [panel, navigation];
  const controls = [
    clock.first(),
    scoreControls.nth(0),
    scoreControls.nth(1),
    scoreDownControls.nth(0),
    scoreDownControls.nth(1),
  ];
  for (const [controlIndex, control] of controls.entries()) {
    if ((await control.count()) === 0) continue;
    const controlBox = await control.boundingBox();
    assert(controlBox !== null, `${stage} primary control ${controlIndex} was not laid out`);
    for (const [coveredIndex, coveredLocator] of covered.entries()) {
      const coveredBox = await coveredLocator.boundingBox();
      assert(coveredBox !== null, `${stage} covered region ${coveredIndex} was not laid out`);
      assert(
        !intersects(controlBox, coveredBox),
        `${stage} primary control ${controlIndex} intersected region ${coveredIndex} at ${viewport.width}x${viewport.height}: control=${JSON.stringify(controlBox)} covered=${JSON.stringify(coveredBox)}`,
      );
    }
  }
}

function intersects(
  first: { x: number; y: number; width: number; height: number },
  second: { x: number; y: number; width: number; height: number },
) {
  return !(
    first.x + first.width <= second.x ||
    second.x + second.width <= first.x ||
    first.y + first.height <= second.y ||
    second.y + second.height <= first.y
  );
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
