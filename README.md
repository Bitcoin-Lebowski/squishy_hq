# Squish HQ

Squish HQ helps children aged 8 to 11, with a grown-up nearby, build a real plan for a small business: a lemonade stand, dog walking, slime making, or any idea they have. It asks 11 friendly questions, does the money maths as they type, and finishes with a printable plan page with charts, a list of the business words they learned, and a "Grown-up check" to go through together.

**Privacy: everything stays on your device, nothing is sent anywhere.** There are no accounts, no server, no analytics and no tracking. The plan is saved in the browser's own storage on this device only. The fonts and chart library are included in this folder, so the page makes no requests to other websites.

## Use it

- **Online:** <https://bitcoin-lebowski.github.io/squishy_hq/>
- **On your computer:** download or clone the folder and double-click `index.html`. It works straight from the file, with no internet connection.
- **With a tiny local server** (optional, closer to how GitHub Pages serves it):

  ```sh
  python -m http.server 8000
  ```

  Then open <http://localhost:8000/>.

To keep a plan safe, or move it to another device, use **Start again**, then **Download backup (.json)**. The welcome screen's **Load a saved plan** reads that file back in. You can also download the plan as readable text (`.md`) or print it and save it as a PDF.

## Run the tests

You need [Node.js](https://nodejs.org/) 20 or newer.

```sh
npm ci
npx playwright install chromium webkit
npm run test:smoke   # a few core tests, a few seconds
npm run test:quick   # every test on Chromium desktop, under a minute
npm test             # every test on all three browser setups
```

There are three tiers. `test:smoke` runs a handful of core tests for a fast check after a small change. `test:quick` runs the whole suite on Chromium on a desktop screen. `npm test` runs the whole suite on three browser setups: Chromium on a desktop screen, Chromium pretending to be an iPhone 13, and WebKit (the engine behind Safari) pretending to be an iPhone 13. Tests run in parallel; add `-- --workers=N` to choose how many at once (the default is 4, or fewer on a machine with fewer CPU cores). See [tests/README.md](tests/README.md) for more options.

On GitHub Actions (`.github/workflows/test.yml`), every push and pull request runs the quick suite on Chromium only. The full run on all three browser setups happens for version tags, and whenever you start it from the Actions tab with "Run workflow".

## Add a business profile

The words and suggestions for each kind of idea come from one table near the top of `index.html`, called `BUSINESS_PROFILES`. A comment above it explains every field. In short:

1. Copy an existing entry, for example the `slime` one.
2. Give it a new `id` and the `keys` (words) to look for in a child's idea. Keys match whole words and simple plurals, so `cake` also matches "cakes", but "Minecraft" never matches `craft`.
3. Fill in the `product` block (if they sell things) and the `service` block (if they offer their time). Each needs a `unit` and `unitPlural`, like `cup` and `cups`.
4. Set `food: true` for anything people eat or drink, and add a `safety` line if the idea needs one. Both appear in the Grown-up check.
5. If it should be one of the idea buttons on step 1, add it to `IDEA_TILE_EXAMPLES` too.
6. Run `npm run test:smoke` for a fast check, then `npm run test:quick`. One test walks every idea button through both kinds and fails on blank suggestions, "undefined", or awkward wording. The full three-browser run (`npm test`, about 30 minutes) is for releases.

## Project layout

```
index.html                  the whole app (HTML, CSS and JavaScript in one file)
assets/og-image.png         1200 x 630 picture used when the link is shared
vendor/chart.js-4.5.1/      Chart.js 4.5.1 (MIT licence)
vendor/fonts/               Baloo 2 and Nunito, latin subset (SIL Open Font Licence)
tests/                      Playwright test suite and its README
.github/workflows/test.yml  runs the tests on GitHub
package.json                test scripts and the two test tools (Playwright, axe-core)
package-lock.json           exact versions of those tools, used by npm ci
LICENSE                     MIT licence
.gitignore                  files git leaves out (node_modules, test output)
.gitattributes              keeps line endings consistent
.nojekyll                   tells GitHub Pages to serve the files as they are
```

## Known limitations

- **iOS downloads:** saving the backup and text files uses the browser's normal download. On very old iPhones that can't do this, the file opens in a new tab instead, with a message explaining how to save it. That fallback has **not been tested on a physical iPhone**, only in emulators.
- **One plan per browser.** Starting a new plan replaces the old one, so download a backup first. The app offers this every time.
- **Browser storage can be cleared.** Clearing site data, or some private browsing modes, removes the saved plan. Backups are the safe copy.
- **Fonts:** the included fonts cover English and Western European letters. The ₹, ฿ and ₿ currency symbols use the device's own font, so they look slightly different.
- **Sharing picture:** the `og:image` address in `index.html` is a placeholder until the GitHub Pages address is known (see the comment next to it).
- The grown-up check is a printable list, not something that is ticked and saved inside the app.

## Licences

Squish HQ is released under the MIT licence (see `LICENSE`). Chart.js is MIT licensed (`vendor/chart.js-4.5.1/LICENSE.md`). Baloo 2 and Nunito are under the SIL Open Font Licence 1.1 (`vendor/fonts/`).
