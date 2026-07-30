// LuxShift Configuration
// Single source of truth for API endpoints and settings

// Browser-safe configuration - use window.__env for environment variables
const getEnv = (key, defaultValue) => {
  if (typeof window !== 'undefined' && window.__env) {
    return window.__env[key] || defaultValue;
  }
  if (typeof process !== 'undefined' && process.env) {
    return process.env[key] || defaultValue;
  }
  return defaultValue;
};

const CONFIG = {
  // Render API server URL - use getter to prevent immediate process.env access
  get API_BASE_URL() {
    return getEnv('API_BASE_URL', 'https://luxshift-api.onrender.com');
  },

  // API Key for authentication (optional) - use getter
  get API_KEY() {
    return getEnv('API_KEY', null);
  },

  // Derived endpoints
  get PARSE_SCHEDULE_URL() {
    return `${this.API_BASE_URL}/parse-schedule`;
  },
  get CALENDAR_CONNECT_URL() {
    return `${this.API_BASE_URL}/calendar/connect`;
  },
  get CALENDAR_EVENTS_URL() {
    return `${this.API_BASE_URL}/calendar/events`;
  },
  get HEALTH_URL() {
    return `${this.API_BASE_URL}/health`;
  },
  get PING_URL() {
    return `${this.API_BASE_URL}/ping`;
  },

  // Ping interval (ms) - 10 minutes = 600,000 ms
  PING_INTERVAL_MS: 10 * 60 * 1000,

  // App metadata
  APP_NAME: 'LuxShift',
  APP_VERSION: '2.0.1',
};

// Freeze to prevent accidental modification
Object.freeze(CONFIG);

// Export for both Node (main process) and browser (renderer)
if (typeof module !== 'undefined' && module.exports) {
  module.exports = CONFIG;
}
if (typeof window !== 'undefined') {
  window.LUXSHIFT_CONFIG = CONFIG;
};

// Freeze to prevent accidental modification
Object.freeze(CONFIG);

// Export for both Node (main process) and browser (renderer)
if (typeof module !== 'undefined' && module.exports) {
  module.exports = CONFIG;
}
if (typeof window !== 'undefined') {
  window.LUXSHIFT_CONFIG = CONFIG;
}