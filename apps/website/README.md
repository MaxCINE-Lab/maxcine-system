# MaxCINE Website V2

Static staging site for the MaxCINE public website redesign. This app stays on the existing HTML, CSS, and vanilla JavaScript architecture.

## Scope

- Current focus: `MaxCINE Mavic 4 Pro 增广镜`
- Product detail URL: `/products/mavic-4-pro-wide-angle/`
- Warranty page continues to call the existing Public Warranty API, slider challenge, and one-time token flow.
- V2 does not include a multi-product shop, checkout, static SN JSON lookup, Formspree forms, or mock activation.

## Local Preview

```bash
npm run build -w @maxcine/website
python3 -m http.server 5174 -d apps/website
```

Then open `http://127.0.0.1:5174/`.

## Content Layer

Future backend-controlled website content is centralized in:

- `content/site.js`
- `content/product.js`

Do not scatter reusable homepage, product, support, version, channel, or media copy across HTML files unless it is page structure.

## Reserved Video Assets

Hero video is wired but disabled until formal footage is available:

- `assets/video/hero-desktop.mp4`
- `assets/video/hero-mobile.mp4`

Sample film modal is also wired with placeholder state:

- `assets/video/sample-desktop.mp4`
- `assets/video/sample-mobile.mp4`

When final video files are added, update `content/site.js` and `content/product.js` only. Keep posters optimized for first-screen performance.

Images under `assets/optimized/` should keep AVIF and WebP variants next to the JPEG/PNG fallback. The static verifier requires those variants for the current V2 media set.

## Staging

Cloudflare Pages staging project:

- `maxcine-website-staging`
- URL: `https://maxcine-website-staging.pages.dev`

Do not deploy this app to the production website project or change `maxcine.cn` DNS from this package.
