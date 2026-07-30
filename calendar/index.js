/**
 * Calendar Integration Orchestrator
 * Manages Google Calendar, Apple Calendar, and Notion integrations
 */

const { GoogleCalendarClient } = require('./google');
const { AppleCalendarClient } = require('./apple');
const { NotionCalendarClient } = require('./notion');
const { parseICS } = require('./ics');

class CalendarManager {
  constructor() {
    this.googleClient = null;
    this.appleClient = new AppleCalendarClient();
    this.notionClient = null;
    this.connectedProviders = new Set();
  }

  async initGoogle(tokens) {
    if (!tokens) {
      throw new Error('Google tokens are required.');
    }

    this.googleClient = new GoogleCalendarClient();
    await this.googleClient.initialize(tokens);
    const calendars = await this.googleClient.listCalendars();
    this.connectedProviders.add('google');
    return { ok: true, calendars };
  }

  getGoogleAuthUrl() {
    if (!this.googleClient) {
      this.googleClient = new GoogleCalendarClient();
    }
    return this.googleClient.getAuthUrl();
  }

  async exchangeGoogleCode(code) {
    if (!code) {
      throw new Error('Google OAuth code is required.');
    }

    if (!this.googleClient) {
      this.googleClient = new GoogleCalendarClient();
    }

    const tokens = await this.googleClient.getTokens(code);
    const calendars = await this.googleClient.listCalendars();
    this.connectedProviders.add('google');

    return { ok: true, tokens, calendars };
  }

  async checkAppleAccess() {
    return this.appleClient.checkAccess();
  }

  async requestAppleAccess() {
    const { shell } = require('electron');
    await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars');
  }

  async listAppleCalendars() {
    return this.appleClient.listCalendars();
  }

  async initNotion(token, databaseId) {
    const client = new NotionCalendarClient();
    const ok = await client.initialize(token, databaseId);

    if (!ok) {
      this.notionClient = null;
      this.connectedProviders.delete('notion');
      return { ok: false, error: 'Failed to initialize Notion.' };
    }

    this.notionClient = client;
    this.connectedProviders.add('notion');
    const databases = await this.notionClient.searchDatabases();
    return { ok: true, databases };
  }

  async searchNotionDatabases() {
    if (!this.notionClient) {
      throw new Error('Notion not initialized.');
    }
    return this.notionClient.searchDatabases();
  }

  async fetchEvents(options = {}) {
    const { providers = [], startDate, endDate, calendarIds = {} } = options;
    const allEvents = [];

    const start = startDate ? new Date(startDate) : new Date();
    const end = endDate ? new Date(endDate) : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      throw new Error('Invalid date range supplied to fetchEvents().');
    }

    if (providers.includes('google')) {
      if (!this.googleClient) {
        throw new Error('Google Calendar is not initialized.');
      }
      const calIds = Array.isArray(calendarIds.google) ? calendarIds.google : [];
      const events = await this.googleClient.getEvents(calIds, start, end);
      allEvents.push(...events);
    }

    if (providers.includes('apple')) {
      const calNames = Array.isArray(calendarIds.apple) ? calendarIds.apple : [];
      const events = await this.appleClient.getEvents(calNames, start, end);
      allEvents.push(...events);
    }

    if (providers.includes('notion')) {
      if (!this.notionClient) {
        throw new Error('Notion is not initialized.');
      }
      const events = await this.notionClient.getEvents(start, end);
      allEvents.push(...events);
    }

    return allEvents
      .filter((e) => e?.start)
      .sort((a, b) => new Date(a.start) - new Date(b.start));
  }

  parseICSFile(content, startDate, endDate) {
    return parseICS(content, startDate, endDate);
  }

  eventsToBlocks(events) {
    return events.map((event) => {
      const start = event.start ? new Date(event.start) : null;
      const end = event.end ? new Date(event.end) : null;

      return {
        type: this._mapEventType(event.title || ''),
        title: event.title || 'Untitled',
        start: start && !Number.isNaN(start.getTime()) ? start.toTimeString().slice(0, 5) : null,
        end: end && !Number.isNaN(end.getTime()) ? end.toTimeString().slice(0, 5) : null,
        note: event.description || event.notes || '',
        location: event.location || '',
        source: 'calendar-import',
        originalEvent: event
      };
    }).filter((b) => b.start || b.end);
  }

  _mapEventType(title) {
    const lower = String(title || '').toLowerCase();
    if (lower.includes('sleep') || lower.includes('bed')) return 'sleep';
    if (lower.includes('wake') || lower.includes('alarm')) return 'wake';
    if (lower.includes('work') || lower.includes('meeting') || lower.includes('call') || lower.includes('focus')) return 'work';
    if (lower.includes('gym') || lower.includes('workout') || lower.includes('exercise') || lower.includes('run') || lower.includes('walk') || lower.includes('yoga')) return 'exercise';
    if (lower.includes('meal') || lower.includes('lunch') || lower.includes('dinner') || lower.includes('breakfast') || lower.includes('eat')) return 'meal';
    if (lower.includes('break') || lower.includes('rest') || lower.includes('downtime')) return 'break';
    if (lower.includes('unwind') || lower.includes('relax') || lower.includes('wind down')) return 'unwind';
    return 'general';
  }

  getConnectedProviders() {
    return Array.from(this.connectedProviders);
  }

  disconnect(provider) {
    this.connectedProviders.delete(provider);
    if (provider === 'google') this.googleClient = null;
    if (provider === 'notion') this.notionClient = null;
  }
}

module.exports = { CalendarManager };