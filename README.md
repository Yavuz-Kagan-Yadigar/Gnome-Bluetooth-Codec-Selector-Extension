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

To be able to see it on extensions:

On X11, Alt+F2 to restart the shell

On Wayland session log out and log back in.

## Notes

- Codec change may briefly interrupt the connection (renegotiation).
-Only supported codecs shown.
- "Audio not routed" warning: the device is connected but PipeWire has not yet
  opened a sink. It disappears once an audio plays.
