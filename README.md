# PocketZot

**Dungeon Crawl Stone Soup (DCSS) in your pocket.**

**[Play now: pocketzot.app](https://pocketzot.app)**

PocketZot is an unofficial, mobile-first app for playing
[DCSS](https://crawl.develz.org) on an iPhone or Android phone. It's a
[WebTiles](https://crawl.develz.org/wordpress/howto) client. It connects to
standard DCSS servers over the same WebSocket protocol as the official client,
but replaces the rendering and UI entirely: an ASCII-first map, a custom touch
HUD, and on-screen controls designed for portrait mode.

It's also a WebTiles *server*. A full build of DCSS runs on the device itself,
so you can play local games with no network at all. And there's no App Store or
Play Store: it runs in the browser and installs to your home screen as a
Progressive Web App.

<!-- Screenshots are served from the live deployment; the image files are part
     of the hosted site, not this repository. -->
<p>
  <img src="https://pocketzot.app/shot-spriggan.png" alt="ASCII dungeon map with touch controls" height="420">
  <img src="https://pocketzot.app/shot-login.png" alt="PocketZot account picker with online accounts and an offline game" height="420">
  <img src="https://pocketzot.app/shot-shoals.png" alt="Tiles dungeon map, spectating player" height="420">
  <img src="https://pocketzot.app/shot-offline.png" alt="Offline lobby with a saved game and installed game data" height="420">
</p>

## Features

- Play online (WebTiles) or offline (local).
- ASCII-first design that fits the full standard console map onto a phone in
  portrait mode, with a font still large enough to read.
- Graphical tiles support.
- Chat support.
- Customizable controls.
- Log in with multiple WebTiles server accounts and switch between them.
- Connect to custom WebTiles servers and save their accounts normally.
- Inline tap regions in many menus and descriptions for quick touch interaction.
- Context-aware control sets for common situations.
- Spectator mode with an expanded map view.
- Floating, collapsible monster list; tap for details.
- Pinch to zoom. Alternatively, double tap and hold, then drag vertically.
- Over 2.8 trillion logos.
- Installs to your home screen as a PWA.

See [ABOUT.md](ABOUT.md) for more, including the controls model and the
security and privacy notes.

## URL routes

PocketZot keeps the selected server and current screen in the URL. Choosing a
server updates the URL before the connection attempt, which gives browser
password managers a stable server-specific page to associate with the login.
Routes use the standard WebTiles hash names, for example:

- `?server=CDI&username=alice` (selected server / login pending)
- `?server=CDI&username=alice#lobby`
- `?server=CDI&username=alice#play-dcss-0.35`
- `?server=CDI#watch-playername`
- `?offline=1#lobby`
- `?offline=1#play-charactername`

Known server acronyms and hostnames are accepted in `server`; project Pages
deployments retain their existing `/<repository>/` base path. The username is
public URL state; passwords and WebTiles login tokens are never placed in the
URL. Custom endpoints use their full, URL-encoded `ws://` or `wss://` address
as the `server` value.

## Tech

TypeScript + [Vite](https://vitejs.dev).

Want to understand or modify the code? Start with
[Learning and hacking on PocketZot](docs/HACKING.md), which includes an
architecture map, guided code tours, build/testing notes, and small exercises.

## License

[AGPL-3.0-or-later](LICENSE). Copyright © 2026 the PocketZot developer.
PocketZot is an independent project, not affiliated with or endorsed by the
DCSS development team. See [ATTRIBUTION.md](ATTRIBUTION.md) for the
relationship to DCSS.

## Feedback

Please send any comments, questions, or bug reports to <pocketzot@proton.me>.
If you're enjoying the app, I'd love to hear from you.
