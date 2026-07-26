/**
 * LuxShift Smart Bulb Integration
 *
 * Supports major smart bulb protocols:
 * - Philips Hue (local LAN API via bridge)
 * - LIFX (LAN protocol + cloud fallback)
 * - Yeelight (LAN protocol)
 * - Matter/Thread (via Matter controller)
 *
 * Integrates with wind-down engine: bulb color temperature follows
 * the same non-linear intensity curve as Night Shift (easeInQuad).
 */

const { execFile } = require('child_process');
const { promisify } = require('util');
const dgram = require('dgram');
const fs = require('fs');
const path = require('path');

const execFileAsync = promisify(execFile);

// ============================================================
// Base Controller Class
// ============================================================

class BulbController {
  constructor(config = {}) {
    this.config = config;
    this.bulbs = new Map(); // id -> bulb info
    this.isConnected = false;
    this.discoveryInProgress = false;
  }

  // Abstract methods to implement
  async discover() { throw new Error('Not implemented'); }
  async connect(bulbId) { throw new Error('Not implemented'); }
  async disconnect(bulbId) { throw new Error('Not implemented'); }
  async setColorTemperature(bulbId, kelvin, brightness = 1.0, transitionMs = 1000) { throw new Error('Not implemented'); }
  async setRGB(bulbId, r, g, b, brightness = 1.0, transitionMs = 1000) { throw new Error('Not implemented'); }
  async setBrightness(bulbId, brightness, transitionMs = 1000) { throw new Error('Not implemented'); }
  async turnOn(bulbId, transitionMs = 500) { throw new Error('Not implemented'); }
  async turnOff(bulbId, transitionMs = 500) { throw new Error('Not implemented'); }
  async getState(bulbId) { throw new Error('Not implemented'); }

  // Common helpers
  async sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // Convert wind-down intensity (0-1) to color temperature
  // intensity 0 = 6500K (cool daylight)
  // intensity 1 = 1800K (warm amber/candlelight)
  static intensityToKelvin(intensity) {
    const clamped = Math.max(0, Math.min(1, intensity));
    // Non-linear curve matching Night Shift's easeInQuad
    const progress = clamped * clamped;
    // 6500K -> 1800K range
    return Math.round(6500 - progress * 4700);
  }

  // Convert wind-down intensity to brightness
  // intensity 0 = 100% brightness
  // intensity 1 = 30% brightness (matches MIN_BRIGHTNESS in main.js)
  static intensityToBrightness(intensity) {
    const clamped = Math.max(0, Math.min(1, intensity));
    // Brightness dims more gently — only starts dropping past 50% intensity
    const brightnessIntensity = Math.max(0, (clamped - 0.5) * 2);
    return 1.0 - (brightnessIntensity * 0.7); // 1.0 -> 0.3
  }

  // Apply wind-down state to all connected bulbs
  async applyWindDownState(intensity, transitionMs = 2000) {
    const kelvin = BulbController.intensityToKelvin(intensity);
    const brightness = BulbController.intensityToBrightness(intensity);

    const promises = [];
    for (const [bulbId, bulb] of this.bulbs) {
      if (bulb.connected) {
        promises.push(this.setColorTemperature(bulbId, kelvin, brightness, transitionMs));
      }
    }
    await Promise.allSettled(promises);
    return { kelvin, brightness, appliedTo: promises.length };
  }

  // Restore bulbs to normal (cool/bright)
  async restoreNormal(transitionMs = 3000) {
    const promises = [];
    for (const [bulbId, bulb] of this.bulbs) {
      if (bulb.connected) {
        promises.push(this.setColorTemperature(bulbId, 6500, 1.0, transitionMs));
      }
    }
    await Promise.allSettled(promises);
  }
}

// ============================================================
// Philips Hue Controller (Local LAN API)
// ============================================================

class HueController extends BulbController {
  constructor(config = {}) {
    super(config);
    this.bridgeIp = config.bridgeIp || null;
    this.username = config.username || null; // App key from bridge
    this.baseUrl = null;
  }

  async discover() {
    this.discoveryInProgress = true;
    const foundBulbs = [];

    try {
      // Method 1: UPnP/SSDP discovery (meethue.com/nupnp)
      const nupnpUrl = 'https://discovery.meethue.com/';
      const response = await fetch(nupnpUrl);
      if (response.ok) {
        const bridges = await response.json();
        for (const bridge of bridges) {
          if (bridge.internalipaddress) {
            await this._tryConnectBridge(bridge.internalipaddress, foundBulbs);
          }
        }
      }
    } catch (e) {
      console.warn('[Hue] Discovery failed:', e.message);
    }

    // Method 2: Local mDNS scan (fallback)
    if (foundBulbs.length === 0) {
      await this._mdnsDiscovery(foundBulbs);
    }

    this.discoveryInProgress = false;
    return foundBulbs;
  }

