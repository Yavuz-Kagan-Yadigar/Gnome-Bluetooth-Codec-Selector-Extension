/**
 * bt-codec-selector@local  –  v7.1
 *
 * Codec switching method (proven to work):
 *   pw-cli set-param <device_id> Props '{ "bluetoothAudioCodec": <N> }'
 *
 *   This sends a direct codec switch command to PipeWire's spa-bluez5 plugin.
 *   No WirePlumber restart, no Disconnect/Connect, no config file needed.
 *   Codec switch happens in ~1-2 seconds, with a brief audio dropout.
 *
 * Enum values (Spa:Enum:BluetoothAudioCodec, according to string order):
 *   sbc=1, sbc_xq=2, mpeg=3, aac=4, aac_eld=5, aptx=6, aptx_hd=7,
 *   ldac=8, aptx_ll=9, aptx_ll_duplex=10, faststream=11, faststream_duplex=12,
 *   lc3plus_hr=13, opus_05=14, ..., cvsd=20, msbc=21, lc3_swb=22,
 *   lc3_a127=23, lc3=24, g722=25
 *
 * Codec list: BlueZ sep objects (Codec byte + Capabilities vendor decode)
 * Active codec:   pw-dump → api.bluez5.codec
 * Device ID:      pw-dump → media.class == Audio/Device + api.bluez5.address
 */

import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as QuickSettings from 'resource:///org/gnome/shell/ui/quickSettings.js';
import {SystemIndicator} from 'resource:///org/gnome/shell/ui/quickSettings.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BLUEZ_BUS          = 'org.bluez';
const BLUEZ_PATH         = '/';
const BLUEZ_IFACE_DEVICE = 'org.bluez.Device1';
const BLUEZ_IFACE_MPOINT = 'org.bluez.MediaEndpoint1';
const DBUS_OBJMGR        = 'org.freedesktop.DBus.ObjectManager';

const UUID_A2DP_SINK   = '0000110b-0000-1000-8000-00805f9b34fb';
const UUID_A2DP_SOURCE = '0000110a-0000-1000-8000-00805f9b34fb';

const A2DP_CODEC_SBC    = 0x00;
const A2DP_CODEC_MPEG12 = 0x01;
const A2DP_CODEC_AAC    = 0x02;
const A2DP_CODEC_VENDOR = 0xFF;

const VENDOR_CODEC_MAP = [
    [0x0000012D, 0x00AA, 'ldac'],
    [0x0000004F, 0x0001, 'aptx'],
    [0x000000D0, 0x0024, 'aptx_hd'],
    [0x000000D0, 0x0001, 'aptx_ll'],
    [0x000000D0, 0x0002, 'aptx_twsp'],
    [0x0000003A, 0x0001, 'lc3plus_hr'],
    [0x000005F1, 0x0001, 'opus_05'],
    [0x0000000A, 0x0001, 'faststream'],
    [0x00000075, 0x0001, 'samsung_scalable'],
];

/**
 * Spa:Enum:BluetoothAudioCodec enum values.
 * Starting from 1 according to string order.
 */
const CODEC_ENUM = {
    'sbc':              1,
    'sbc_xq':           2,
    'mpeg':             3,
    'aac':              4,
    'aac_eld':          5,
    'aptx':             6,
    'aptx_hd':          7,
    'ldac':             8,
    'aptx_ll':          9,
    'aptx_ll_duplex':   10,
    'faststream':       11,
    'faststream_duplex':12,
    'lc3plus_hr':       13,
    'opus_05':          14,
    'opus_05_51':       15,
    'opus_05_71':       16,
    'opus_05_duplex':   17,
    'opus_05_pro':      18,
    'opus_g':           19,
    'cvsd':             20,
    'msbc':             21,
    'lc3_swb':          22,
    'lc3_a127':         23,
    'lc3':              24,
    'g722':             25,
};

