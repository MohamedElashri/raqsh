# Raqsh landing page

Build and preview with Nida 0.8.5 or newer from the repository root.

```sh
sh site/build.sh --base-url http://127.0.0.1:1702/
python3 -m http.server 1702 --directory site/public
```

The static output is in `site/public/`. The build copies the repository’s installer into that directory. Use `sh site/build.sh` for the production URL configured in `config.toml`.

The screenshots show `static/examples/raqsh-release-board.raqsh` open in the native macOS app during a live Codex pairing. The cropped images highlight queued feedback and the acknowledged task update. Each links to the full app screenshot. Open the example with **Import board** in Raqsh.

The hero serves 800px and 1600px WebP sizes alongside the full capture. If the capture changes, regenerate each size from `site/static/images/feedback-acknowledged-full.webp` with `cwebp -q 87 -m 6 -resize WIDTH 0 -metadata none INPUT -o OUTPUT`. Update the image dimensions in the homepage template and the Open Graph dimensions in `templates/partials/seo.html` if the full capture changes size.

## GitHub Pages

The **Publish website** workflow deploys changes to `site/` from `main` and supports manual runs from the same branch. It verifies the pinned Nida release and uploads `site/public/` to GitHub Pages. The production URL in `config.toml` sets the canonical links and sitemap for `https://melashri.net/raqsh/`.

## Commercial pricing

The pricing section uses the amount in `data/downloads.toml`. It shows
“Coming to Ko-fi” until both `commercial_product` and `commercial_terms`
contain the live product and approved versioned terms URLs. Keep the
`#licensing` section ID for links from the desktop app.

## Linux downloads

The website installer defaults to a user install and checks release assets against `SHA256SUMS`. Set `linux_archive` in `data/downloads.toml` to `raqsh-linux-x86_64.tar.gz` once the latest public release includes that file. The download page links to the current DEB, RPM and macOS ZIP while the archive link is pending.
