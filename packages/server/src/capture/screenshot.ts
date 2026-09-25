import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { imageSize } from '../assets/store.js';

/**
 * Taking the pictures the Preview tab compares against the mockups.
 *
 * A capture target is a path and a viewport width, and that is the whole
 * vocabulary on purpose: the capturer opens a URL and photographs it. It does
 * not sign in, click through a flow or fill a form. A state worth a picture has
 * to be reachable by URL — a route, a query parameter, a seeded fixture — which
 * is a real constraint and is stated as one in the planning prompt rather than
 * papered over with a journey scripting language nobody asked for.
 *
 * The same browser also draws the mockups Planning returns as HTML, so a
 * generated mockup and the screenshot it is compared with come out of one
 * renderer at one width.
 */

export interface CaptureTarget {
  /** What this shows, and the key a mockup is paired to it by. */
  label: string;
  /** App path, e.g. `/cart`. Joined onto the dev server's base URL. */
  path: string;
  viewport: number;
}

export interface Capture {
  label: string;
  path: string;
  viewport: number;
  bytes: Buffer;
  width: number;
  height: number;
}

export interface CaptureFailure {
  label: string;
  reason: string;
}

export interface CaptureResult {
  captures: Capture[];
  failures: CaptureFailure[];
  /** Set when nothing could be attempted at all — usually no browser installed. */
  unavailable: string | null;
}

/** Tall enough that a full-page shot of a normal page needs no scrolling. */
const VIEWPORT_HEIGHT = 900;
const NAVIGATION_TIMEOUT_MS = 15_000;

/**
 * Never throws.
 *
 * A missing browser binary, a page that will not load, a dev server that died
 * halfway — none of these are worth failing a Testing run over. The run's real
 * job is verifying the acceptance criteria, and it can report on pictures it
 * could not take. `unavailable` and `failures` carry that up instead.
 */
export async function captureTargets(opts: {
  baseUrl: string;
  targets: CaptureTarget[];
}): Promise<CaptureResult> {
  const { baseUrl, targets } = opts;
  return photograph(targets, {}, async (page, target) => {
    await page.goto(new URL(target.path, baseUrl).toString(), {
      waitUntil: 'networkidle',
      timeout: NAVIGATION_TIMEOUT_MS,
    });
  });
}

/** A mockup Planning drew: a capture target, plus the page to draw it from. */
export interface MockupSource extends CaptureTarget {
  html: string;
}

/**
 * Turn the HTML Planning returned into the PNG every other stage reads.
 *
 * Offline and without scripts, on purpose: the HTML is Claude's, so it gets no
 * network to reach and no code to run, and the same document renders to the
 * same picture every time. A mockup that asked for a web font or an image
 * renders without it rather than hanging. Never throws, like `captureTargets`.
 */
export async function renderMockups(mockups: MockupSource[]): Promise<CaptureResult> {
  return photograph(mockups, { javaScriptEnabled: false }, async (page, mockup) => {
    await page.route('**/*', (route) => route.abort());
    await page.setContent(mockup.html, { waitUntil: 'load', timeout: NAVIGATION_TIMEOUT_MS });
  });
}

/**
 * The part both share: one browser, a fresh context per target at its width,
 * and a full-page PNG of whatever `load` put in the page.
 */
async function photograph<T extends CaptureTarget>(
  targets: T[],
  contextOptions: { javaScriptEnabled?: boolean },
  load: (page: Page, target: T) => Promise<void>,
): Promise<CaptureResult> {
  if (targets.length === 0) return { captures: [], failures: [], unavailable: null };

  let browser: Browser;
  try {
    browser = await chromium.launch();
  } catch (cause) {
    const detail = firstLine(cause);
    return {
      captures: [],
      failures: [],
      unavailable: `could not start a browser (${detail}). Run \`npx playwright install chromium\`.`,
    };
  }

  const captures: Capture[] = [];
  const failures: CaptureFailure[] = [];
  try {
    for (const target of targets) {
      let context: BrowserContext | undefined;
      try {
        // A context per target: the viewport is per-context, and a fresh one also
        // means no state leaks from the previous page into this picture. Inside
        // the try, because a width the browser refuses fails this target only.
        context = await browser.newContext({
          viewport: { width: target.viewport, height: VIEWPORT_HEIGHT },
          deviceScaleFactor: 1,
          reducedMotion: 'reduce',
          ...contextOptions,
        });
        const page = await context.newPage();
        await load(page, target);
        const bytes = await page.screenshot({ fullPage: true, type: 'png' });
        // Measured from the PNG we just took rather than asked of the page: a
        // full-page shot is as tall as the document, and the file already knows.
        const size = imageSize(bytes);
        captures.push({
          label: target.label,
          path: target.path,
          viewport: target.viewport,
          bytes,
          width: size?.width ?? target.viewport,
          height: size?.height ?? VIEWPORT_HEIGHT,
        });
      } catch (cause) {
        failures.push({ label: target.label, reason: firstLine(cause) });
      } finally {
        await context?.close().catch(() => {});
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }

  return { captures, failures, unavailable: null };
}

/** Playwright errors carry a whole essay; the first line is the useful part. */
function firstLine(cause: unknown): string {
  const text = cause instanceof Error ? cause.message : String(cause);
  return text.split('\n')[0] ?? text;
}
