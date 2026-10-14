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

## Connect two computers

The host computer must keep the relay running while you play. For a long-distance connection, the recommended setup is a private VPN such as Tailscale or WireGuard:

1. Install the VPN on the relay host and both players’ computers, and connect them to the same private network.
2. Start this relay on the host.
3. In each Beatblock mod’s `config.json`, set `serverUrl` to the relay host’s VPN address, for example `http://100.80.12.34:8787`.
4. Restart Beatblock on both computers, create a room on one, and join its room code on the other.

The mod config is in Beatblock’s `Mods/beatblock-multiplayer/` folder. On the computer hosting the relay, `127.0.0.1` also works for that computer’s game, but the remote friend must use the host’s VPN address.

A cloud VM can be used instead: install Node.js there, copy this `server/` directory, run `npm start`, allow inbound TCP port 8787 in its firewall, and set both clients’ `serverUrl` to `http://<vm-public-ip>:8787`.

## Network and data notes

This Beatblock runtime has LuaSocket but no LuaSec, so the mod cannot use HTTPS. Plain public HTTP exposes room codes, player state, and transferred levels to network observers. Use the VPN option for an encrypted route. Do not port-forward a home relay directly to the public internet unless you accept that limitation.

Rooms and levels are held in memory and disappear when the relay stops or a room empties. A room supports eight players and up to 32 MB of shared custom level data; one level can contain up to 199 files. Inactive players expire after 20 seconds. The relay does not save uploaded levels to disk.
