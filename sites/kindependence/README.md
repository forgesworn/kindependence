# Kindependence — one-page marketing site

Static page in the style of the Kindred site. No build step, no external
requests. The site is `public/`. Live at https://kindependence.app.

## Preview

    python3 -m http.server -d sites/kindependence/public 8000

then open http://localhost:8000. Check it at 375px wide (no horizontal scroll)
and at desktop width.

## Deploy

Served by Cloudflare as a Worker with static assets (`kindependence-site`,
config in `wrangler.jsonc`), on the custom domains `kindependence.app` and
`www.kindependence.app`. Cloudflare manages the DNS records and TLS.

A push to `main` that touches `sites/kindependence/` deploys it automatically
(`.github/workflows/deploy-site.yml`), then checks that kindependence.app is serving
the new files. The workflow can also be run by hand from the Actions tab. To
deploy from a local checkout instead:

    cd sites/kindependence && npx wrangler deploy
