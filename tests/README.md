# Tests

`squish-hq.test.js` is a plain Node script that drives real browsers with the [Playwright](https://playwright.dev/) library. There is no test runner to configure. Every test gets a fresh browser (so empty storage), and a test fails if the page throws an error or asks for anything that isn't a local file.

## Run

```sh
npm ci
npx playwright install chromium webkit
npm run test:smoke                          # smoke tier: 8 core tests, Chromium desktop (a few seconds)
npm run test:quick                          # quick tier: all tests, Chromium desktop (under a minute)
npm test                                    # full tier: all tests, 3 browser setups
node tests/squish-hq.test.js                # Chromium desktop + Chromium iPhone 13
node tests/squish-hq.test.js --webkit       # ...plus WebKit iPhone 13 (what npm test does)
node tests/squish-hq.test.js --grep=reset   # only tests whose name contains "reset"
node tests/squish-hq.test.js --project=webkit-iphone13 --webkit
node tests/squish-hq.test.js --smoke        # only the smoke tests (combine with --project)
node tests/squish-hq.test.js --workers=2    # how many tests run at once
npm run test:quick -- --workers=1           # options work through npm too, after "--"
SHOTS=out node tests/squish-hq.test.js      # also save review screenshots into ./out
RESULTS=times.json npm run test:quick       # also write each test's result and time to a file
```

On Windows PowerShell, set the environment variable first: `$env:SHOTS = "out"`.

### Speed

Tests run in parallel. Each worker has its own browser, and every test still gets a fresh browser context (its own storage, downloads and pages), so tests never share data. The default is 4 workers, or the number of CPU cores if that is smaller. The local test server only serves files, so all workers share it safely. At the end the runner prints the ten slowest tests and the total time.

On Chromium, the runner plays the app's CSS animations 10 times faster. Each wizard step pops in for 0.38 s, and Playwright waits for things to stop moving before it clicks, so this used to be most of the run time. The animations still run, and the reduced-motion test still checks that they switch off. WebKit runs at normal speed.

### Smoke tests

`npm run test:smoke` runs these, chosen to touch the main paths quickly (the list lives in `SMOKE_TESTS` near the top of the test file, and the runner stops if a name there no longer exists):

- **Click-through and reload:** "regression: localStorage persistence mid-wizard and reload on finished plan"
- **Reset:** "reset: clears storage, state, charts, views; focus and scroll to top"
- **Export, reset, import:** "round trip: export -> reset -> import gives an identical plan page"
- **Hostile file:** "import: malicious strings are escaped on every render path; extras dropped; lengths clamped"
- **No external requests:** "repo: no external requests from file:// (fonts and Chart.js are local and actually load)"
- **Keyboard only:** "fix 2: the whole wizard can be completed with the keyboard only"
- **Break-even:** "C: break-even arithmetic (unit tests, all currencies)"
- **axe:** "axe: welcome, every control type, the dialog and the plan have no serious or critical issues" (includes the plan page)

## On GitHub

`.github/workflows/test.yml` runs `npm run test:quick` (Chromium desktop only) on every push and pull request. The full `npm test` run on all three browser setups happens for version tags, and whenever you start it from the Actions tab with "Run workflow".

## What's covered

- **Regressions:** multi-part markup, the Enter key, saving and reloading, tap target sizes, one founder, the product or service question, suggestion tiles running out.
- **Start again:** the dialog (focus trap, Escape, tapping outside, Cancel focused first, focus returned), backup files and their names, and that a reset can't be undone by the page's save-on-close code or by a second open tab.
- **Load a saved plan:** 28 broken or hostile files, escaping on every screen, and export, reset, import giving the identical plan.
- **Accessibility:** a full keyboard-only walk, labels and names, focus on each step heading, errors announced, the progress bar, reduced motion, one h1 per screen, colour contrast pairs, and [axe-core](https://github.com/dequelabs/axe-core) on every kind of screen (fails on serious or critical issues and prints any minor ones).
- **Learning features:** every idea button in both kinds (including that no suggestion mentions online, social media or websites), words of the step, "Think about it" nudges, break-even maths in several currencies, and the Grown-up check (including that it never contradicts a fair, a market or a typed "Online").
- **Plan page and print:** stat numbers and table money never wrap, in all 12 currencies at their biggest, from 360px to desktop and in print (B1); headings, captions and chart titles keep with what follows and small blocks never split (B2); the cover and step circles read with background graphics off (B3); whole-number chart axes, whole sats and trimmed BTC (B4); the print tip by the Print button (B6); portrait pages, and both review plans on 6 pages or fewer on A4 and Letter, with background graphics on and off (B7, rendered to PDF in Chromium with the print styles); the signature labels in the Grown-up check sit fully inside the card with at least 8px to spare and room above the lines to sign, on screen, on a phone and in print at A4 and Letter widths (R6-2).
- **"a" or "an" before a number:** follows how the figure is read aloud ("an 80%", "an £8.00", "an ₹11,000", "a 75%", "a 1,800"), checked against a table of percentages, counts and amounts in all 12 currencies, and on the plan page (R6-1).
- **One founder or several:** a solo plan (product and service, on the page, in the `.md` and in the Grown-up check) never says "team", "founders", "between them", "everyone in" or "each founder", and shows one sentence instead of the share table; a two-founder plan keeps the table and the team wording.
- **Money tables and stat rows:** when a money table has to scroll sideways it becomes a named, focusable region with a visible focus ring (and no extra tab stop otherwise, and no scrolling in print); no stat card is left alone on a row at desktop, tablet or print widths.
- **The runner itself:** a run that selects no tests (a mistyped `--grep` or `--project`) fails with a clear message.
- **Repo:** no external requests, a sub-path http server (like GitHub Pages), a missing Chart.js file, and the head metadata (the Open Graph links point at the GitHub Pages address and the picture exists).
