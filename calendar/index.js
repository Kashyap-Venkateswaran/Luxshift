/**
 * Calendar Integration Orchestrator
 * Manages Google Calendar, Apple Calendar, and Notion integrations
 */

const { GoogleCalendarClient } = require('./google');
const { AppleCalendarClient } = require('./apple');
const { NotionCalendarClient } = require('./notion');
const { parseICS, icsEventsToBlocks } = require('./ics');

/**
 * Calendar Manager - orchestrates all calendar integrations
 */
class CalendarManager {
  constructor() {
    this.googleClient = null;
    this.appleClient = new AppleCalendarClient();
    this.notionClient = null;
    this.connectedProviders = new Set();
  }

  /**
   * Initialize Google Calendar with OAuth tokens
   */
  async initGoogle(tokens) {
    this.googleClient = new GoogleCalendarClient();
    await this.googleClient.initialize(tokens);
    this.connectedProviders.add('google');
    return { ok: true, calendars: await this.googleClient.listCalendars() };
  }

  /**
   * Get Google OAuth authorization URL
   */
  getGoogleAuthUrl() {
    if (!this.googleClient) {
      this.googleClient = new GoogleCalendarClient();
    }
    return this.googleClient.getAuthUrl();
  }

  /**
   * Exchange Google OAuth code for tokens
   */
  async exchangeGoogleCode(code) {
    if (!this.googleClient) {
      this.googleClient = new GoogleCalendarClient();
    }
    const tokens = await this.googleClient.getTokens(code);
    this.connectedProviders.add('google');
    return { ok: true, tokens, calendars: await this.googleClient.listCalendars() };
  }

  /**
   * Check Apple Calendar access
   */
  async checkAppleAccess() {
    return await this.appleClient.checkAccess();
  }

  /**
   * Request Apple Calendar access
   */
  async requestAppleAccess() {
    // This opens System Settings for Calendar permissions
    const { shell } = require('electron');
    await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars');
  }

  /**
   * List Apple calendars
   */
  async listAppleCalendars() {
    return await this.appleClient.listCalendars();
  }

  /**
   * Initialize Notion with integration token and database ID
   */
  async initNotion(token, databaseId) {
    this.notionClient = new NotionCalendarClient();
    const ok = await this.notionClient.initialize(token, databaseId);
    if (ok) {
      this.connectedProviders.add('notion');
      const databases = await this.notionClient.searchDatabases();
      return { ok: true, databases };
    }
    return { ok: false, error: 'Failed to initialize Notion' };
  }

  /**
   * Search for Notion databases
   */
  async searchNotionDatabases() {
    if (!this.notionClient) throw new Error('Notion not initialized');
    return await this.notionClient.searchDatabases();
  }

  /**
   * Fetch events from all connected providers within date range
   * @param {Object} options - { providers: ['google', 'apple', 'notion'], startDate, endDate, calendarIds }
   */
  async fetchEvents(options = {}) {
    const { providers = [], startDate, endDate, calendarIds = {} } = options;
    const allEvents = [];

    const start = startDate ? new Date(startDate) : new Date();
    const end = endDate ? new Date(endDate) : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    // Google Calendar
    if (providers.includes('google') && this.googleClient) {
      try {
        const calIds = calendarIds.google || [];
        const events = await this.googleClient.getEvents(calIds, start, end);
        allEvents.push(...events);
      } catch (error) {
        console.error('Google Calendar fetch error:', error.message);
      }
    }

    // Apple Calendar
    if (providers.includes('apple')) {
      try {
        const calNames = calendarIds.apple || [];
        const events = await this.appleClient.getEvents(calNames, start, end);
        allEvents.push(...events);
      } catch (error) {
        console.error('Apple Calendar fetch error:', error.message);
      }
    }

    // Notion
    if (providers.includes('notion') && this.notionClient) {
      try {
        const events = await this.notionClient.getEvents(start, end);
        allEvents.push(...events);
      } catch (error) {
        console.error('Notion fetch error:', error.message);
      }
    }

    // Sort by start time
    return allEvents
      .filter(e => e.start)
      .sort((a, b) => new Date(a.start) - new Date(b.start));
  }

  /**
   * Parse ICS file and convert to events
   */
  parseICSFile(content, startDate, endDate) {
    const events = parseICS(content, startDate, endDate);
    return events;
  }

  /**
   * Convert calendar events to LuxShift schedule blocks
   */
  eventsToBlocks(events) {
    return events.map(event => {
      const start = event.start ? new Date(event.start) : null;
      const end = event.end ? new Date(event.end) : null;

      return {
        type: this._mapEventType(event.title),
        title: event.title,
        start: start ? start.toTimeString().slice(0, 5) : null,
        end: end ? end.toTimeString().slice(0, 5) : null,
        note: event.description || event.notes || '',
        location: event.location || '',
        source: 'calendar-import',
        originalEvent: event
      };
    }).filter(b => b.start || b.end);
  }

  _mapEventType(title) {
    const lower = title.toLowerCase();
    if (lower.includes('sleep') || lower.includes('bed')) return 'sleep';
    if (lower.includes('wake') || lower.includes('alarm')) return 'wake';
    if (lower.includes('work') || lower.includes('meeting') || lower.includes('call') || lower.includes('focus')) return 'work';
    if (lower.includes('gym') || lower.includes('workout') || lower.includes('exercise') || lower.includes('run') || lower.includes('walk') || lower.includes('yoga')) return 'exercise';
    if (lower.includes('meal') || lower.includes('lunch') || lower.includes('dinner') || lower.includes('breakfast') || lower.includes('eat')) return 'meal';
    if (lower.includes('break') || lower.includes('rest') || lower.includes('downtime')) return 'break';
    if (lower.includes('unwind') || lower.includes('relax') || lower.includes('wind down')) return 'unwind';
    return 'general';
  }

  /**
   * Get list of connected providers
   */
  getConnectedProviders() {
    return Array.from(this.connectedProviders);
  }

  /**
   * Disconnect a provider
   */
  disconnect(provider) {
    this.connectedProviders.delete(provider);
    if (provider === 'google') this.googleClient = null;
    if (provider === 'notion') this.notionClient = null;
  }
}

module.exports = { CalendarManager };