# Beatblock Multiplayer Relay

Small, in-memory HTTP room relay for Beatblock Multiplayer protocol 2. Uses Node.js built-in modules only.

## Run locally

Install Node.js 18 or newer, then from this folder run:

```sh
npm start
```

The relay binds to `0.0.0.0:8787`. Check it from another terminal with:

```sh
curl http://127.0.0.1:8787/health
```

Expected response: `{"ok":true,"protocol":2,"rooms":0}`. Run the relay checks with `npm test`.

## Public deployment (no VPN)

Players can connect directly over the internet; they do not need a VPN. Deploy this repository once to an always-on public host, then configure both clients with its URL. A VM with a public IPv4 address can run `npm start` after allowing inbound TCP port 8787. Set both mods' `config.json` `serverUrl` to `http://<public-ip>:8787`.

This is plain HTTP and does not encrypt room codes, gameplay state, names, or transferred level files. Use only on a trusted route. The Beatblock runtime currently inspected for the mod has LuaSocket but no bundled LuaSec. Render enforces HTTPS for public web services, so its public URL requires the mod's LuaSec HTTPS support and native LuaSec/OpenSSL modules to be packaged for the target game platforms. The client can attempt verified HTTPS when `ssl.https` is installed; it reports an error when the module is missing.

This repository includes `render.yaml` for creating a Render web service in Frankfurt. Render also has US regions; choose a region reasonably close to the players. Its in-memory rooms and levels disappear when the process restarts, and its free service may sleep when idle. No public relay is deployed by this repository.

For local testing, both players on one computer can use `http://127.0.0.1:8787`. On a LAN, use the relay computer's LAN address.

## Network and data notes

Plain public HTTP exposes room codes, player state, and transferred levels to network observers. Do not expose it publicly if you need confidentiality. HTTPS requires the native LuaSec runtime dependency on each client platform.

Rooms and levels are held in memory and disappear when the relay stops or a room empties. A room supports eight players and up to 32 MB of shared custom level data; one level can contain up to 199 files. Inactive players expire after 20 seconds. The relay does not save uploaded levels to disk.
