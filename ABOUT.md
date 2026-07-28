# About PocketZot

PocketZot is an unofficial [DCSS](https://crawl.develz.org) [WebTiles](https://crawl.develz.org/wordpress/howto) client designed for iOS and Android phones in portrait mode.

## DCSS on iOS and Android

DCSS has no app on the iOS App Store — but you don't need one. PocketZot is a web app: open it in Safari or Chrome, log in to a WebTiles server, and play. Use "Add to Home Screen" to install it like an app on your iPhone or Android phone. iPads and Android tablets work too.

## Features

- Custom ASCII-first design that fits the full standard console map onto a phone in
  portrait mode, with a font still large enough to read
- Tiles support
- Chat support
- Customizable controls
- Log in with multiple WebTiles server accounts and switch between them
- Inline tap targets in many menus and descriptions
- Context-aware control sets for common situations
- Spectator mode with an expanded map view
- Floating, collapsible monster list; tap for details
- Over 2.8 trillion logos
- Installs to your home screen as a PWA

## Controls

The controls are organized into three tabs: **@**, **>**, and **?**. The mental model is:

- **@** *"micro"* — moment-to-moment actions, including during battle
- **>** *"macro"* — actions often taken outside of battle, or after clearing a floor
- **?** *"info"* — commands to get information about your character or game

Obligatory virtual keyboard also available.

## Gestures

- Double tap on map to toggle zoom level
- Two-finger long press on map to toggle ASCII/tiles
- Double tap Shift to lock it
- Tap place name in HUD (e.g. @D:1) to toggle minimap
- Tap floating monster list for full view, then tap monster to inspect
- Tap chevron at top-right of monster list to collapse to single-line view

## Version support

Current stable and trunk DCSS are supported. Versions back to 0.24 generally work; older versions and forks may or may not. In particular, starting a new character on versions before 0.24 doesn't work.

## Security

PocketZot is a static web app with no backend of its own. Your browser connects directly to your chosen DCSS server over an encrypted WebSocket (`wss://`). Your account is a WebTiles account between you and that server — PocketZot has no accounts of its own. Credentials are sent only in the login message and never stored.

### "Resume as …" — what is stored

If the server issues a session cookie, it's stored in `localStorage` under a per-{server, username} key so you can reconnect without re-entering your credentials, until the token expires or is revoked. Logging out invalidates the token on both ends: the server is told to forget it, and the local entry is removed.

## How it was built

Most of the implementation was written with Claude Code, under my direction and review. All design and product decisions, testing, and QA were mine.

The source is available at <https://github.com/pocketzot/pocketzot>, licensed under [AGPL-3.0-or-later](LICENSE). See [ATTRIBUTION.md](ATTRIBUTION.md) for its relationship to DCSS.

## Feedback

Please send any comments, questions, or bug reports to <pocketzot@proton.me>. If you're enjoying the app, I'd love to hear from you.

## Support

If you like the app and want to support its development, donations are sincerely appreciated. Please see the [Support page](/support).
