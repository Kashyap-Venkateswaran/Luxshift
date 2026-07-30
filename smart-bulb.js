/**
 * LuxShift Smart Bulb Integration
 *
 * Supports major smart bulb protocols:
 * - Philips Hue (local LAN API via bridge)
 * - LIFX (LAN protocol + cloud fallback)
 * - Yeelight (LAN protocol)
 * - Matter/Thread (via Matter controller)
 */

const { execFile } = require('child_process');
const { promisify } = require('util');
const dgram = require('dgram');

const execFileAsync = promisify(execFile);

class BulbController {
  constructor(config = {}) {
    this.config = config;
    this.bulbs = new Map();
    this.isConnected = false;
    this.discoveryInProgress = false;
  }

  async discover() { throw new Error('Not implemented'); }
  async connect(_bulbId) { throw new Error('Not implemented'); }
  async disconnect(_bulbId) { throw new Error('Not implemented'); }
  async setColorTemperature(_bulbId, _kelvin, _brightness = 1.0, _transitionMs = 1000) { throw new Error('Not implemented'); }
  async setRGB(_bulbId, _r, _g, _b, _brightness = 1.0, _transitionMs = 1000) { throw new Error('Not implemented'); }
  async setBrightness(_bulbId, _brightness, _transitionMs = 1000) { throw new Error('Not implemented'); }
  async turnOn(_bulbId, _transitionMs = 500) { throw new Error('Not implemented'); }
  async turnOff(_bulbId, _transitionMs = 500) { throw new Error('Not implemented'); }
  async getState(_bulbId) { throw new Error('Not implemented'); }

  async sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  static intensityToKelvin(intensity) {
    const clamped = Math.max(0, Math.min(1, Number(intensity) || 0));
    const progress = clamped * clamped;
    return Math.round(6500 - progress * 4700);
  }

  static intensityToBrightness(intensity) {
    const clamped = Math.max(0, Math.min(1, Number(intensity) || 0));
    const brightnessIntensity = Math.max(0, (clamped - 0.5) * 2);
    return 1.0 - (brightnessIntensity * 0.7);
  }

  async applyWindDownState(intensity, transitionMs = 2000) {
    const kelvin = BulbController.intensityToKelvin(intensity);
    const brightness = BulbController.intensityToBrightness(intensity);

    const tasks = [];
    for (const [bulbId, bulb] of this.bulbs.entries()) {
      if (bulb.connected) {
        tasks.push(this.setColorTemperature(bulbId, kelvin, brightness, transitionMs));
      }
    }

    await Promise.allSettled(tasks);
    return { ok: true, kelvin, brightness, appliedTo: tasks.length };
  }

  async restoreNormal(transitionMs = 3000) {
    const tasks = [];
    for (const [bulbId, bulb] of this.bulbs.entries()) {
      if (bulb.connected) {
        tasks.push(this.setColorTemperature(bulbId, 6500, 1.0, transitionMs));
      }
    }

    await Promise.allSettled(tasks);
    return { ok: true, restored: tasks.length };
  }
}

class HueController extends BulbController {
  constructor(config = {}) {
    super(config);
    this.bridgeIp = config.bridgeIp || null;
    this.username = config.username || null;
    this.baseUrl = null;
  }

  async discover() {
    this.discoveryInProgress = true;
    const foundBulbs = [];

    try {
      const response = await fetch('https://discovery.meethue.com/');
      if (response.ok) {
        const bridges = await response.json();
        for (const bridge of bridges) {
          if (bridge.internalipaddress) {
            await this._tryConnectBridge(bridge.internalipaddress, foundBulbs);
          }
        }
      }

      if (foundBulbs.length === 0) {
        await this._mdnsDiscovery(foundBulbs);
      }

      this.isConnected = foundBulbs.length > 0;
      return foundBulbs;
    } catch (e) {
      console.warn('[Hue] Discovery failed:', e.message);
      return [];
    } finally {
      this.discoveryInProgress = false;
    }
  }

