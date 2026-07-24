/**
 * Keep-Alive Ping Script
 * Runs in Electron main process to ping the Render server every 10 minutes
 * Prevents free-tier spin-down (cold starts)
 */

const CONFIG = require('./config.js');

class KeepAlivePinger {
  constructor() {
    this.intervalId = null;
    this.isPinging = false;
  }

  start() {
    if (this.intervalId) {
      console.log('[KeepAlive] Already running');
      return;
    }

    // Initial ping after 30 seconds (let app fully start)
    setTimeout(() => this.ping(), 30 * 1000);

    // Then every 10 minutes
    this.intervalId = setInterval(() => this.ping(), CONFIG.PING_INTERVAL_MS);
    console.log(`[KeepAlive] Started — pinging ${CONFIG.PING_URL} every ${CONFIG.PING_INTERVAL_MS / 60000} minutes`);
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      console.log('[KeepAlive] Stopped');
    }
  }

  async ping() {
    if (this.isPinging) return; // Prevent overlapping pings
    this.isPinging = true;

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s timeout

      const response = await fetch(CONFIG.PING_URL, {
        method: 'GET',
        signal: controller.signal,
        headers: { 'Accept': 'application/json' },
      });

      clearTimeout(timeoutId);

      if (response.ok) {
        const data = await response.json().catch(() => ({}));
        console.log(`[KeepAlive] ✓ Ping OK (${response.status}) — server time: ${data.ts || 'unknown'}`);
      } else {
        console.warn(`[KeepAlive] ✗ Ping failed: ${response.status} ${response.statusText}`);
      }
    } catch (error) {
      if (error.name === 'AbortError') {
        console.warn('[KeepAlive] ✗ Ping timeout (10s)');
      } else if (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED') {
        console.warn('[KeepAlive] ✗ Network error — server may be down');
      } else {
        console.warn(`[KeepAlive] ✗ Ping error: ${error.message}`);
      }
    } finally {
      this.isPinging = false;
    }
  }
}

module.exports = { KeepAlivePinger };