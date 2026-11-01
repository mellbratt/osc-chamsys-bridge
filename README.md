# osc-chamsys-bridge

Control the moving heads on a ChamSys QuickQ lighting console from code running on an ordinary computer, by sending Art-Net over the local network.

## What it does now

This first version has two parts:

- **A Node.js bridge** (`bridge/bridge.js`). It sends Art-Net to the console and serves a control webpage.
- **A p5.js control page** (`sketch/`). It runs in the browser and sends what its user does (take these lights, set the dimmer, solo this one) to the bridge over a WebSocket. Several people can use it at once.

```
browser (p5.js page) --WebSocket--> bridge.js --Art-Net (UDP 6454)--> ChamSys QuickQ --DMX--> fixtures
```

- **The page** has a light map, a pan/tilt pad, dimmer, zoom, colour macro, gobo/rotation/focus/frost, solo mode for finding lights, and a channel finder for setting any single channel.
- **The bridge** keeps track of who controls which light, works out the DMX values for every universe that has lights, wraps them in ArtDmx packets and sends them to the console 30 times per second.
- **The console** uses hot takeover: when it receives Art-Net on a universe that allows external control, it stops outputting its own values and passes the incoming ones to its DMX outputs.
  - When the bridge stops sending (**Release to console**, or the bridge is stopped), the console takes the universe back after a few seconds.

Tested against the console: Art-Net takeover of universe 1. Not yet tested against the console: the Jet Wash 7 and Profile300LT channel layouts in `config.example.json`, which are taken from the Prolights user manuals.

## What it is intended to do

The goal is a general bridge from **OSC to Art-Net**, used by **several clients at once over a local network**:

- Any OSC-capable tool (p5.js via a WebSocket relay, TouchDesigner, Max, Pure Data, phones, microcontrollers) sends messages like `/fixture/26/dimmer 0.8`.
- The bridge resolves fixture names and attributes to DMX channels using a fixture/patch definition, merges input from all clients, and sends the result as Art-Net.

### Gap between now and the intended version

