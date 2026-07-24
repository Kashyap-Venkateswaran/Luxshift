// LuxShift Configuration
// Single source of truth for API endpoints and settings

const CONFIG = {
  // Render API server URL
  API_BASE_URL: 'https://luxshift-api.onrender.com',

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
}