const CODEC_LABELS = {
    'sbc':         'SBC',
    'sbc_xq':      'SBC-XQ',
    'aac':         'AAC',
    'aptx':        'aptX',
    'aptx_hd':     'aptX HD',
    'aptx_ll':     'aptX LL',
    'ldac':        'LDAC',
    'lc3':         'LC3',
    'lc3plus_hr':  'LC3plus',
    'opus_05':     'Opus',
    'faststream':  'FastStream',
    'mpeg':        'MP3',
    'msbc':        'mSBC',
};

// ---------------------------------------------------------------------------
// PipeWire helpers
// ---------------------------------------------------------------------------

function spawnSync(argv) {
    try {
        const [ok, out] = GLib.spawn_sync(
            null, argv, null, GLib.SpawnFlags.SEARCH_PATH, null
        );
        return ok ? new TextDecoder().decode(out) : null;
    } catch (_) { return null; }
}

function pwDump() {
    try {
        const out = spawnSync(['pw-dump']);
        return out ? JSON.parse(out) : [];
    } catch (_) { return []; }
}

/**
 * Returns the PipeWire Audio/Device node ID and active codec for a given MAC address.
 * Returns: { deviceId, sinkId, activeCodec } or null
 */
function pwFindDevice(macAddress) {
    const nodes   = pwDump();
    const mac     = macAddress.toUpperCase();
    let deviceId  = null;
    let sinkId    = null;
    let activeCodec = null;

    for (const n of nodes) {
        const p  = n.info?.props ?? {};
        if ((p['api.bluez5.address'] ?? '').toUpperCase() !== mac) continue;

        const mc = p['media.class'] ?? '';
        if (mc === 'Audio/Device') {
            deviceId = String(n.id);
        } else if (mc.includes('Audio/Sink') && !p['api.bluez5.internal']) {
            sinkId = String(n.id);
            activeCodec = (p['api.bluez5.codec'] ?? '').toLowerCase() || null;
        } else if (mc.includes('Audio/Sink') && !activeCodec) {
            activeCodec = (p['api.bluez5.codec'] ?? '').toLowerCase() || null;
        }
    }

    if (!deviceId) return null;
    return { deviceId, sinkId, activeCodec };
}

/**
 * Changes the bluetoothAudioCodec using pw-cli set-param.
 * Returns: { ok, reason }
 */
function pwSetCodec(deviceId, codecName) {
    const enumVal = CODEC_ENUM[codecName];
    if (enumVal === undefined) {
        return { ok: false, reason: `Unknown codec: ${codecName}` };
    }

    const props = `{ "bluetoothAudioCodec": ${enumVal} }`;
    const out = spawnSync(['pw-cli', 'set-param', deviceId, 'Props', props]);

    if (out === null) {
        return { ok: false, reason: 'pw-cli failed' };
    }

    log(`[bt-codec-selector] set bluetoothAudioCodec=${enumVal} (${codecName}) on device ${deviceId}`);
    return { ok: true };
}

// ---------------------------------------------------------------------------
// BlueZ helpers
// ---------------------------------------------------------------------------

async function bluezGetManagedObjects() {
    const reply = await new Promise((resolve, reject) => {
        Gio.DBus.system.call(
            BLUEZ_BUS, BLUEZ_PATH, DBUS_OBJMGR,
            'GetManagedObjects', null, null,
            Gio.DBusCallFlags.NONE, 4000, null,
            (conn, res) => {
                try { resolve(conn.call_finish(res)); }
                catch (e) { reject(e); }
            }
        );
    });
    const [dict] = reply.recursiveUnpack();
    return dict;
}

function decodeVendorCodec(caps) {
    if (!caps || caps.length < 6) return null;
    const vid = caps[0] | (caps[1] << 8) | (caps[2] << 16) | (caps[3] << 24);
    const cid = caps[4] | (caps[5] << 8);
    for (const [v, c, name] of VENDOR_CODEC_MAP)
        if (v === vid && c === cid) return name;
    return null;
}

function sepToCodecName(ep) {
    const b = ep['Codec'], caps = ep['Capabilities'];
    if (b === A2DP_CODEC_SBC)    return 'sbc';
    if (b === A2DP_CODEC_AAC)    return 'aac';
    if (b === A2DP_CODEC_MPEG12) return 'mpeg';
    if (b === A2DP_CODEC_VENDOR) return decodeVendorCodec(caps);
    return null;
}