  async _tryConnectBridge(ip, foundBulbs) {
    try {
      const stored = this.config.bridges?.[ip];
      this.bridgeIp = ip;

      if (stored?.username) {
        this.username = stored.username;
        this.baseUrl = `http://${ip}/api/${this.username}`;
        const bulbs = await this._fetchBulbs();
        foundBulbs.push(...bulbs);
        return;
      }

      const unauthBase = `http://${ip}/api`;
      const createResp = await fetch(unauthBase, {
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
      } else {
        console.log('[Hue] Bridge found at', ip, '- press link button to pair');
      }
    } catch (e) {
      console.warn('[Hue] Bridge connection failed:', e.message);
    }
  }

  async _mdnsDiscovery(foundBulbs) {
    return new Promise((resolve) => {
      const socket = dgram.createSocket('udp4');
      const found = new Set();

      socket.on('message', (msg) => {
        try {
          const text = msg.toString();
          if (text.includes('hue') || text.includes('philips')) {
            const ipMatch = text.match(/(\d+\.\d+\.\d+\.\d+)/);
            if (ipMatch && !found.has(ipMatch[1])) {
              found.add(ipMatch[1]);
              this._tryConnectBridge(ipMatch[1], foundBulbs).catch(() => {});
            }
          }
        } catch (_) {}
      });

      socket.on('error', (err) => {
        console.warn('[Hue] mDNS socket error:', err.message);
      });

      socket.bind(5353, () => {
        try {
          socket.addMembership('224.0.0.251');
        } catch (_) {}
      });

      setTimeout(() => {
        try { socket.close(); } catch (_) {}
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

      for (const [id, info] of Object.entries(data || {})) {
        bulbs.push({
          id: `hue-${id}`,
          name: info.name || `Hue ${id}`,
          type: 'hue',
          model: info.modelid || null,
          manufacturer: 'Philips',
          supportsColor: info.type !== 'Dimmable light',
          supportsCT: true,
          connected: info.state?.reachable === true,
          state: {
            on: Boolean(info.state?.on),
            brightness: info.state?.bri ? info.state.bri / 254 : 1,
            ct: info.state?.ct ? Math.round(1000000 / info.state.ct) : null
          },
          bridgeIp: this.bridgeIp,
          lightId: id
        });
      }

      for (const bulb of bulbs) this.bulbs.set(bulb.id, bulb);
      return bulbs;
    } catch (e) {
      console.warn('[Hue] Fetch bulbs failed:', e.message);
      return [];
    }
  }

  async connect(bulbId) {
    const bulbs = await this._fetchBulbs();
    const updated = bulbs.find((b) => b.id === bulbId);
    if (!updated) return { ok: false, error: 'Bulb unreachable' };
    updated.connected = true;
    this.bulbs.set(bulbId, updated);
    return { ok: true };
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
    if (!bulb || !this.baseUrl) return { ok: false, error: 'Bulb not found' };

    const mired = Math.round(1000000 / Math.max(1700, Math.min(6500, kelvin)));
    const bri = Math.round(Math.max(0, Math.min(1, brightness)) * 254);
    const transitiontime = Math.max(0, Math.round(transitionMs / 100));

    try {
      const resp = await fetch(`${this.baseUrl}/lights/${bulb.lightId}/state`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ on: true, ct: mired, bri, transitiontime })
      });
      const data = await resp.json();
      if (Array.isArray(data) && data.some((item) => item.success)) {
        bulb.state.ct = kelvin;
        bulb.state.brightness = brightness;
        bulb.state.on = true;
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
    if (!bulb || !bulb.supportsColor || !this.baseUrl) {
      return { ok: false, error: 'Bulb does not support color' };
    }

    const [x, y] = this._rgbToXy(r, g, b);
    const bri = Math.round(Math.max(0, Math.min(1, brightness)) * 254);
    const transitiontime = Math.max(0, Math.round(transitionMs / 100));

    try {
      const resp = await fetch(`${this.baseUrl}/lights/${bulb.lightId}/state`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ on: true, xy: [x, y], bri, transitiontime })
      });
      const data = await resp.json();
      return { ok: Array.isArray(data) && data.some((item) => item.success) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  async setBrightness(bulbId, brightness, transitionMs = 1000) {
    const bulb = this.bulbs.get(bulbId);
    if (!bulb || !this.baseUrl) return { ok: false, error: 'Bulb not found' };

    const bri = Math.round(Math.max(0, Math.min(1, brightness)) * 254);
    const transitiontime = Math.max(0, Math.round(transitionMs / 100));

    try {
      const resp = await fetch(`${this.baseUrl}/lights/${bulb.lightId}/state`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bri, transitiontime })
      });
      const data = await resp.json();
      if (Array.isArray(data) && data.some((item) => item.success)) {
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
    return this.setBrightness(bulbId, this.bulbs.get(bulbId)?.state?.brightness ?? 1, transitionMs);
  }

  async turnOff(bulbId, transitionMs = 500) {
    const bulb = this.bulbs.get(bulbId);
    if (!bulb || !this.baseUrl) return { ok: false, error: 'Bulb not found' };

    try {
      const resp = await fetch(`${this.baseUrl}/lights/${bulb.lightId}/state`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ on: false, transitiontime: Math.max(0, Math.round(transitionMs / 100)) })
      });
      const data = await resp.json();
      if (Array.isArray(data) && data.some((item) => item.success)) {
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
    if (!bulb || !this.baseUrl) return { ok: false, error: 'Bulb not found' };

    try {
      const resp = await fetch(`${this.baseUrl}/lights/${bulb.lightId}`);
      const data = await resp.json();
      return { ok: true, state: data?.state || null };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  _rgbToXy(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const toLinear = (c) => c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    r = toLinear(r); g = toLinear(g); b = toLinear(b);

    const X = r * 0.664511 + g * 0.154324 + b * 0.162028;
    const Y = r * 0.283881 + g * 0.668433 + b * 0.047685;
    const Z = r * 0.000088 + g * 0.07231 + b * 0.986039;
    const sum = X + Y + Z;

    return sum === 0 ? [0.3127, 0.329] : [X / sum, Y / sum];
  }
}

class LifxController extends BulbController {
  constructor(config = {}) {
    super(config);
    this.socket = null;
    this.sourceId = Math.floor(Math.random() * 0x100000000);
    this.sequence = 0;
    this.discoveredBulbs = new Map();
  }

  async discover() {
    this.discoveryInProgress = true;
    this.discoveredBulbs.clear();
    const foundBulbs = [];

    return new Promise((resolve) => {
      // Close existing socket if present
      if (this.socket) {
        try { this.socket.close(); } catch (_) {}
        this.socket = null;
      }

      this.socket = dgram.createSocket('udp4');

      this.socket.on('message', (msg, rinfo) => {
        this._handleMessage(msg, rinfo);
      });

      this.socket.on('error', (err) => {
        console.warn('[LIFX] Discovery socket error:', err.message);
      });

      this.socket.bind(0, () => {
        try {
          this.socket.setBroadcast(true);
          const packet = this._buildPacket(2, Buffer.alloc(0));
          this.socket.send(packet, 0, packet.length, 56700, '255.255.255.255');
        } catch (e) {
          console.warn('[LIFX] Discovery bind failed:', e.message);
          try { this.socket.close(); } catch (_) {}
          this.socket = null;
          resolve([]);
        }
      });

      setTimeout(() => {
        for (const [, bulb] of this.discoveredBulbs) {
          foundBulbs.push(bulb);
          this.bulbs.set(bulb.id, bulb);
        }
        this.isConnected = foundBulbs.length > 0;
        this.discoveryInProgress = false;
        try { if (this.socket) { this.socket.close(); this.socket = null; } } catch (_) {}
        resolve(foundBulbs);
      }, 3000);
    });
  }

  _buildPacket(type, payload, target = Buffer.alloc(8)) {
    const header = Buffer.alloc(36);
    header.writeUInt16LE(payload.length + 36, 0);
    header.writeUInt16LE(0x1400, 2);
    header.writeUInt32LE(this.sourceId, 4);
    target.copy(header, 8);
    header.writeUInt8(this.sequence++ % 256, 23);
    header.writeUInt16LE(type, 32);
    return Buffer.concat([header, payload]);
  }

  _handleMessage(msg, rinfo) {
    if (msg.length < 36) return;
    const type = msg.readUInt16LE(32);

    if (type === 3) {
      const target = msg.slice(8, 16);
      const mac = (target.toString('hex').match(/.{2}/g) || []).join(':');
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
          port: 56700,
          target,
          state: { on: true, brightness: 1, kelvin: 3500 }
        });
      }
    }
  }

