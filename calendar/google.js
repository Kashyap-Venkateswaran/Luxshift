/**
 * Google Calendar API Integration
 * Uses OAuth 2.0 for authentication
 */

const { google } = require('googleapis');
const { promisify } = require('util');
const fs = require('fs').promises;
const path = require('path');

/**
 * Google Calendar client for LuxShift
 */
class GoogleCalendarClient {
  constructor() {
    this.oauth2Client = null;
    this.calendar = null;
    this.tokens = null;
  }

  /**
   * Initialize with stored tokens
   */
  async initialize(tokens) {
    this.tokens = tokens;
    this.oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      'http://localhost:8787/auth/google/callback'  // Local redirect for desktop app
    );
    this.oauth2Client.setCredentials(tokens);
    this.calendar = google.calendar({ version: 'v3', auth: this.oauth2Client });
    return this;
  }

  /**
   * Get authorization URL for OAuth flow
   */
  getAuthUrl() {
    if (!this.oauth2Client) {
      this.oauth2Client = new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET,
        'http://localhost:8787/auth/google/callback'
      );
    }
    const scopes = ['https://www.googleapis.com/auth/calendar.readonly'];
    return this.oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: scopes,
      prompt: 'consent'
    });
  }

  /**
   * Exchange authorization code for tokens
   */
  async getTokens(code) {
    if (!this.oauth2Client) {
      this.oauth2Client = new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET,
        'http://localhost:8787/auth/google/callback'
      );
    }
    const { tokens } = await this.oauth2Client.getToken(code);
    this.tokens = tokens;
    this.oauth2Client.setCredentials(tokens);
    this.calendar = google.calendar({ version: 'v3', auth: this.oauth2Client });
    return tokens;
  }

  /**
   * List accessible calendars
   */
  async listCalendars() {
    if (!this.calendar) throw new Error('Not initialized');
    const res = await this.calendar.calendarList.list();
    return res.data.items || [];
  }

  /**
   * Fetch events from selected calendars within date range
   */
  async getEvents(calendarIds, startDate, endDate) {
    if (!this.calendar) throw new Error('Not initialized');

    const allEvents = [];
    for (const calId of calendarIds) {
      try {
        const res = await this.calendar.events.list({
          calendarId: calId,
          timeMin: startDate.toISOString(),
          timeMax: endDate.toISOString(),
          singleEvents: true,
          orderBy: 'startTime',
          maxResults: 250
        });
        const events = (res.data.items || []).map(event => ({
          id: event.id,
          title: event.summary || 'Untitled',
          description: event.description || '',
          location: event.location || '',
          start: event.start?.dateTime ? new Date(event.start.dateTime) : event.start?.date ? new Date(event.start.date) : null,
          end: event.end?.dateTime ? new Date(event.end.dateTime) : event.end?.date ? new Date(event.end.date) : null,
          isAllDay: !!event.start?.date,
          calendarId: calId,
          source: 'google'
        }));
        allEvents.push(...events);
      } catch (error) {
        console.error(`Error fetching events from ${calId}:`, error.message);
      }
    }
    return allEvents.sort((a, b) => new Date(a.start) - new Date(b.start));
  }

  /**
   * Get stored tokens
   */
  getTokens() {
    return this.tokens;
  }
}

module.exports = { GoogleCalendarClient };