function getDeviceSupportedCodecs(devicePath, allObjects) {
    const codecs = [];
    for (const [path, ifaces] of Object.entries(allObjects)) {
        if (!path.startsWith(devicePath + '/sep')) continue;
        const ep = ifaces[BLUEZ_IFACE_MPOINT];
        if (!ep) continue;
        const uuid = (ep['UUID'] ?? '').toLowerCase();
        if (uuid !== UUID_A2DP_SINK && uuid !== UUID_A2DP_SOURCE) continue;
        const name = sepToCodecName(ep);
        if (name && !codecs.includes(name)) codecs.push(name);
    }
    // SBC is always supported; also add sbc_xq (PipeWire feature)
    if (!codecs.includes('sbc')) codecs.unshift('sbc');
    if (codecs.includes('sbc') && !codecs.includes('sbc_xq'))
        codecs.splice(codecs.indexOf('sbc') + 1, 0, 'sbc_xq');
    return codecs;
}

// ---------------------------------------------------------------------------
// Quick Settings tile
// ---------------------------------------------------------------------------

const BtCodecMenuToggle = GObject.registerClass(
class BtCodecMenuToggle extends QuickSettings.QuickMenuToggle {
    _init(ext) {
        super._init({
            title: 'BT Codec',
            iconName: 'audio-headphones-symbolic',
            toggleMode: false,
        });
        this._ext        = ext;
        this._rowWidgets = [];
        this._busy       = false;

        this.menu.setHeader('audio-headphones-symbolic', 'Bluetooth Codec Selector');

        this._noDevLabel = new St.Label({
            text: 'No connected Bluetooth audio device',
            style: 'padding:8px 16px;color:rgba(255,255,255,0.4);font-size:0.85em;',
        });
        this.menu.box.add_child(this._noDevLabel);

        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 4,
            () => { if (!this._busy) this._refresh(); return GLib.SOURCE_CONTINUE; });
        this._refresh();
    }

    async _refresh() {
        try {
            const all     = await bluezGetManagedObjects();
            const devices = this._findAudioDevices(all);
            this._updateMenu(devices);
        } catch (e) { log(`[bt-codec-selector] refresh: ${e.message}`); }
    }

    _findAudioDevices(allObjects) {
        return Object.entries(allObjects)
            .filter(([, ifaces]) => {
                const dev = ifaces[BLUEZ_IFACE_DEVICE];
                if (!dev?.Connected) return false;
                const uuids = (dev.UUIDs ?? []).map(u => u.toLowerCase());
                return uuids.includes(UUID_A2DP_SINK) || uuids.includes(UUID_A2DP_SOURCE);
            })
            .map(([path, ifaces]) => {
                const dev   = ifaces[BLUEZ_IFACE_DEVICE];
                const mac   = dev.Address.toUpperCase();
                const pwDev = pwFindDevice(mac);
                return {
                    path,
                    name:            dev.Name ?? dev.Address,
                    address:         mac,
                    supportedCodecs: getDeviceSupportedCodecs(path, allObjects),
                    activeCodec:     pwDev?.activeCodec ?? null,
                    deviceId:        pwDev?.deviceId ?? null,
                };
            });
    }

    _updateMenu(devices) {
        for (const w of this._rowWidgets) w.destroy();
        this._rowWidgets = [];
        const box = this.menu.box;

        if (devices.length === 0) {
            this._noDevLabel.show();
            this.subtitle = 'No device';
            return;
        }
        this._noDevLabel.hide();
        devices.forEach(d => this._addDeviceSection(box, d));

        const first = devices[0];
        const shown = first.activeCodec;
        this.subtitle = shown ? (CODEC_LABELS[shown] ?? shown.toUpperCase()) : first.name;
    }

    _addDeviceSection(box, { name, deviceId, supportedCodecs, activeCodec }) {
        const header = new St.Label({
            text: name, x_expand: true,
            style: 'padding:8px 16px 2px;font-weight:bold;font-size:0.88em;',
        });
        box.add_child(header);
        this._rowWidgets.push(header);

        if (!deviceId) {
            // PipeWire device not yet available
            const info = new St.Label({
                text: '⏸  Codec selection will be available when audio starts playing',
                x_expand: true,
                style: 'padding:2px 16px 8px;font-size:0.78em;color:rgba(255,255,255,0.4);',
            });
            box.add_child(info);
            this._rowWidgets.push(info);
            this._addSep(box);
            return;
        }

        const row = new St.BoxLayout({
            vertical: false, x_expand: true,
            style: 'padding:4px 16px 2px;',
        });
        box.add_child(row);
        this._rowWidgets.push(row);

        const buttons = [];
        for (const key of supportedCodecs) {
            // Skip codecs not in CODEC_ENUM (cannot be switched)
            if (CODEC_ENUM[key] === undefined) continue;

            const lbl      = CODEC_LABELS[key] ?? key.toUpperCase();
            // Only exact match shows as active (SBC / SBC‑XQ distinction corrected)
            const isActive = key === activeCodec;

            const btn = new St.Button({
                label: lbl,
                y_align: Clutter.ActorAlign.CENTER,
                style_class: isActive ? 'button suggested-action' : 'button flat',
                style: 'margin:2px 3px 2px 0; padding:3px 11px; border-radius:10px; font-size:0.82em;',
            });

            btn.connect('clicked', () => {
                if (this._busy) return;
                this._switchCodec({ name, deviceId, key, lbl, buttons, btn });
            });

            row.add_child(btn);
            buttons.push(btn);
        }

        // Active codec label
        if (activeCodec) {
            const activeLbl = new St.Label({
                text: `active: ${CODEC_LABELS[activeCodec] ?? activeCodec.toUpperCase()}`,
                y_align: Clutter.ActorAlign.CENTER,
                style: 'font-size:0.75em;color:rgba(255,255,255,0.4);margin-left:8px;',
            });
            row.add_child(activeLbl);
        }

        this._addSep(box);
    }

    _switchCodec({ name, deviceId, key, lbl, buttons, btn }) {
        this._busy = true;

        // Optimistic UI update
        buttons.forEach(b => {
            b.style_class = 'button flat';
            b.style = 'margin:2px 3px 2px 0; padding:3px 11px; border-radius:10px; font-size:0.82em;';
        });
        btn.style_class = 'button suggested-action';
        btn.label = `${lbl} …`;

        const res = pwSetCodec(deviceId, key);

        btn.label = lbl;

        if (res.ok) {
            Main.notify('BT Codec', `${name}: ${lbl}`);
            // Refresh actual status after 2.5 seconds
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2500, () => {
                this._busy = false;
                this._refresh();
                return GLib.SOURCE_REMOVE;
            });
        } else {
            Main.notify('BT Codec — Error', `Could not set ${lbl}: ${res.reason}`);
            this._busy = false;
            this._refresh();
        }
    }

    _addSep(box) {
        const sep = new St.Widget({
            x_expand: true,
            style: 'height:1px;background:rgba(255,255,255,0.1);margin:0 16px;',
        });
        box.add_child(sep);
        this._rowWidgets.push(sep);
    }

    destroy() {
        if (this._timer) { GLib.source_remove(this._timer); this._timer = null; }
        for (const w of this._rowWidgets) w.destroy();
        super.destroy();
    }
});

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default class BtCodecSelectorExtension extends Extension {
    enable() {
        this._indicator = new SystemIndicator();
        this._toggle    = new BtCodecMenuToggle(this);
        this._indicator.quickSettingsItems.push(this._toggle);
        Main.panel.statusArea.quickSettings.addExternalIndicator(this._indicator);
        log('[bt-codec-selector] enabled');
    }
    disable() {
        this._toggle?.destroy();    this._toggle    = null;
        this._indicator?.destroy(); this._indicator = null;
        log('[bt-codec-selector] disabled');
    }
}