  async _sendNoAck(bulbId, type, payload) {
    const bulb = this.bulbs.get(bulbId);
    if (!bulb) return { ok: false, error: 'Bulb not found' };

    // Reuse discovery socket if available, otherwise create a new one
    const socket = this.socket || dgram.createSocket('udp4');
    const shouldClose = !this.socket;

    return new Promise((resolve) => {
      const packet = this._buildPacket(type, payload, bulb.target);
      socket.send(packet, 0, packet.length, bulb.port || 56700, bulb.address, (err) => {
        if (shouldClose) {
          try { socket.close(); } catch (_) {}
        }
        resolve(err ? { ok: false, error: err.message } : { ok: true });
      });
    });
  }

  async connect(bulbId) {
    const bulb = this.bulbs.get(bulbId);
    if (!bulb) return { ok: false, error: 'Bulb not found' };
    bulb.connected = true;
    this.bulbs.set(bulbId, bulb);
    return { ok: true };
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
    const payload = Buffer.alloc(13);
    payload.writeUInt8(0, 0);
    payload.writeUInt16LE(0, 1);
    payload.writeUInt16LE(0, 3);
    payload.writeUInt16LE(Math.round(Math.max(0, Math.min(1, brightness)) * 65535), 5);
    payload.writeUInt16LE(Math.max(1500, Math.min(9000, Math.round(kelvin))), 7);
    payload.writeUInt32LE(Math.max(0, transitionMs), 9);
    return this._sendNoAck(bulbId, 102, payload);
  }

