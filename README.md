# YM Cafe

Node.js + Express + Socket.io ordering app for Sylhet City: Home Delivery (Sylhet City only) or Self Pickup.

## Run (VS Code terminal, Node 18 or newer)
1. `npm install`
2. `npm start`  (PowerShell: `npm.cmd start`)
3. Storefront: http://localhost:3000  |  Admin: http://localhost:3000/admin

**Admin password:** there is no default. On the first run the terminal prints a random one.
To choose your own, start with `ADMIN_PASSWORD=yourpass` (PowerShell: `$env:ADMIN_PASSWORD="yourpass"; npm.cmd start`) before the first run.
Change it later in Settings. After 5 wrong tries a login is blocked for 15 minutes.

## What customers do
Pick food, then choose Home Delivery or Self Pickup, enter name and phone, and:
- Delivery: area (Sylhet City list only), city, road/house, building, notes. Any outside-Sylhet address is refused with
  "Sorry! YM Cafe currently delivers only within Sylhet City." Minimum delivery order BDT 300.
- Pickup: choose a time slot; no delivery fee, no minimum.
They get a tracking code and a live status timeline.

All rules are enforced in `server.js` (prices, areas, minimum, pickup hours), not just in the page.

## Admin panel
Live kanban (shows Delivery/Pickup, name, phone tap-to-call, address), riders, menu + photos, delivery areas and fees,
and "Delivery and pickup settings": delivery on/off, pickup on/off, pickup hours, café address and phone. CSV export.

## Order alerts on your phone (optional)
Set any of these before `npm start`; the terminal shows `Order alerts: ...` for what is on.
- Telegram: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`
- WhatsApp (CallMeBot, free): `CALLMEBOT_PHONE` (e.g. +8801XXXXXXXXX), `CALLMEBOT_APIKEY`
- WhatsApp (Meta Cloud API): `WA_TOKEN`, `WA_PHONE_ID`, `WA_TO`, `WA_TEMPLATE` (approved template with one body variable)

## Hosting notes
Set `TRUST_PROXY=1` behind a proxy (Render, Railway). Orders live in `data.json`: use a host with a persistent disk,
or move to a database, because free plans erase files on restart.

## Files
`server.js` (API), `menu.json` (starting menu), `public/index.html`, `public/admin.html`, `public/Latte_1.glb` (3D coffee model, shown with "Switch burger / coffee").
Photos you upload go to `public/images/uploads`.
