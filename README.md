# Red Feather RTS

A browser-based, multiplayer medieval 3D real-time strategy prototype. Built with Three.js, Express, and WebSockets, with a Render Blueprint included.

## Play locally

Requirements: Node.js 20+

```bash
npm install
npm start
```

Open http://localhost:3000 in a browser. Open another browser or device to join the same realm code and test multiplayer.

## Deploy to Render

1. Push this repository to GitHub.
2. In Render, choose **New → Blueprint** and select this repository.
3. Render reads `render.yaml`, installs dependencies, and starts `npm start`.
4. Open the deployed service URL. Share a realm code with friends.

The `/health` endpoint is available for service health checks. Render Web Services support WebSockets.

## Current prototype features

- 3D island battlefield with forests, rocks, grassland, and a coastal harbor area.
- Orbit, pan/move, and zoom camera controls.
- Build houses, farms, barracks, watchtowers, and docks.
- Recruit soldiers, archers, knights, pikemen, siege carts, and ships.
- Gold, wood, food, and stone economy with passive income and farm/house bonuses.
- Shared multiplayer rooms, player kingdom colors, synchronized buildings/units, and realm chat.
- Right-click (or tap on touchscreens) your units and a destination to issue a move order.
- Server-authoritative unit movement, automatic nearby combat, unit health, and defensive tower attacks.
- Tactical terrain: forests favor archers and protect defenders, hills improve ranged attacks, marsh slows knights, and roads speed movement.
- Unit counters: pikemen are strong against knights, knights pressure archers, and archers are effective against siege units.
- Strategic landmarks: hold three neutral map objectives with nearby troops to earn control score and a small income bonus.
- Army supply limits tied to houses, plus ongoing food upkeep so farms and logistics matter more than simply stockpiling gold.
- Terrain legend, landmark markers, and control score display in the Kingdom panel.

## Controls

- Drag: orbit camera.
- Scroll: zoom.
- Bottom **Move camera**: switch to pan mode.
- Bottom **Rotate**: toggle camera rotation.
- Right-click one of your units, then right-click a destination to move it.
- Use the Kingdom panel to construct buildings and recruit units.

## Multiplayer and production notes

This is an early playable RTS prototype, not yet a complete competitive RTS. The current server keeps room state in memory, so a server restart clears matches and multiple server instances will not share state. For a larger public launch, add persistent storage (for example Redis/PostgreSQL), server-side movement/combat simulation, reconnect handling, rate limits, room capacity limits, and automated tests. Keep the authoritative game state on the server.

## Fair monetization roadmap

For a Roblox-style business model, prefer optional cosmetic purchases: kingdom banners, unit outfits, ship sails, building themes, emotes, and supporter nameplates. Keep core units, strategy, and competitive power earnable through play; avoid loot boxes, paid random rewards, and pay-to-win upgrades. No payment processor or real-money purchase flow is configured in this starter.

## Tech

- Three.js (loaded from jsDelivr)
- Express static hosting
- ws WebSocket multiplayer
- Render Blueprint (`render.yaml`)