| | Now | Intended |
|---|---|---|
| Input protocol | JSON messages over WebSocket | OSC over UDP (plus a WebSocket path for browsers) |
| Message level | Per-light settings, e.g. "take Wash 26", "dimmer 200 for my lights" | Per-fixture, per-attribute messages |
| Fixture/patch knowledge | In the room's config file, read by the bridge and sent to the page | Same, and used by the bridge to resolve OSC messages |
| Multiple clients | A light belongs to whoever takes it first (see [Several people at once](#several-people-at-once)) | Same rules for OSC senders |
| Network | The bridge listens on all interfaces, so other devices on the LAN can open the page | Same, with documented OSC port |

## Requirements

- Node.js (tested with v22).
- A ChamSys QuickQ (developed for a QuickQ 30) on the same wired network as the computer.

## Setup

```bash
cp config.example.json config.json   # then edit config.json for your room
cd bridge
npm install
node bridge.js
```

Then open http://localhost:8080.

- **Config file:** the bridge reads `config.json` in the repo root. To use another file: `node bridge.js path/to/room.json`. `config.json` is not checked in, so each room keeps its own. See [Room configuration](#room-configuration).
- **Universe mapping:** `console.artnetUniverseForUniverse1` is the Art-Net universe that console universe 1 maps to, usually `0`. Console universe 2 is then sent as the next Art-Net universe.
- **Broadcast:** if the console's IP is unknown, set `console.ip` to the subnet's broadcast address, e.g. `10.255.255.255`.
- **Offline use:** the page loads p5.js from a CDN. Open it once while online, or download `p5.min.js` into `sketch/` and change the script tag in `index.html`.

## Console and network setup

1. **Network:** connect the computer to the console's network port by cable.
   - Give the computer a manual IP on the console's subnet (console `10.0.0.10` → computer e.g. `10.0.0.50`, same subnet mask).
   - Turn Wi-Fi off to avoid routing conflicts. The console's own Wi-Fi does not carry DMX.
2. **Console IP:** find it under Main menu → Settings → Network → Wired.
3. **Universe settings:** under Settings → DMX, for each universe the bridge should control:
   - Set "Send Over Network" to Art-Net and note the Art-Net universe number.
   - Switch on "Allow other consoles to control this universe" (named "Hot Takeover" in some software versions).
4. **macOS:** allow Terminal under System Settings → Privacy & Security → Local Network.

## Using the control page

While the bridge runs, it controls every console universe that has lights in the config. Lights nobody is controlling are dark and parked at centre.

1. Tick the lights you want to control, in the list or by clicking them on the map.
2. Raise the dimmer and set the other controls. They apply to all your ticked lights.
3. Untick lights, or close the page, when finished: they go dark again.

**Release to console** (on the bridge computer only) hands every universe back to the console, e.g. to run a show from it. **Take back from console** returns control to the bridge.

**Warning: control is per whole universe.** While the bridge runs, every channel it doesn't set is 0, so static lights not in the config go dark.

### Several people at once

Anyone on the network can open the page, e.g. on a phone, at `http://<bridge-computer-ip>:8080`.

- A page that has just opened only watches. It changes nothing until its user ticks a light or clicks one on the map.
- **A light belongs to whoever takes it first.** Others see it greyed out in the list, marked on the map, with the address of the device controlling it, and can't change it.
- A light is freed when its owner unticks it or closes the page, or after **10 seconds** without hearing from that page (e.g. a phone that locks). A freed light goes dark and parks at centre.
- A page that reconnects (a phone waking up) asks for its lights again; any that someone else has taken meanwhile stay with them.
- **Blackout** only affects your own lights.
- Editing the map and **Release to console** work only on the bridge computer.

**Connected devices** lists everyone connected to the bridge:

- **Name:** type one in **Your name**; the browser remembers it. Without one, the list shows the device's network name if the bridge can find it (e.g. `annas-macbook.local`), else its IP address. The IP address is always shown. The same name marks lights that device controls.
- Which lights each device controls.
- What it last sent, as a short summary with how long ago, e.g. "set dimmer 200 on 3 lights, 2 s ago". Click the summary for the exact message.
- On the bridge computer, **Free its lights** frees all of a device's lights (they go dark) without disconnecting it; its page says so.

### Finding a light in the room (solo mode)

1. Tick **Solo one light** under "Solo". Your first ticked light (or the first free light) starts flashing white about twice a second, and your other lights go dark. Other people's lights are left alone.
2. Click a light's name in the list, or press ↑ and ↓, to solo another one. Lights someone else is controlling are skipped. The page shows the soloed light's name and console address, e.g. "Wash 26, 1-061".
3. Aim it with the pan/tilt pad to see where it points.
4. Untick **Solo** (or press **Blackout**) to go back to the lights you had ticked.

### The light map

The map at the top of the page shows the room from above, with every light that has been placed on it.

- **Each light** shows its name, console address and a symbol for its model.
  - While the bridge controls the lights, each light glows in its current brightness and colour, and an arrow shows where it points.
  - Your lights are ringed, and the soloed light's ring flashes. Lights someone else is controlling have a dashed outline; hover over one to see who.
- **Clicking a light** adds or removes it from the lights the controls affect, like ticking it in the list. In solo mode, clicking a light solos it.

**Editing the map** is only possible on the bridge computer, at http://localhost:8080. Other devices see the map but can't change it. Tick **Edit map**, then:

1. **Place lights:** the first light not yet on the map flashes. Find it in the room and click where it is on the map; the next one starts flashing. Click a placed light to place it again.
2. **Rectangle** and **Line:** drag to draw the stage, walls, trusses and so on. Positions snap to 10 cm.
3. **Move:** drag lights and shapes. Click one to pick it, then turn a light with ⟲/⟳ or type its facing, or press **Delete** to remove it.
4. Set the room size in metres.

Changes are saved to the config file straight away.

**Setting a light's facing:** solo the light, and tilt it so the beam leans away from the light. Turn the light on the map until its arrow points the same way as the beam in the room. The arrow needs the model's `panDegrees` and `tiltDegrees` in the config. If it turns the wrong way when you pan, check `invertPan` and `mounting` for that light.

## Room configuration

Everything about a particular room is in the config file: the console, the light models, the lights and the map. The code has no room data in it. Start from `config.example.json`. The bridge checks the file at start and stops with a list of problems if something is wrong, e.g. two lights overlapping or an address past channel 512.

Channel numbers are written as in the fixture manuals: channel 1 is the light's first channel.

### `console`

| Key | Meaning |
|---|---|
| `ip` | The console's IP address, or the subnet's broadcast address. |
| `artnetUniverseForUniverse1` | The Art-Net universe of console universe 1, usually `0`. |

### `models`

One entry per light model, keyed by a short name the lights refer to.

| Key | Meaning |
|---|---|
| `label` | Name shown on the page. |
| `source` | Where the layout comes from, e.g. the manual and its revision. Not used by the code. |
| `channelCount` | Number of channels in the DMX mode used. |
| `symbol` | Symbol on the map: `circle`, `triangle`, `square` or `diamond`. Optional. |
| `panDegrees`, `tiltDegrees` | Pan and tilt range in degrees, from the spec sheet. The map draws direction arrows only for models that have both; `null` if unknown. |
| `channels` | Which channel does what: `pan`, `panFine`, `tilt`, `tiltFine`, `dimmer`, `shutter`, `zoom`, `colorMacro`, `goboWheel`, `goboRot`, `focus`, `frost`, `control`, and `red`, `green`, `blue`, `white` for the map's colour. Leave out what the model doesn't have. |
| `labels` | Names for other channels, shown under "Outgoing values". |
| `shutterOpen` | Shutter channel value that opens the shutter. |
| `zoomZeroIsWide` | `true` if zoom value 0 is the widest beam. |
| `colorMacroWhite` | Colour macro value for open white, used by solo mode. Optional, default `0`. |
| `gobo` | Gobo wheel values: number of `slots`, `openValue`, the first value of slot 1 in fixed (`indexFirst`) and spinning (`spinFirst`) mode, and `slotWidth`, how many values each slot spans. |
| `goboRotation` | Gobo rotation values: `indexRange` for 0° to 360°, `stop`, and `forwardRange` and `backwardRange` from slow to fast. |
| `defaults` | Values sent on channels the page doesn't drive, by channel number. |

The `control` channel triggers resets and settings changes on the light, so the page never writes to it, including from the channel finder.

Example layouts (Prolights, "Standard" mode):

| Model | Channels | Source |
|---|---|---|
| Jet Wash 7 | 23 | Jet Wash7 user manual, rev. 04/22 |
| Jet Profile300LT | 38 | Jet Profile300LT user manual, rev. 25/Nov/25 |

**Profile300LT channel count:** some Prolights spec pages list 37 channels for Standard mode. Check the light's channel count on the console before relying on the layout.

### `lights`

One entry per moving light. The console's notation `2-106` means universe 2, address 106.

| Key | Meaning |
|---|---|
| `name` | Name shown on the page. Must be unique. |
| `model` | Key of an entry in `models`. |
| `universe`, `address` | Console universe and start address. |
| `invertPan` | `true` if Pan Invert is ticked for the light on the console. |
| `mounting` | `"hanging"` or `"standing"`. Used for the map's direction arrow. |

Static lights (e.g. pars and fresnels) have no entry and stay dark on any universe the page has taken over.

### `map`

The light map, edited from the page (see [The light map](#the-light-map)); there's no need to edit it by hand. Sizes and positions are in metres, x to the right and y down the map.

| Key | Meaning |
|---|---|
| `width`, `height` | Room size. Default 20 × 12. |
| `shapes` | Rectangles `{ "type": "rect", "x", "y", "w", "h" }` and lines `{ "type": "line", "x1", "y1", "x2", "y2" }`. |
| `lights` | Position of each light by name: `{ "x", "y", "facing" }`, facing in degrees clockwise from the top of the map. |

When the map is saved, the bridge rewrites the config file. It keeps everything else in the file, including changes made by hand while it runs, but lays the file out in its own format.

## Troubleshooting

- **`Cannot find module 'ws'`:** run `npm install` in `bridge/`.
- **`No config file at …`:** copy `config.example.json` to `config.json` in the repo root.
- **`ENETUNREACH`:** the computer has no interface on the console's subnet. Set the manual IP.
- **Nothing happens, no takeover icon on the console:** check, in order:
  - The universe number. Console "Universe 1" is usually Art-Net 0.
  - The "Allow other consoles…" setting.
  - The subnet.
  - The macOS Local Network permission.
- **The packet counter climbs but the console doesn't react:** the counter only shows that packets left the computer, not that the console received them.
- **A head moves but stays dark:** the shutter channel is closed. The page opens it automatically for selected heads.
