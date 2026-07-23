# PocketZot

**Dungeon Crawl Stone Soup (DCSS) WebTiles in your pocket.**

**[Play now: pocketzot.app](https://pocketzot.app)**

PocketZot is an unofficial, mobile-first [WebTiles](https://crawl.develz.org/wordpress/howto)
client for [DCSS](https://crawl.develz.org) — play Dungeon Crawl Stone Soup on your
iPhone or Android phone. It connects to standard DCSS WebTiles servers
and speaks the same WebSocket protocol as the official client, but replaces the rendering
and UI entirely with an ASCII-first map, a custom touch HUD, and on-screen
controls designed for a phone in portrait mode. There's no App Store or Play
Store install: it runs in the browser (iOS Safari, Android Chrome, or desktop)
and installs to the home screen as a Progressive Web App.

<!-- Screenshots are served from the live deployment; the image files are part
     of the hosted site, not this repository. -->
<p>
  <img src="https://pocketzot.app/shot-spriggan.png" alt="ASCII dungeon map with touch controls" height="420">
  <img src="https://pocketzot.app/shot-monsters.png" alt="Full-screen monster description" height="420">
  <img src="https://pocketzot.app/shot-shoals.png" alt="Tiles dungeon map, spectating player" height="420">
  <img src="https://pocketzot.app/shot-login.png" alt="PocketZot account picker" height="420">
</p>

## Features

- ASCII-first design that fits the full standard console map onto a phone in
  portrait mode, with a font still large enough to read.
- Graphical tiles are also supported.
- Chat support.
- Customizable controls.
- Log in with multiple WebTiles server accounts and switch between them.
- Inline tap regions in many menus and descriptions for quick touch interaction.
- Context-aware control sets for common situations.
- Spectator mode with an expanded map view.
- Floating, collapsible monster list; tap for details.
- Map double-tap toggles zoom; two-finger long-press toggles tiles.
- Over 2.8 trillion logos.
- Installs to your home screen as a PWA.

See [ABOUT.md](ABOUT.md) for more, including the controls model and security
details (credential handling, session cookies).

## Tech

TypeScript + [Vite](https://vitejs.dev), no UI framework. The client
holds no game logic, and gameplay runs entirely on DCSS servers.

## License

[AGPL-3.0-or-later](LICENSE). Copyright © 2026 the PocketZot developer.
PocketZot is an independent project, not affiliated with or endorsed by the
DCSS development team. See [ATTRIBUTION.md](ATTRIBUTION.md) for the
relationship to DCSS and third-party provenance.

## Feedback

Please send any comments, questions, or bug reports to <pocketzot@proton.me>.
If you're enjoying the app, I'd love to hear from you.