  async setRGB(bulbId, r, g, b, brightness = 1.0, transitionMs = 1000) {
    const [h, s] = this._rgbToHsv(r, g, b);
    const payload = Buffer.alloc(13);
    payload.writeUInt8(0, 0);
    payload.writeUInt16LE(Math.round((h / 360) * 65535), 1);
    payload.writeUInt16LE(Math.round(s * 65535), 3);
    payload.writeUInt16LE(Math.round(Math.max(0, Math.min(1, brightness)) * 65535), 5);
    payload.writeUInt16LE(3500, 7);
    payload.writeUInt32LE(Math.max(0, transitionMs), 9);
    return this._sendNoAck(bulbId, 102, payload);
  }

  async setBrightness(bulbId, brightness, transitionMs = 1000) {
    const bulb = this.bulbs.get(bulbId);
    const kelvin = bulb?.state?.kelvin || 3500;
    return this.setColorTemperature(bulbId, kelvin, brightness, transitionMs);
  }

  async turnOn(bulbId) {
    const payload = Buffer.alloc(6);
    payload.writeUInt16LE(65535, 0);
    payload.writeUInt32LE(0, 2);
    return this._sendNoAck(bulbId, 117, payload);
  }

  async turnOff(bulbId) {
    const payload = Buffer.alloc(6);
    payload.writeUInt16LE(0, 0);
    payload.writeUInt32LE(0, 2);
    return this._sendNoAck(bulbId, 117, payload);
  }

