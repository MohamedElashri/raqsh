# Raqsh landing page

Build and preview with Nida 0.8.5 or newer from the repository root.

```sh
nida check site
nida build site
nida serve site --base-url http://127.0.0.1:1702/
```

The static output is in `site/public/`. For a deploy under a subdirectory, pass the full URL with `nida build site --base-url URL`.

The screenshots show `static/examples/raqsh-release-board.raqsh` open in the native macOS app during a live Codex pairing. The cropped images highlight the queued feedback and the acknowledged task update. Each links to the full app screenshot. Open the example with **Import board** in Raqsh.

## GitHub Pages

The **Publish website** workflow deploys changes to `site/` from `main` and supports manual runs from the same branch. It verifies the pinned Nida release and uploads `site/public/` to GitHub Pages. The production URL in `config.toml` sets the canonical links and sitemap for `https://melashri.net/raqsh/`.
