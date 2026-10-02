# Kindependence — one-page marketing site

Static page in the style of the Kindred site. No build step, no external
requests. The site is `public/`. Live at https://kindependence.app.

## Preview

    python3 -m http.server -d sites/kindependence/public 8000

then open http://localhost:8000. Check it at 375px wide (no horizontal scroll)
and at desktop width.

## Deploy

Served by Caddy on the Hetzner VPS (95.216.164.146) from
`/var/www/kindependence`; TLS is automatic. To publish changes:

    rsync -az --delete sites/kindependence/public/ root@95.216.164.146:/var/www/kindependence/
