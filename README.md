Disclaimer: this extenion is coded by AI.
Adds a Bluetooth codec selector to the GNOME Shell Quick Settings panel.

Queries connected Bluetooth audio devices via the BlueZ D-Bus API,
lists supported codecs, and allows you to change the active codec
through PipeWire/WirePlumber.

Supported codecs: **SBC · AAC · aptX · aptX HD · LDAC · LC3 · Opus**

## Requirements

| Package       | Minimum    |
|---------------|------------|
| bluez         | 5.66+      |
| pipewire      | 0.3.60+    |
| wireplumber   | 0.5+       |
| GNOME Shell   | 45–48      |

## Installation

Extract to `/home/{user}/.local/share/gnome-shell/extensions`
On X11, Alt+F2
On Wayland session: log out and log back in.

### Codec switching method

1. `wpctl set-param <node-id> Props '{ "bluez5.codec": "ldac" }'`  
   Requires WirePlumber 0.5+.

2. If unsuccessful, falls back to PipeWire D-Bus `SetParam`.

### Codec detection method

- `wpctl status` → active BT sink node ID
- `pw-cli info <node-id>` → `media.codec` property

## Notes

- Codec change may briefly interrupt the connection (renegotiation).
- If the device does not support a codec, it will not appear in the list.
- LDAC / aptX HD require the device to support them as well.
- "Audio not routed" warning: the device is connected but PipeWire has not yet
  opened a sink. It disappears once an a
