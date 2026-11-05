# osc-chamsys-bridge

Control the moving heads on a ChamSys QuickQ lighting console from code running on an ordinary computer, by sending Art-Net over the local network.

## How to connect

Everything goes through **the bridge computer**, never straight to the console. Ask for its IP address: it's shown on the control page under the status line, and in the bridge's terminal when it starts.

1. **Join the venue network** with your laptop or phone. The bridge can't be reached from the internet, so your device and your code must be on the venue network.
2. **Open the control page:** `http://<bridge-ip>:8080` in a browser. Type your name under **Connected devices**, then tick lights to control them. See [Using the control page](#using-the-control-page).
3. **Control the lights from your own code** (TouchDesigner, Max, Pure Data, Python, phone apps): send OSC to `<bridge-ip>`, **UDP port 8000**. For example:
   ```
   /name "Anna"
   /light/26/dimmer 0.8
   /light/26/colour 1 0.4 0
   ```
   Replies (warnings, who has a light) come back to your computer on UDP port 9000. Code running in a web browser (p5.js, online editors) can't send OSC. See [Controlling the lights from your own code (OSC)](#controlling-the-lights-from-your-own-code-osc) for every address.

A light belongs to whoever takes it first, and is freed when they let go, close the page or stop sending for 10 seconds.

## What it does now

It has three parts:

- **A Node.js bridge** (`bridge/bridge.js`). It sends Art-Net to the console and serves a control webpage.
- **A p5.js control page** (`sketch/`). It runs in the browser and sends what its user does (take these lights, set the dimmer, solo this one) to the bridge over a WebSocket. Several people can use it at once.
- **OSC input.** Students' own code (TouchDesigner, Max, Pure Data, Python, phone apps) sends OSC to the bridge, e.g. `/light/26/dimmer 0.8`. See [Controlling the lights from your own code (OSC)](#controlling-the-lights-from-your-own-code-osc).

```
browser (p5.js page) --WebSocket--> bridge.js --Art-Net (UDP 6454)--> ChamSys QuickQ --DMX--> fixtures
student code --OSC (UDP 8000)--^
```

- **The page** has a light map, a pan/tilt pad, one section of controls per kind of light (dimmer, colour wheel, white temperature, zoom, gobos, focus, frost — only what that kind has), solo mode for finding lights, and a channel finder for setting any single channel.
- **The bridge** keeps track of who controls which light, works out the DMX values for every universe that has lights, wraps them in ArtDmx packets and sends them to the console 30 times per second.
- **The console** uses hot takeover: when it receives Art-Net on a universe that allows external control, it stops outputting its own values and passes the incoming ones to its DMX outputs.
  - When the bridge stops sending (**Release to console**, or the bridge is stopped), the console takes the universe back after a few seconds.

### Tested on the console

Tested on a ChamSys QuickQ 30 with Jet Wash 7, Jet Profile300LT, EclPar IPMFC and EclFresnel CT+M lights:

| Works | Doesn't work yet |
|---|---|
| Taking over universes 1 and 2 | |
| Dimmer | |
| Colour, with the colour wheel and white slider (see [Colour](#colour)) | |
| Several devices connected at once, each with its name | |
| Pan and tilt, including Sweep | |
| Beam (zoom) | |
| Gobos: choosing, fixed angle and spinning | |
| Focus | |
| Frost | |
| Solo mode | |
| The map's live view of brightness, colour and direction, though it's clunky to use | |

Not tested yet: OSC input and ambient on the console. The channel layouts come from the Prolights DMX charts.

## What it is intended to do

The goal is a general bridge from **OSC to Art-Net**, used by **several clients at once over a local network**:

- Any OSC-capable tool (TouchDesigner, Max, Pure Data, Python, phones, microcontrollers) sends messages like `/light/26/dimmer 0.8`.
- The bridge resolves light numbers and settings to DMX channels using the room's config file, merges input from all clients, and sends the result as Art-Net.

### Gap between now and the intended version

| | Now | Intended |
|---|---|---|
| Input protocol | JSON over WebSocket (the page), and OSC over UDP (students' code) | Same |
| Message level | Page: per-light settings, e.g. "take Wash 26". OSC: per-light, per-setting messages, e.g. `/light/26/dimmer 0.8` | Same |
| Fixture/patch knowledge | In the room's config file, read by the bridge, sent to the page and used to resolve OSC messages | Same |
| Multiple clients | A light belongs to whoever takes it first, for pages and OSC senders alike (see [Several people at once](#several-people-at-once)) | Same |
| Network | The bridge listens on all interfaces; the page shows the address and port for OSC | Same |
| Aiming at the floor | Students do the maths themselves from `/info` (positions on the map only) | Calibration data (height, facing, offsets) in `/info` too (#15) |
| Practising away from the venue | Needs the real bridge | An offline simulator with a message log (#18) |
| OSC on the console | Not tested | Tested with students' tools |

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
- **OSC:** students' code sends to this computer on UDP port 8000 (see [OSC](#controlling-the-lights-from-your-own-code-osc)). On macOS, allow incoming connections for `node` if the firewall asks.
- **Offline use:** everything the page needs, including p5.js, is in the repo (`sketch/vendor/`), so it works on a network without internet access. Only `npm install` needs internet, once.

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

The page has one section per kind of light (e.g. Jet Wash 7, Jet Profile300LT). Each section lists that kind's lights, says what that kind can do (move, colour, white range, zoom, gobos, focus, frost), and has controls for only those things. All kinds are always shown, so it's clear what each one can and can't do.

1. Tick the lights you want to control, in their section or by clicking them on the map.
2. Set that section's controls. They apply to your ticked lights of that kind only; a section's controls are greyed out until you tick one of its lights.
3. Aim with the pan/tilt pad: it moves all your ticked lights that can move.
4. Untick lights, or close the page, when finished: they go dark again.

### Colour

Every kind of light is set the same way: pick a colour on the **colour wheel** (the further from the centre, the more colour; the centre is white) and set the white's temperature with the **White** slider. Each kind makes that colour its own way:

| Kind | How it makes the colour |
|---|---|
| Jet Wash 7, EclFresnel CT+ | White from the colour-temperature channel, colour from red/green/blue, blended by the crossfade channel |
| Jet Profile300LT | Cyan, magenta and yellow filters take colour out of its white light; CTO makes the white warmer (2800–6500 K) |
| EclPar IPMFC | Mixes red, green, blue and warm white directly; its white temperature is approximate |

The map shows each light in the colour worked out from what is being sent.

**Release to console** (on the bridge computer only) hands every universe back to the console, e.g. to run a show from it. **Take back from console** returns control to the bridge.

**Warning: control is per whole universe.** While the bridge runs, every channel it doesn't set is 0, so static lights not in the config go dark.

### Ambient (between performances)

On the bridge computer, **Switch ambient on** makes the lights nobody uses do something between performances, instead of staying dark:

- **On its own**, the bridge slowly cycles every free light round the colour wheel at half brightness, each light a little further round than the next, once a minute.
- **With a music program:** a program that sends `/ambient 1` over OSC (see [OSC](#controlling-the-lights-from-your-own-code-osc)) runs the free lights instead, e.g. `/light/all/colour ...` in time with the music. The built-in cycle stops while it sends.
- **Performers always win:** ticking a light on the page, or sending OSC to it, takes it from ambient straight away. When they let go, ambient picks it up again.
- **Switch ambient off** frees ambient's lights; they go dark. The music program's light messages are then ignored until ambient is switched on again.

Every page shows whether ambient is on. Ambient is off each time the bridge starts.

### Several people at once

Anyone on the network can open the page, e.g. on a phone, at `http://<bridge-computer-ip>:8080`.

- A page that has just opened only watches. It changes nothing until its user ticks a light or clicks one on the map.
- **A light belongs to whoever takes it first.** Others see it greyed out in the list, marked on the map, with the address of the device controlling it, and can't change it.
- A light is freed when its owner unticks it or closes the page, or after **10 seconds** without hearing from that page (e.g. a phone that locks). A freed light goes dark and parks at centre.
- A page that reconnects (a phone waking up) asks for its lights again; any that someone else has taken meanwhile stay with them.
- **Blackout** only affects your own lights.
- Editing the map and **Release to console** work only on the bridge computer.

**Connected devices** lists everyone connected to the bridge, including students' code sending OSC (marked "OSC"):

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

- **Each light** shows a symbol for its model and the number from its name, placed where it doesn't cover another light, label or line. Hover over a light for its full name, console address, brightness and colour preset. A key under the map lists the symbols.
  - While the bridge controls the lights, a light that's on is filled with its colour, brighter when its dimmer is higher. A light that's off is hollow.
  - A ring of three colours means a colour preset is set; the map doesn't know which colour the preset gives.
  - An arrow from the light shows where it points, longer the further it tilts. No arrow means straight down.
  - Your lights have a blue ring, and the soloed light's ring flashes. Lights someone else is controlling have a dashed outline; hover over one to see who.
- **Clicking a light** adds or removes it from the lights the controls affect, like ticking it in the list. In solo mode, clicking a light solos it.

**Editing the map** is only possible on the bridge computer, at http://localhost:8080. Other devices see the map but can't change it. Tick **Edit map**, then:

1. **Place lights:** the first light not yet on the map flashes. Find it in the room and click where it is on the map; the next one starts flashing. Click a placed light to place it again.
2. **Rectangle** and **Line:** drag to draw the stage, walls, trusses and so on. Positions snap to 10 cm.
3. **Move:** drag lights and shapes. Click one to pick it, then turn a light with ⟲/⟳ or type its facing, or press **Delete** to remove it.
4. Set the room size in metres.

Changes are saved to the config file straight away.

**Setting a light's facing:** solo the light, and tilt it so the beam leans away from the light. Turn the light on the map until its arrow points the same way as the beam in the room. The arrow needs the model's `panDegrees` and `tiltDegrees` in the config. If it turns the wrong way when you pan, check `invertPan` and `mounting` for that light.

## Controlling the lights from your own code (OSC)

Students' own code can control the lights by sending OSC to **the bridge computer**, never to the console. The bridge turns OSC into DMX exactly as it does for the page, and the same ownership rules apply.

- **Where to send:** the bridge computer's IP address (the one students use to open the page), **UDP port 8000**. The page shows the address and port under the status line.
- **The code must run on a computer or phone on the venue network.** The bridge can't be reached from the internet, and code running in a web browser (p5.js, Gibber, online editors) can't send OSC.
- **Replies** go back to the sender's IP on **UDP port 9000**. Send `/reply 9001` to get them on another port.
- Both ports can be changed in the config: `"osc": { "port": 8000, "replyPort": 9000 }`.

### Addresses

Every light message has the same shape: `/light/<which>/<what> value(s)`. Everything is **0 to 1**, except white (kelvin). Ints and floats are both fine, values out of range are clamped, and names are not case-sensitive.

| `<which>` | Means |
|---|---|
| `26` | The light with number 26, from the end of its name ("Wash 26") |
| `wash`, `profile`, `par`, `fresnel` | Every light of that kind (each model's `group` in the config) |
| `moving` | Every light that can pan and tilt |
| `all` | Every light |
| `mine` | Every light this sender already controls |
| `{26,27}`, `2[6-9]`, `*`, `?` | OSC pattern matching on the number |

| `<what>` | Value(s) | Lights |
|---|---|---|
| `dimmer` | 0..1 | all |
| `colour` (or `color`) | r g b, each 0..1. Only the hue and amount of colour are used; brightness is the dimmer's job, so `0.5 0 0` is the same red as `1 0 0` | all that can colour |
| `hue`, `sat` | 0..1 each: colour around the wheel, and how much colour (0 = white) | all that can colour |
| `white` | kelvin, e.g. 3200 (warm) to 10000 (cool) | all that can set their white |
| `pan`, `tilt` | 0..1 each; 0.5 0.5 is centre | moving |
| `zoom` | 0..1, 0 = narrowest | wash, profile |
| `focus`, `frost` | 0..1 | profile |
| `gobo` | whole number, 0 = no gobo | profile |
| `goboangle` | 0..1 (= 0..360°), gobo stays at that angle | profile |
| `gobospin` | -1..1, 0 = stop, negative = backwards | profile |
| `release` | none: let go of the light | all |

Other addresses:

| Address | Does |
|---|---|
| `/name "Anna"` | The name shown under Connected devices and to others whose message hits your light |
| `/ping` | "Still here": keeps your lights without changing anything |
| `/release` | Let go of all your lights |
| `/info` | Asks for the room. Replies `/room width height count` (metres), then `/info/light number name kind x y facing` per light; x, y and facing are -1 for lights not on the map |
| `/ambient 1` | This sender runs the free lights between performances (see [Ambient](#ambient-between-performances)). Its lights give way to anyone who takes them, and its messages are ignored while ambient is switched off. `/ambient 0` makes it an ordinary sender again |
| `/reply 9001` | Send replies to this port instead of 9000 |

A setting a light doesn't have (e.g. `pan` to a Par) is skipped for that light. Bundles are applied together, straight away (their time tag is ignored).

### Who controls what

The same rules as the page (see [Several people at once](#several-people-at-once)):

- **The sender is its IP address.** Everything from one computer counts as one sender, whatever program or port it uses. Two students on one computer share their lights.
- **The first message to a free light takes it.** A light someone else has stays with them; the sender gets a `/taken` reply saying who has it. `/light/all/...` and the kind words take every free light that has the setting and skip busy ones.
- **Any message counts as contact. After 10 seconds without a message, the sender's lights are freed** and go dark. A script that sets a light once and then waits must send `/ping` (or anything) every few seconds.
- The bridge computer's **Free its lights** button works for OSC senders too.

### Replies

| Address | When |
|---|---|
| `/taken "text" number...` | A light you sent to belongs to someone else. Said once per light, not every frame |
| `/freed "text" number...` | You lost lights: after 10 s of silence, or freed from the bridge computer |
| `/warn "text"` | Unknown address or light, a setting a light doesn't have, missing values, or not OSC at all. Said once per problem |
| `/room`, `/info/light` | The answers to `/info` |

### Examples

Python, with [python-osc](https://pypi.org/project/python-osc/) (`pip install python-osc`):

```python
from pythonosc.udp_client import SimpleUDPClient
import math, time

bridge = SimpleUDPClient("<bridge-ip>", 8000)   # the bridge computer, not the console
bridge.send_message("/name", "Anna")
bridge.send_message("/light/26/dimmer", 0.8)
bridge.send_message("/light/26/colour", [1.0, 0.4, 0.0])   # orange

# Two lights mirrored. Sending every frame also keeps the lights.
while True:
    p = 0.5 + 0.3 * math.sin(time.time())
    bridge.send_message("/light/27/pan", p)
    bridge.send_message("/light/28/pan", 1 - p)
    time.sleep(1 / 30)
```

TouchDesigner (OSC Out CHOP), Max (`udpsend`), Pure Data (`netsend -u -b` with `oscformat`) and phone apps send to `<bridge-ip>` port 8000 in the same way; to see replies, receive OSC on port 9000.

## Room configuration

Everything about a particular room is in the config file: the console, the light models, the lights and the map. The code has no room data in it. Start from `config.example.json`. The bridge checks the file at start and stops with a list of problems if something is wrong, e.g. two lights overlapping or an address past channel 512.

Channel numbers are written as in the fixture manuals: channel 1 is the light's first channel.

### `console`

| Key | Meaning |
|---|---|
| `ip` | The console's IP address, or the subnet's broadcast address. |
| `artnetUniverseForUniverse1` | The Art-Net universe of console universe 1, usually `0`. |

### `osc`

Optional. Defaults to `{ "port": 8000, "replyPort": 9000 }`.

| Key | Meaning |
|---|---|
| `port` | UDP port the bridge listens on for OSC. |
| `replyPort` | UDP port replies are sent to, on the sender's computer. A sender can change it with `/reply`. |

### `models`

One entry per light model, keyed by a short name the lights refer to.

| Key | Meaning |
|---|---|
| `label` | Name shown on the page. |
| `group` | The kind of light as one word, e.g. `wash`, `profile`, `par`, `fresnel`. OSC messages to `/light/<group>/...` reach every light of this model (several models can share a group). Optional; not `all`, `mine` or `moving`. |
| `source` | Where the layout comes from, e.g. the manual and its revision. Not used by the code. |
| `channelCount` | Number of channels in the DMX mode used. |
| `symbol` | Symbol on the map: `circle`, `triangle`, `square` or `diamond`. Optional. |
| `panDegrees`, `tiltDegrees` | Pan and tilt range in degrees, from the spec sheet. The map draws direction arrows only for models that have both; `null` if unknown. |
| `channels` | Which channel does what: `pan`, `panFine`, `tilt`, `tiltFine`, `dimmer`, `shutter`, `zoom`, `colorMacro`, `goboWheel`, `goboRot`, `focus`, `frost`, `control`, and for colour `red`, `green`, `blue`, `white`, `cct`, `cctFine`, `crossfade` (from white to colour), `cyan`, `magenta`, `yellow`, `cto`. Leave out what the model doesn't have; the page shows only the controls a model has channels for. |
| `cctRange` | Kelvin at `cct` values 0 and 255, e.g. `[2800, 10000]`. Optional, default `[2800, 10000]`. |
| `ctoRange` | Kelvin at full CTO and at no CTO (the light's own white), e.g. `[2800, 6500]`. Optional, default `[2800, 6500]`. |
| `labels` | Names for other channels, shown under "Outgoing values". |
| `shutterOpen` | Shutter channel value that opens the shutter. |
| `zoomZeroIsWide` | `true` if zoom value 0 is the widest beam. |
| `colorMacroWhite` | Colour macro value for open white, used by solo mode. Optional, default `0`. The page doesn't use colour presets; with colour channels set, the bridge keeps the preset channel at open. |
| `gobo` | Gobo wheel values: number of `slots`, `openValue`, the first value of slot 1 in fixed (`indexFirst`) and spinning (`spinFirst`) mode, and `slotWidth`, how many values each slot spans. |
| `goboRotation` | Gobo rotation values: `indexRange` for 0° to 360°, `stop`, and `forwardRange` and `backwardRange` from slow to fast. |
| `defaults` | Values sent on channels the page doesn't drive, by channel number. |

The `control` channel triggers resets and settings changes on the light, so the page never writes to it, including from the channel finder.

Example layouts (Prolights, "Standard" mode):

| Model | Channels | Source |
|---|---|---|
| Jet Wash 7 | 23 | Jet Wash7 DMX chart |
| Jet Profile300LT | 38 | Jet Profile300LT DMX chart |
| EclPar IPMFC | 9 | EclPar IPMFC DMX chart |
| EclFresnel CT+M | 11 | EclFresnel CT+ S/M/L DMX chart |

The DMX charts are on the Prolights / Music & Lights product pages.

### `lights`

One entry per light. The console's notation `2-106` means universe 2, address 106.

| Key | Meaning |
|---|---|
| `name` | Name shown on the page. Must be unique. The number at its end (26 in "Wash 26") is the light's number for OSC, so keep those unique too; the bridge warns at start if not. |
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
- **`OSC: can't listen on UDP port 8000`:** another program uses the port. Set `osc.port` in the config to another port, and tell students.
- **OSC messages do nothing:** check that students send to the bridge computer (not the console) and to the port shown on the page, and look at the sender's line under Connected devices. Listen for `/warn` replies on port 9000. A firewall on the bridge computer may block incoming UDP.
- **`No config file at …`:** copy `config.example.json` to `config.json` in the repo root.
- **`ENETUNREACH`:** the computer has no interface on the console's subnet. Set the manual IP.
- **Nothing happens, no takeover icon on the console:** check, in order:
  - The universe number. Console "Universe 1" is usually Art-Net 0.
  - The "Allow other consoles…" setting.
  - The subnet.
  - The macOS Local Network permission.
- **Only the dimmer works; movement, gobos and focus don't:** another console or controller on the network may still have control of the console's universes, for example one that runs the touch panels. On the test console, setting that device to release control to the console fixed it. To check whether the bridge reaches the lights at all, tick one light, leave the dimmer at 0 and turn on **Sweep**: only that light should move.
- **Sweep makes a different light flicker:** the bridge is sending to the wrong universe. Check `console.artnetUniverseForUniverse1` against the Art-Net numbers in the console's DMX settings.
- **The packet counter climbs but the console doesn't react:** the counter only shows that packets left the computer, not that the console received them.
- **A head moves but stays dark:** the shutter channel is closed. The page opens it automatically for selected heads.