  async _tryConnectBridge(ip, foundBulbs) {
    try {
      // Check if we have stored credentials for this bridge
      const stored = this.config.bridges?.[ip];
      if (stored?.username) {
        this.bridgeIp = ip;
        this.username = stored.username;
        this.baseUrl = `http://${ip}/api/${this.username}`;
        const bulbs = await this._fetchBulbs();
        foundBulbs.push(...bulbs);
        this.isConnected = true;
        return;
      }

      // Try default username or create new one
      // For first-time setup, user needs to press bridge button
      this.bridgeIp = ip;
      this.baseUrl = `http://${ip}/api`;

      // Try to create user (requires link button press)
      try {
        const createResp = await fetch(this.baseUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ devicetype: 'luxshift#mac' })
        });
        const data = await createResp.json();
        if (data[0]?.success?.username) {
          this.username = data[0].success.username;
          this.baseUrl = `http://${ip}/api/${this.username}`;
          this.config.bridges = this.config.bridges || {};
          this.config.bridges[ip] = { username: this.username };
          const bulbs = await this._fetchBulbs();
          foundBulbs.push(...bulbs);
          this.isConnected = true;
        }
      } catch (e) {
        // Bridge button not pressed - user needs to press it
        console.log('[Hue] Bridge found at', ip, '- press link button to pair');
      }
    } catch (e) {
      console.warn('[Hue] Bridge connection failed:', e.message);
    }
  }

  async _mdnsDiscovery(foundBulbs) {
    // Scan local network for Hue bridges via mDNS
    // This is a simplified version - in production use bonjour/hap-nodejs
    return new Promise((resolve) => {
      const socket = dgram.createSocket('udp4');
      const found = new Set();

      socket.on('message', (msg) => {
        try {
          const text = msg.toString();
          if (text.includes('hue') || text.includes('philips')) {
            // Parse mDNS response for IP
            const ipMatch = text.match(/(\d+\.\d+\.\d+\.\d+)/);
            if (ipMatch && !found.has(ipMatch[1])) {
              found.add(ipMatch[1]);
              this._tryConnectBridge(ipMatch[1], foundBulbs);
            }
          }
        } catch (_) {}
      });

      socket.bind(5353, () => {
        socket.addMembership('224.0.0.251');
        // Send mDNS query for _hue._tcp.local
        const query = Buffer.from([
          0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00,
          0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
          0x04, '_h', 0x75, 0x65, 0x04, '_t', 0x63, 0x70,
          0x05, 'l', 0x6f, 0x63, 0x61, 0x6c, 0x00,
          0x00, 0x0c, 0x00, 0x01
        ]);
        socket.send(query, 0, query.length, 5353, '224.0.0.251');
      });

      setTimeout(() => {
        socket.close();
        resolve();
      }, 3000);
    });
  }

  async _fetchBulbs() {
    if (!this.baseUrl) return [];
    try {
      const resp = await fetch(`${this.baseUrl}/lights`);
      const data = await resp.json();
      const bulbs = [];
      for (const [id, info] of Object.entries(data)) {
        if (info.type === 'Extended color light' || info.type === 'Color light' || info.type === 'Dimmable light') {
          bulbs.push({
            id: `hue-${id}`,
            name: info.name,
            type: 'hue',
            model: info.modelid,
            manufacturer: 'Philips',
            supportsColor: info.type !== 'Dimmable light',
            supportsCT: true,
            connected: info.state?.reachable === true,
            state: {
              on: info.state?.on,
              brightness: info.state?.bri ? info.state.bri / 254 : 1,
              ct: info.state?.ct ? 1000000 / info.state.ct : null, // mired to kelvin
              hue: info.state?.hue,
              sat: info.state?.sat
            },
            bridgeIp: this.bridgeIp,
            lightId: id
          });
        }
      }
      // Cache bulbs
      for (const bulb of bulbs) {
        this.bulbs.set(bulb.id, bulb);
      }
      return bulbs;
    } catch (e) {
      console.warn('[Hue] Fetch bulbs failed:', e.message);
      return [];
    }
  }

  async connect(bulbId) {
    const bulb = this.bulbs.get(bulbId);
    if (!bulb) return { ok: false, error: 'Bulb not found' };

    // Re-fetch to verify connectivity
    const bulbs = await this._fetchBulbs();
    const updated = bulbs.find(b => b.id === bulbId);
    if (updated) {
      this.bulbs.set(bulbId, { ...bulb, ...updated, connected: true });
      return { ok: true };
    }
    return { ok: false, error: 'Bulb unreachable' };
  }

  async disconnect(bulbId) {
    const bulb = this.bulbs.get(bulbId);
    if (bulb) {
      bulb.connected = false;
      this.bulbs.set(bulbId, bulb);
    }
    return { ok: true };
  }

  async setColorTemperature(bulbId, kelvin, brightness = 1.0, transitionMs = 1000) {
    const bulb = this.bulbs.get(bulbId);
    if (!bulb || !bulb.supportsCT) return { ok: false, error: 'Bulb does not support color temperature' };

    const mired = Math.round(1000000 / kelvin);
    const bri = Math.round(brightness * 254);
    const transitionTime = Math.round(transitionMs / 100); // Hue uses 100ms units

    try {
      const resp = await fetch(`${this.baseUrl}/lights/${bulb.lightId}/state`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ct: mired,
          bri: bri,
          transitiontime: transitionTime,
          on: true
        })
      });
      const data = await resp.json();
      if (data[0]?.success) {
        bulb.state.ct = kelvin;
        bulb.state.brightness = brightness;
        this.bulbs.set(bulbId, bulb);
        return { ok: true };
      }
      return { ok: false, error: JSON.stringify(data) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  async setRGB(bulbId, r, g, b, brightness = 1.0, transitionMs = 1000) {
    const bulb = this.bulbs.get(bulbId);
    if (!bulb || !bulb.supportsColor) return { ok: false, error: 'Bulb does not support color' };

    // Convert RGB to xy (Hue uses CIE xy)
    const [x, y] = this._rgbToXy(r, g, b);
    const bri = Math.round(brightness * 254);
    const transitionTime = Math.round(transitionMs / 100);

    try {
      const resp = await fetch(`${this.baseUrl}/lights/${bulb.lightId}/state`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          xy: [x, y],
          bri: bri,
          transitiontime: transitionTime,
          on: true
        })
      });
      const data = await resp.json();
      return { ok: data[0]?.success ?? false };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  async setBrightness(bulbId, brightness, transitionMs = 1000) {
    const bulb = this.bulbs.get(bulbId);
    if (!bulb) return { ok: false, error: 'Bulb not found' };

    const bri = Math.round(brightness * 254);
    const transitionTime = Math.round(transitionMs / 100);

    try {
      const resp = await fetch(`${this.baseUrl}/lights/${bulb.lightId}/state`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          bri: bri,
          transitiontime: transitionTime
        })
      });
      const data = await resp.json();
      if (data[0]?.success) {
        bulb.state.brightness = brightness;
        this.bulbs.set(bulbId, bulb);
        return { ok: true };
      }
      return { ok: false, error: JSON.stringify(data) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  async turnOn(bulbId, transitionMs = 500) {
    const bulb = this.bulbs.get(bulbId);
    if (!bulb) return { ok: false, error: 'Bulb not found' };

    try {
      const resp = await fetch(`${this.baseUrl}/lights/${bulb.lightId}/state`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ on: true, transitiontime: Math.round(transitionMs / 100) })
      });
      const data = await resp.json();
      if (data[0]?.success) {
        bulb.state.on = true;
        this.bulbs.set(bulbId, bulb);
        return { ok: true };
      }
      return { ok: false, error: JSON.stringify(data) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  async turnOff(bulbId, transitionMs = 500) {
    const bulb = this.bulbs.get(bulbId);
    if (!bulb) return { ok: false, error: 'Bulb not found' };

    try {
      const resp = await fetch(`${this.baseUrl}/lights/${bulb.lightId}/state`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ on: false, transitiontime: Math.round(transitionMs / 100) })
      });
      const data = await resp.json();
      if (data[0]?.success) {
        bulb.state.on = false;
        this.bulbs.set(bulbId, bulb);
        return { ok: true };
      }
      return { ok: false, error: JSON.stringify(data) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  async getState(bulbId) {
    const bulb = this.bulbs.get(bulbId);
    if (!bulb) return { ok: false, error: 'Bulb not found' };

    try {
      const resp = await fetch(`${this.baseUrl}/lights/${bulb.lightId}`);
      const data = await resp.json();
      return { ok: true, state: data.state };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  _rgbToXy(r, g, b) {
    // sRGB to CIE XYZ to xy
    r /= 255; g /= 255; b /= 255;
    const toLinear = c => c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    r = toLinear(r); g = toLinear(g); b = toLinear(b);

    const X = r * 0.664511 + g * 0.154324 + b * 0.162028;
    const Y = r * 0.283881 + g * 0.668433 + b * 0.047685;
    const Z = r * 0.000088 + g * 0.072310 + b * 0.986039;

    const sum = X + Y + Z;
    return sum === 0 ? [0.3127, 0.3290] : [X / sum, Y / sum];
  }
}

// ============================================================
// LIFX Controller (LAN Protocol)
// ============================================================

class LifxController extends BulbController {
  constructor(config = {}) {
    super(config);
    this.socket = null;
    this.sourceId = Math.floor(Math.random() * 0x100000000);
    this.sequence = 0;
    this.pendingRequests = new Map();
    this.discoveredBulbs = new Map();
  }

  async discover() {
    this.discoveryInProgress = true;
    const foundBulbs = [];

    return new Promise((resolve) => {
      this.socket = dgram.createSocket('udp4');

      this.socket.on('message', (msg, rinfo) => {
        this._handleMessage(msg, rinfo);
      });

      this.socket.on('error', (err) => {
        console.warn('[LIFX] Socket error:', err.message);
      });

      this.socket.bind(0, () => {
        this.socket.setBroadcast(true);
        // Send GetService (type 2) to discover bulbs
        const packet = this._buildPacket(2, Buffer.alloc(0));
        this.socket.send(packet, 0, packet.length, 56700, '255.255.255.255');

        // Also send GetLabel (type 23) to get names
        setTimeout(() => {
          for (const [, bulb] of this.discoveredBulbs) {
            const getLabel = this._buildPacket(23, Buffer.alloc(0), bulb.target);
            this.socket.send(getLabel, 0, getLabel.length, 56700, bulb.address);
          }
        }, 500);
      });

      setTimeout(() => {
        this.socket.close();
        this.discoveryInProgress = false;
        for (const [, bulb] of this.discoveredBulbs) {
          foundBulbs.push(bulb);
          this.bulbs.set(bulb.id, bulb);
        }
        this.isConnected = foundBulbs.length > 0;
        resolve(foundBulbs);
      }, 3000);
    });
  }

  _buildPacket(type, payload, target = Buffer.alloc(8)) {
    const header = Buffer.alloc(36);
    header.writeUInt16LE(0x0100, 0); // frame + protocol
    header.writeUInt16LE(payload.length + 32, 2); // size
    header.writeUInt32LE(this.sourceId, 4);
    target.copy(header, 8);
    header.writeUInt8(0, 24); // res_required
    header.writeUInt8(0, 25); // ack_required
    header.writeUInt8(this.sequence++ % 256, 26);
    header.writeUInt8(0, 27);
    header.writeUInt16LE(type, 32);
    header.writeUInt16LE(0, 34); // reserved
    return Buffer.concat([header, payload]);
  }

  _handleMessage(msg, rinfo) {
    if (msg.length < 36) return;
    const type = msg.readUInt16LE(32);

    if (type === 3) { // StateService
      const port = msg.readUInt16LE(36);
      const service = msg.readUInt8(38);
      if (service === 1) { // UDP service
        const target = msg.slice(8, 16);
        const mac = target.toString('hex').match(/.{2}/g).join(':');
        const id = `lifx-${mac}`;

        if (!this.discoveredBulbs.has(id)) {
          this.discoveredBulbs.set(id, {
            id,
            name: 'LIFX Bulb',
            type: 'lifx',
            manufacturer: 'LIFX',
            supportsColor: true,
            supportsCT: true,
            connected: true,
            address: rinfo.address,
            port,
            target,
            state: { on: true, brightness: 1, kelvin: 3500 }
          });
        }
      }
    } else if (type === 25) { // StateLabel
      const label = msg.slice(36, 36 + 32).toString('utf8').replace(/\0/g, '');
      const target = msg.slice(8, 16);
      const mac = target.toString('hex').match(/.{2}/g).join(':');
      const id = `lifx-${mac}`;

      if (this.discoveredBulbs.has(id)) {
        const bulb = this.discoveredBulbs.get(id);
        bulb.name = label || bulb.name;
        this.discoveredBulbs.set(id, bulb);
      }
    } else if (type === 107) { // StateLight
      const target = msg.slice(8, 16);
      const mac = target.toString('hex').match(/.{2}/g).join(':');
      const id = `lifx-${mac}`;

      if (this.discoveredBulbs.has(id)) {
        const bulb = this.discoveredBulbs.get(id);
        const hue = msg.readUInt16LE(36);
        const saturation = msg.readUInt16LE(38);
        const brightness = msg.readUInt16LE(40) / 65535;
        const kelvin = msg.readUInt16LE(42);
        const power = msg.readUInt16LE(44);

        bulb.state = {
          on: power > 0,
          brightness,
          kelvin,
          hue,
          saturation
        };
        this.discoveredBulbs.set(id, bulb);
      }
    }
  }

  async _sendCommand(bulbId, type, payload, expectResponse = true) {
    const bulb = this.bulbs.get(bulbId);
    if (!bulb) return { ok: false, error: 'Bulb not found' };

    return new Promise((resolve) => {
      const seq = this.sequence++ % 256;
      const packet = this._buildPacket(type, payload, bulb.target);

      if (expectResponse) {
        const timeout = setTimeout(() => {
          this.pendingRequests.delete(seq);
          resolve({ ok: false, error: 'Timeout' });
        }, 3000);

        this.pendingRequests.set(seq, { resolve, timeout, bulbId });
      }

      this.socket.send(packet, 0, packet.length, bulb.port || 56700, bulb.address, (err) => {
        if (err && expectResponse) {
          clearTimeout(this.pendingRequests.get(seq)?.timeout);
          this.pendingRequests.delete(seq);
          resolve({ ok: false, error: err.message });
        } else if (!expectResponse) {
          resolve({ ok: true });
        }
      });
    });
  }

  async connect(bulbId) {
    const bulb = this.bulbs.get(bulbId);
    if (!bulb) return { ok: false, error: 'Bulb not found' };

    // Get current state
    const resp = await this._sendCommand(bulbId, 101, Buffer.alloc(0)); // GetLight
    if (resp.ok) {
      bulb.connected = true;
      this.bulbs.set(bulbId, bulb);
      return { ok: true };
    }
    return { ok: false, error: 'Failed to connect' };
  }

  async disconnect(bulbId) {
    const bulb = this.bulbs.get(bulbId);
    if (bulb) {
      bulb.connected = false;
      this.bulbs.set(bulbId, bulb);
    }
    return { ok: true };
  }

  async setColorTemperature(bulbId, kelvin, brightness = 1.0, transitionMs = 1000) {
    const bulb = this.bulbs.get(bulbId);
    if (!bulb) return { ok: false, error: 'Bulb not found' };

    // LIFX SetColor (type 102): hue(2), saturation(2), brightness(2), kelvin(2), duration(4)
    const payload = Buffer.alloc(12);
    payload.writeUInt16LE(0, 0); // hue (ignored for CT)
    payload.writeUInt16LE(0, 2); // saturation (ignored for CT)
    payload.writeUInt16LE(Math.round(brightness * 65535), 4);
    payload.writeUInt16LE(Math.round(kelvin), 6);
    payload.writeUInt32LE(transitionMs, 8);

    return this._sendCommand(bulbId, 102, payload);
  }

  async setRGB(bulbId, r, g, b, brightness = 1.0, transitionMs = 1000) {
    // Convert RGB to HSV
    const [h, s] = this._rgbToHsv(r, g, b);
    const payload = Buffer.alloc(12);
    payload.writeUInt16LE(Math.round(h * 65535), 0);
    payload.writeUInt16LE(Math.round(s * 65535), 2);
    payload.writeUInt16LE(Math.round(brightness * 65535), 4);
    payload.writeUInt16LE(3500, 6); // kelvin (ignored when saturation > 0)
    payload.writeUInt32LE(transitionMs, 8);

    return this._sendCommand(bulbId, 102, payload);
  }

  async setBrightness(bulbId, brightness, transitionMs = 1000) {
    const bulb = this.bulbs.get(bulbId);
    if (!bulb) return { ok: false, error: 'Bulb not found' };

    const payload = Buffer.alloc(8);
    payload.writeUInt16LE(Math.round(brightness * 65535), 0);
    payload.writeUInt32LE(transitionMs, 4);

    return this._sendCommand(bulbId, 117, payload); // SetWaveform with brightness only
  }

  async turnOn(bulbId, transitionMs = 500) {
    const payload = Buffer.alloc(2);
    payload.writeUInt16LE(65535, 0); // power on
    return this._sendCommand(bulbId, 117, payload); // SetWaveform
  }

  async turnOff(bulbId, transitionMs = 500) {
    const payload = Buffer.alloc(2);
    payload.writeUInt16LE(0, 0); // power off
    return this._sendCommand(bulbId, 117, payload);
  }

  async getState(bulbId) {
    return this._sendCommand(bulbId, 101, Buffer.alloc(0));
  }

  _rgbToHsv(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const delta = max - min;

    let h = 0;
    if (delta !== 0) {
      if (max === r) h = ((g - b) / delta) % 6;
      else if (max === g) h = (b - r) / delta + 2;
      else h = (r - g) / delta + 4;
      h *= 60;
      if (h < 0) h += 360;
    }
    const s = max === 0 ? 0 : delta / max;
    return [h, s];
  }
}

// ============================================================
// Yeelight Controller (LAN Protocol)
// ============================================================

class YeelightController extends BulbController {
  constructor(config = {}) {
    super(config);
    this.socket = null;
    this.discoveredBulbs = new Map();
    this.messageId = 1;
  }

  async discover() {
    this.discoveryInProgress = true;
    const foundBulbs = [];

    return new Promise((resolve) => {
      this.socket = dgram.createSocket('udp4');

      this.socket.on('message', (msg, rinfo) => {
        try {
          const text = msg.toString();
          if (text.includes('yeelink') || text.includes('yeelight')) {
            // Parse HTTP-like response
            const lines = text.split('\r\n');
            const headers = {};
            for (const line of lines) {
              const idx = line.indexOf(':');
              if (idx > 0) {
                headers[line.substring(0, idx).toLowerCase()] = line.substring(idx + 1).trim();
              }
            }

            const location = headers['location'] || '';
            const ipMatch = location.match(/(\d+\.\d+\.\d+\.\d+):(\d+)/);
            if (ipMatch) {
              const id = `yeelight-${headers['id'] || ipMatch[1]}`;
              if (!this.discoveredBulbs.has(id)) {
                const bulb = {
                  id,
                  name: headers['model'] || 'Yeelight',
                  type: 'yeelight',
                  manufacturer: 'Yeelight',
                  model: headers['model'],
                  supportsColor: headers['support']?.includes('color') || false,
                  supportsCT: headers['support']?.includes('ct') || false,
                  connected: true,
                  address: ipMatch[1],
                  port: parseInt(ipMatch[2], 10) || 55443,
                  state: { on: true, brightness: 1, kelvin: 4000 }
                };
                this.discoveredBulbs.set(id, bulb);
              }
            }
          }
        } catch (e) {
          console.warn('[Yeelight] Parse error:', e.message);
        }
      });

      this.socket.bind(0, () => {
        this.socket.setBroadcast(true);
        // SSDP M-SEARCH for Yeelight
        const search = [
          'M-SEARCH * HTTP/1.1',
          'HOST: 239.255.255.250:1982',
          'MAN: "ssdp:discover"',
          'ST: wifi_bulb',
          'MX: 2',
          '', ''
        ].join('\r\n');

        this.socket.send(search, 0, search.length, 1982, '239.255.255.250');

        setTimeout(() => {
          this.socket.close();
          this.discoveryInProgress = false;
          for (const [, bulb] of this.discoveredBulbs) {
            foundBulbs.push(bulb);
            this.bulbs.set(bulb.id, bulb);
          }
          this.isConnected = foundBulbs.length > 0;
          resolve(foundBulbs);
        }, 3000);
      });
    });
  }

  _sendCommand(bulbId, method, params = []) {
    const bulb = this.bulbs.get(bulbId);
    if (!bulb) return Promise.resolve({ ok: false, error: 'Bulb not found' });

    return new Promise((resolve) => {
      const id = this.messageId++;
      const msg = JSON.stringify({ id, method, params }) + '\r\n';
      const buffer = Buffer.from(msg);

      const client = dgram.createSocket('udp4');
      const timeout = setTimeout(() => {
        client.close();
        resolve({ ok: false, error: 'Timeout' });
      }, 3000);

      client.on('message', (response) => {
        clearTimeout(timeout);
        client.close();
        try {
          const result = JSON.parse(response.toString());
          resolve({ ok: !result.error, result: result.result, error: result.error?.message });
        } catch (e) {
          resolve({ ok: false, error: 'Invalid response' });
        }
      });

      client.on('error', (err) => {
        clearTimeout(timeout);
        client.close();
        resolve({ ok: false, error: err.message });
      });

      client.send(buffer, 0, buffer.length, bulb.port, bulb.address);
    });
  }

  async connect(bulbId) {
    const resp = await this._sendCommand(bulbId, 'get_prop', ['power', 'bright', 'ct', 'rgb', 'hue', 'sat']);
    if (resp.ok && resp.result) {
      const [power, bright, ct, rgb, hue, sat] = resp.result;
      const bulb = this.bulbs.get(bulbId);
      if (bulb) {
        bulb.state = {
          on: power === 'on',
          brightness: parseInt(bright) / 100,
          kelvin: parseInt(ct) || 4000,
          rgb: parseInt(rgb),
          hue: parseInt(hue),
          sat: parseInt(sat)
        };
        bulb.connected = true;
        this.bulbs.set(bulbId, bulb);
        return { ok: true };
      }
    }
    return { ok: false, error: 'Failed to connect' };
  }

  async disconnect(bulbId) {
    const bulb = this.bulbs.get(bulbId);
    if (bulb) {
      bulb.connected = false;
      this.bulbs.set(bulbId, bulb);
    }
    return { ok: true };
  }

  async setColorTemperature(bulbId, kelvin, brightness = 1.0, transitionMs = 1000) {
    const clampedKelvin = Math.max(1700, Math.min(6500, kelvin));
    const bright = Math.round(brightness * 100);
    const duration = Math.round(transitionMs);

    // Turn on first if off
    const bulb = this.bulbs.get(bulbId);
    if (bulb && !bulb.state.on) {
      await this._sendCommand(bulbId, 'set_power', ['on', 'smooth', duration]);
    }

    // Set CT and brightness
    await this._sendCommand(bulbId, 'set_ct_abx', [clampedKelvin, 'smooth', duration]);
    await this._sendCommand(bulbId, 'set_bright', [bright, 'smooth', duration]);

    if (bulb) {
      bulb.state.kelvin = clampedKelvin;
      bulb.state.brightness = brightness;
      this.bulbs.set(bulbId, bulb);
    }
    return { ok: true };
  }

  async setRGB(bulbId, r, g, b, brightness = 1.0, transitionMs = 1000) {
    const rgb = (r << 16) | (g << 8) | b;
    const bright = Math.round(brightness * 100);
    const duration = Math.round(transitionMs);

    const bulb = this.bulbs.get(bulbId);
    if (bulb && !bulb.state.on) {
      await this._sendCommand(bulbId, 'set_power', ['on', 'smooth', duration]);
    }

    await this._sendCommand(bulbId, 'set_rgb', [rgb, 'smooth', duration]);
    await this._sendCommand(bulbId, 'set_bright', [bright, 'smooth', duration]);

    if (bulb) {
      bulb.state.rgb = rgb;
      bulb.state.brightness = brightness;
      this.bulbs.set(bulbId, bulb);
    }
    return { ok: true };
  }

  async setBrightness(bulbId, brightness, transitionMs = 1000) {
    const bright = Math.round(brightness * 100);
    const duration = Math.round(transitionMs);
    await this._sendCommand(bulbId, 'set_bright', [bright, 'smooth', duration]);

    const bulb = this.bulbs.get(bulbId);
    if (bulb) {
      bulb.state.brightness = brightness;
      this.bulbs.set(bulbId, bulb);
    }
    return { ok: true };
  }

  async turnOn(bulbId, transitionMs = 500) {
    await this._sendCommand(bulbId, 'set_power', ['on', 'smooth', Math.round(transitionMs)]);
    const bulb = this.bulbs.get(bulbId);
    if (bulb) {
      bulb.state.on = true;
      this.bulbs.set(bulbId, bulb);
    }
    return { ok: true };
  }

  async turnOff(bulbId, transitionMs = 500) {
    await this._sendCommand(bulbId, 'set_power', ['off', 'smooth', Math.round(transitionMs)]);
    const bulb = this.bulbs.get(bulbId);
    if (bulb) {
      bulb.state.on = false;
      this.bulbs.set(bulbId, bulb);
    }
    return { ok: true };
  }

  async getState(bulbId) {
    return this._sendCommand(bulbId, 'get_prop', ['power', 'bright', 'ct', 'rgb', 'hue', 'sat']);
  }
}

// ============================================================
// Matter/Thread Controller (via chip-tool or Matter controller)
// ============================================================

class MatterController extends BulbController {
  constructor(config = {}) {
    super(config);
    this.chipToolPath = config.chipToolPath || 'chip-tool';
    this.commissionedDevices = new Map(); // nodeId -> device info
  }

  async discover() {
    // Matter discovery typically requires a controller (like Home Assistant, Apple Home, etc.)
    // This is a placeholder for Matter integration
    // In practice, you'd use a Matter controller SDK or chip-tool
    console.log('[Matter] Discovery requires a Matter controller (chip-tool, Home Assistant, etc.)');
    return [];
  }

  async connect(bulbId) {
    // Commissioning happens out-of-band
    return { ok: true };
  }

  async setColorTemperature(bulbId, kelvin, brightness = 1.0, transitionMs = 1000) {
    // Use chip-tool to set color temperature
    // chip-tool colorcontrol move-to-color-temperature <nodeId> <endpoint> <mired> <transitionTime>
    const mired = Math.round(1000000 / kelvin);
    const transition = Math.round(transitionMs / 100); // 1/10 second units

    try {
      await execFileAsync(this.chipToolPath, [
        'colorcontrol', 'move-to-color-temperature',
        bulbId, '1', String(mired), String(transition)
      ]);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  async setBrightness(bulbId, brightness, transitionMs = 1000) {
    const level = Math.round(brightness * 254);
    const transition = Math.round(transitionMs / 100);

    try {
      await execFileAsync(this.chipToolPath, [
        'levelcontrol', 'move-to-level-with-on-off',
        bulbId, '1', String(level), String(transition), '0', '0'
      ]);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  async turnOn(bulbId) {
    try {
      await execFileAsync(this.chipToolPath, ['onoff', 'on', bulbId, '1']);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  async turnOff(bulbId) {
    try {
      await execFileAsync(this.chipToolPath, ['onoff', 'off', bulbId, '1']);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }
}

// ============================================================
// Unified Smart Bulb Manager
// ============================================================

class SmartBulbManager {
  constructor(preferencesStore) {
    this.preferencesStore = preferencesStore;
    this.controllers = {
      hue: new HueController(),
      lifx: new LifxController(),
      yeelight: new YeelightController(),
      matter: new MatterController()
    };
    this.activeController = null;
    this.activeControllerType = null;
    this.enabled = false;
    this.allBulbs = new Map(); // merged view of all bulbs
    this._loadConfig();
  }

  _loadConfig() {
    const prefs = this.preferencesStore?.store || {};
    this.enabled = prefs.smartBulbEnabled === true;
    this.activeControllerType = prefs.smartBulbProtocol || null;

    // Load saved bridge/config for each protocol
    if (prefs.hueConfig) {
      this.controllers.hue.config = prefs.hueConfig;
    }
    if (prefs.lifxConfig) {
      this.controllers.lifx.config = prefs.lifxConfig;
    }
    if (prefs.yeelightConfig) {
      this.controllers.yeelight.config = prefs.yeelightConfig;
    }
    if (prefs.matterConfig) {
      this.controllers.matter.config = prefs.matterConfig;
    }
  }

  _saveConfig() {
    if (!this.preferencesStore) return;
    const prefs = this.preferencesStore.store;
    prefs.smartBulbEnabled = this.enabled;
    prefs.smartBulbProtocol = this.activeControllerType;
    prefs.hueConfig = this.controllers.hue.config;
    prefs.lifxConfig = this.controllers.lifx.config;
    prefs.yeelightConfig = this.controllers.yeelight.config;
    prefs.matterConfig = this.controllers.matter.config;
    // electron-store auto-saves
  }

  getAvailableProtocols() {
    return [
      { id: 'hue', name: 'Philips Hue', requiresBridge: true, localOnly: true },
      { id: 'lifx', name: 'LIFX', requiresBridge: false, localOnly: true },
      { id: 'yeelight', name: 'Yeelight', requiresBridge: false, localOnly: true },
      { id: 'matter', name: 'Matter/Thread', requiresBridge: true, localOnly: true }
    ];
  }

  async discoverAll() {
    const results = {};
    for (const [type, controller] of Object.entries(this.controllers)) {
      try {
        const bulbs = await controller.discover();
        results[type] = { bulbs, error: null };
      } catch (e) {
        results[type] = { bulbs: [], error: e.message };
      }
    }
    return results;
  }

  async setProtocol(protocol) {
    if (!this.controllers[protocol]) {
      return { ok: false, error: 'Unknown protocol' };
    }
    this.activeControllerType = protocol;
    this.activeController = this.controllers[protocol];
    this._saveConfig();
    return { ok: true };
  }

  async enable(enabled) {
    this.enabled = enabled;
    this._saveConfig();

    // If enabling and we have a protocol selected but no active controller, set it up
    if (enabled && this.activeControllerType && !this.activeController) {
      this.activeController = this.controllers[this.activeControllerType];
    }

    if (enabled && this.activeController) {
      // Re-discover to get current bulbs
      await this.activeController.discover();
      this._mergeBulbs();
    }
    return { ok: true };
  }

  _mergeBulbs() {
    this.allBulbs.clear();
    if (this.activeController) {
      for (const [id, bulb] of this.activeController.bulbs) {
        this.allBulbs.set(id, { ...bulb, protocol: this.activeControllerType });
      }
    }
  }

  getBulbs() {
    return Array.from(this.allBulbs.values());
  }

  getConnectedBulbs() {
    return Array.from(this.allBulbs.values()).filter(b => b.connected);
  }

  async applyWindDownState(intensity, transitionMs = 2000) {
    if (!this.enabled || !this.activeController) return { ok: false, error: 'Smart bulbs not enabled' };
    return this.activeController.applyWindDownState(intensity, transitionMs);
  }

  async restoreNormal(transitionMs = 3000) {
    if (!this.activeController) return { ok: false, error: 'No active controller' };
    return this.activeController.restoreNormal(transitionMs);
  }

  async controlBulb(bulbId, action, params = {}) {
    if (!this.activeController) return { ok: false, error: 'No active controller' };

    const bulb = this.activeController.bulbs.get(bulbId);
    if (!bulb) return { ok: false, error: 'Bulb not found' };

    switch (action) {
      case 'on':
        return this.activeController.turnOn(bulbId, params.transitionMs);
      case 'off':
        return this.activeController.turnOff(bulbId, params.transitionMs);
      case 'brightness':
        return this.activeController.setBrightness(bulbId, params.value, params.transitionMs);
      case 'colorTemperature':
        return this.activeController.setColorTemperature(bulbId, params.kelvin, params.brightness, params.transitionMs);
      case 'rgb':
        return this.activeController.setRGB(bulbId, params.r, params.g, params.b, params.brightness, params.transitionMs);
      case 'state':
        return this.activeController.getState(bulbId);
      default:
        return { ok: false, error: 'Unknown action' };
    }
  }

  // Called by wind-down engine every tick
  async onWindDownTick(state) {
    if (!this.enabled) return;

    const intensity = state?.intensity ?? 0;

    if (intensity > 0) {
      await this.applyWindDownState(intensity);
    } else {
      // Only restore if we were previously in wind-down
      // Track this to avoid constant restore calls
      if (this._wasInWindDown) {
        await this.restoreNormal();
        this._wasInWindDown = false;
      }
    }

    this._wasInWindDown = intensity > 0;
  }

  shutdown() {
    for (const controller of Object.values(this.controllers)) {
      if (controller.socket) {
        controller.socket.close();
      }
    }
  }
}

module.exports = {
  BulbController,
  HueController,
  LifxController,
  YeelightController,
  MatterController,
  SmartBulbManager
};