  async getState(bulbId) {
    const bulb = this.bulbs.get(bulbId);
    if (!bulb) return { ok: false, error: 'Bulb not found' };
    return { ok: true, state: bulb.state || null };
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

class YeelightController extends BulbController {
  constructor(config = {}) {
    super(config);
    this.messageId = 1;
  }

  async discover() {
    this.discoveryInProgress = true;
    const foundBulbs = [];
    const discovered = new Map();

    return new Promise((resolve) => {
      const socket = dgram.createSocket('udp4');

      socket.on('message', (msg) => {
        try {
          const text = msg.toString();
          if (!text.includes('yeelight') && !text.includes('yeelink')) return;

          const lines = text.split('\r\n');
          const headers = {};
          for (const line of lines) {
            const idx = line.indexOf(':');
            if (idx > 0) headers[line.slice(0, idx).toLowerCase()] = line.slice(idx + 1).trim();
          }

          const location = headers.location || '';
          const ipMatch = location.match(/(\d+\.\d+\.\d+\.\d+):(\d+)/);
          if (!ipMatch) return;

          const id = `yeelight-${headers.id || ipMatch[1]}`;
          if (!discovered.has(id)) {
            discovered.set(id, {
              id,
              name: headers.model || 'Yeelight',
              type: 'yeelight',
              manufacturer: 'Yeelight',
              model: headers.model || null,
              supportsColor: String(headers.support || '').includes('set_rgb'),
              supportsCT: String(headers.support || '').includes('set_ct_abx'),
              connected: true,
              address: ipMatch[1],
              port: parseInt(ipMatch[2], 10) || 55443,
              state: { on: true, brightness: 1, kelvin: 4000 }
            });
          }
        } catch (_) {}
      });

      socket.on('error', (err) => {
        console.warn('[Yeelight] Discovery socket error:', err.message);
      });

      socket.bind(0, () => {
        try {
          socket.setBroadcast(true);
          const search = [
            'M-SEARCH * HTTP/1.1',
            'HOST: 239.255.255.250:1982',
            'MAN: "ssdp:discover"',
            'ST: wifi_bulb',
            'MX: 2',
            '',
            ''
          ].join('\r\n');
          socket.send(search, 0, search.length, 1982, '239.255.255.250');
        } catch (_) {}
      });

      setTimeout(() => {
        for (const [, bulb] of discovered) {
          foundBulbs.push(bulb);
          this.bulbs.set(bulb.id, bulb);
        }
        this.isConnected = foundBulbs.length > 0;
        this.discoveryInProgress = false;
        try { socket.close(); } catch (_) {}
        resolve(foundBulbs);
      }, 3000);
    });
  }

  _sendCommand(bulbId, method, params = []) {
    const bulb = this.bulbs.get(bulbId);
    if (!bulb) return Promise.resolve({ ok: false, error: 'Bulb not found' });

    return new Promise((resolve) => {
      const client = dgram.createSocket('udp4');
      const msg = JSON.stringify({ id: this.messageId++, method, params }) + '\r\n';
      const buffer = Buffer.from(msg);

      const timeout = setTimeout(() => {
        try { client.close(); } catch (_) {}
        resolve({ ok: false, error: 'Timeout' });
      }, 3000);

      client.on('message', (response) => {
        clearTimeout(timeout);
        try { client.close(); } catch (_) {}
        try {
          const result = JSON.parse(response.toString());
          resolve({ ok: !result.error, result: result.result, error: result.error?.message });
        } catch (_) {
          resolve({ ok: false, error: 'Invalid response' });
        }
      });

      client.on('error', (err) => {
        clearTimeout(timeout);
        try { client.close(); } catch (_) {}
        resolve({ ok: false, error: err.message });
      });

      client.bind(0, () => {
        client.setBroadcast(true);
        client.send(buffer, 0, buffer.length, bulb.port, bulb.address);
      });
    });
  }

  async connect(bulbId) {
    const bulb = this.bulbs.get(bulbId);
    if (!bulb) return { ok: false, error: 'Bulb not found' };
    bulb.connected = true;
    this.bulbs.set(bulbId, bulb);
    return { ok: true };
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
    const clampedKelvin = Math.max(1700, Math.min(6500, Math.round(kelvin)));
    const bright = Math.round(Math.max(1, Math.min(100, brightness * 100)));
    const duration = Math.max(0, Math.round(transitionMs));

    await this._sendCommand(bulbId, 'set_power', ['on', 'smooth', duration]);
    const ctResp = await this._sendCommand(bulbId, 'set_ct_abx', [clampedKelvin, 'smooth', duration]);
    const bResp = await this._sendCommand(bulbId, 'set_bright', [bright, 'smooth', duration]);

    return { ok: Boolean(ctResp.ok && bResp.ok) };
  }

  async setRGB(bulbId, r, g, b, brightness = 1.0, transitionMs = 1000) {
    const rgb = (r << 16) | (g << 8) | b;
    const bright = Math.round(Math.max(1, Math.min(100, brightness * 100)));
    const duration = Math.max(0, Math.round(transitionMs));

    await this._sendCommand(bulbId, 'set_power', ['on', 'smooth', duration]);
    const rgbResp = await this._sendCommand(bulbId, 'set_rgb', [rgb, 'smooth', duration]);
    const bResp = await this._sendCommand(bulbId, 'set_bright', [bright, 'smooth', duration]);

    return { ok: Boolean(rgbResp.ok && bResp.ok) };
  }

  async setBrightness(bulbId, brightness, transitionMs = 1000) {
    const bright = Math.round(Math.max(1, Math.min(100, brightness * 100)));
    return this._sendCommand(bulbId, 'set_bright', [bright, 'smooth', Math.max(0, Math.round(transitionMs))]);
  }

  async turnOn(bulbId, transitionMs = 500) {
    return this._sendCommand(bulbId, 'set_power', ['on', 'smooth', Math.max(0, Math.round(transitionMs))]);
  }

  async turnOff(bulbId, transitionMs = 500) {
    return this._sendCommand(bulbId, 'set_power', ['off', 'smooth', Math.max(0, Math.round(transitionMs))]);
  }

  async getState(bulbId) {
    return this._sendCommand(bulbId, 'get_prop', ['power', 'bright', 'ct', 'rgb', 'hue', 'sat']);
  }
}

class MatterController extends BulbController {
  constructor(config = {}) {
    super(config);
    this.chipToolPath = config.chipToolPath || 'chip-tool';
  }

  async discover() {
    console.log('[Matter] Discovery requires an external Matter controller.');
    return [];
  }

  async connect(_bulbId) {
    return { ok: true };
  }

  async disconnect(_bulbId) {
    return { ok: true };
  }

  async setColorTemperature(bulbId, kelvin, _brightness = 1.0, transitionMs = 1000) {
    const mired = Math.round(1000000 / Math.max(1700, Math.min(6500, kelvin)));
    const transition = Math.round(transitionMs / 100);

    try {
      await execFileAsync(this.chipToolPath, [
        'colorcontrol',
        'move-to-color-temperature',
        String(mired),
        String(transition),
        '0',
        '0',
        bulbId,
        '1'
      ]);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  async setRGB(_bulbId, _r, _g, _b, _brightness = 1.0, _transitionMs = 1000) {
    return { ok: false, error: 'Matter RGB control not implemented in this build' };
  }

  async setBrightness(bulbId, brightness, transitionMs = 1000) {
    const level = Math.round(Math.max(0, Math.min(1, brightness)) * 254);
    const transition = Math.round(transitionMs / 100);

    try {
      await execFileAsync(this.chipToolPath, [
        'levelcontrol',
        'move-to-level-with-on-off',
        String(level),
        String(transition),
        '0',
        '0',
        bulbId,
        '1'
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

  async getState(_bulbId) {
    return { ok: false, error: 'Matter state query not implemented in this build' };
  }
}

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
    this.allBulbs = new Map();
    this._wasInWindDown = false;
    this._loadConfig();
  }

  _loadConfig() {
    const prefs = this.preferencesStore?.store || {};
    this.enabled = prefs.smartBulbEnabled === true;
    this.activeControllerType = prefs.smartBulbProtocol || null;

    if (prefs.hueConfig) this.controllers.hue.config = prefs.hueConfig;
    if (prefs.lifxConfig) this.controllers.lifx.config = prefs.lifxConfig;
    if (prefs.yeelightConfig) this.controllers.yeelight.config = prefs.yeelightConfig;
    if (prefs.matterConfig) this.controllers.matter.config = prefs.matterConfig;

    if (this.activeControllerType && this.controllers[this.activeControllerType]) {
      this.activeController = this.controllers[this.activeControllerType];
    }
  }

  _saveConfig() {
    if (!this.preferencesStore) return;
    this.preferencesStore.set('smartBulbEnabled', this.enabled);
    this.preferencesStore.set('smartBulbProtocol', this.activeControllerType);
    this.preferencesStore.set('hueConfig', this.controllers.hue.config);
    this.preferencesStore.set('lifxConfig', this.controllers.lifx.config);
    this.preferencesStore.set('yeelightConfig', this.controllers.yeelight.config);
    this.preferencesStore.set('matterConfig', this.controllers.matter.config);
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
    this._mergeBulbs();
    this._saveConfig();
    return { ok: true };
  }

  async enable(enabled) {
    this.enabled = Boolean(enabled);
    this._saveConfig();

    if (this.enabled && this.activeControllerType && !this.activeController) {
      this.activeController = this.controllers[this.activeControllerType];
    }

    if (this.enabled && this.activeController) {
      await this.activeController.discover();
      this._mergeBulbs();
    }

    return { ok: true };
  }

  _mergeBulbs() {
    this.allBulbs.clear();
    if (!this.activeController) return;

    for (const [id, bulb] of this.activeController.bulbs.entries()) {
      this.allBulbs.set(id, { ...bulb, protocol: this.activeControllerType });
    }
  }

  getBulbs() {
    this._mergeBulbs();
    return Array.from(this.allBulbs.values());
  }

  getConnectedBulbs() {
    return this.getBulbs().filter((b) => b.connected);
  }

  async applyWindDownState(intensity, transitionMs = 2000) {
    if (!this.enabled || !this.activeController) {
      return { ok: false, error: 'Smart bulbs not enabled' };
    }
    return this.activeController.applyWindDownState(intensity, transitionMs);
  }

  async restoreNormal(transitionMs = 3000) {
    if (!this.activeController) {
      return { ok: false, error: 'No active controller' };
    }
    return this.activeController.restoreNormal(transitionMs);
  }

  async controlBulb(bulbId, action, params = {}) {
    if (!this.activeController) {
      return { ok: false, error: 'No active controller' };
    }

    const bulb = this.activeController.bulbs.get(bulbId);
    if (!bulb) {
      return { ok: false, error: 'Bulb not found' };
    }

    switch (action) {
      case 'on':
        return this.activeController.turnOn(bulbId, params.transitionMs);
      case 'off':
        return this.activeController.turnOff(bulbId, params.transitionMs);
      case 'brightness':
        return this.activeController.setBrightness(bulbId, params.value, params.transitionMs);
      case 'colorTemperature':
        return this.activeController.setColorTemperature(
          bulbId,
          params.kelvin,
          params.brightness,
          params.transitionMs
        );
      case 'rgb':
        return this.activeController.setRGB(
          bulbId,
          params.r,
          params.g,
          params.b,
          params.brightness,
          params.transitionMs
        );
      case 'state':
        return this.activeController.getState(bulbId);
      default:
        return { ok: false, error: 'Unknown action' };
    }
  }

  async onWindDownTick(state) {
    if (!this.enabled) return;

    const intensity = Number(state?.intensity ?? 0);

    if (intensity > 0) {
      await this.applyWindDownState(intensity);
      this._wasInWindDown = true;
    } else if (this._wasInWindDown) {
      await this.restoreNormal();
      this._wasInWindDown = false;
    }
  }

  shutdown() {
    for (const controller of Object.values(this.controllers)) {
      if (controller.socket) {
        try { controller.socket.close(); } catch (_) {}
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