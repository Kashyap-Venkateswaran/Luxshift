/**
 * Google Calendar API Integration
 * Uses OAuth 2.0 with a local loopback server to catch the redirect,
 * since a packaged desktop app has no fixed running web server.
 */

const { google } = require('googleapis');
const http = require('http');

const REDIRECT_PORT = 51823;
const REDIRECT_URI = `http://127.0.0.1:${REDIRECT_PORT}/callback`;

/**
 * Google Calendar client for LuxShift
 */
class GoogleCalendarClient {
  constructor() {
    this.oauth2Client = null;
    this.calendar = null;
    this.tokens = null;
  }

  _buildClient() {
    if (!this.oauth2Client) {
      this.oauth2Client = new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET,
        REDIRECT_URI
      );
    }
    return this.oauth2Client;
  }

  /**
   * Initialize with stored tokens
   */
  async initialize(tokens) {
    this.tokens = tokens;
    const client = this._buildClient();
    client.setCredentials(tokens);
    this.calendar = google.calendar({ version: 'v3', auth: client });
    return this;
  }

  /**
   * Get authorization URL for OAuth flow
   */
  getAuthUrl() {
    const client = this._buildClient();
    const scopes = ['https://www.googleapis.com/auth/calendar.readonly'];
    return client.generateAuthUrl({
      access_type: 'offline',
      scope: scopes,
      prompt: 'consent'
    });
  }

  /**
   * Runs a short-lived local server to catch the OAuth redirect,
   * opens the auth URL in the user's default browser, and resolves
   * with tokens once the user completes sign-in.
   */
  async connectInteractive(openExternal) {
    const client = this._buildClient();
    const authUrl = this.getAuthUrl();

    const code = await new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        try {
          const url = new URL(req.url, `http://127.0.0.1:${REDIRECT_PORT}`);
          const authCode = url.searchParams.get('code');
          const error = url.searchParams.get('error');

          res.writeHead(200, { 'Content-Type': 'text/html' });
          if (authCode) {
            res.end('<html><body style="font-family:-apple-system,sans-serif;background:#08111f;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><div><h2>LuxShift connected ✓</h2><p>You can close this window and return to the app.</p></div></body></html>');
            resolve(authCode);
          } else {
            res.end('<html><body style="font-family:-apple-system,sans-serif;background:#08111f;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><div><h2>Connection failed</h2><p>Please close this window and try again in LuxShift.</p></div></body></html>');
            reject(new Error(error || 'No authorization code received'));
          }
          setTimeout(() => server.close(), 500);
        } catch (err) {
          reject(err);
        }
      });

      server.listen(REDIRECT_PORT, '127.0.0.1', () => {
        openExternal(authUrl);
      });

      server.on('error', reject);

      // Timeout after 3 minutes if user never completes sign-in
      setTimeout(() => {
        server.close();
        reject(new Error('Google sign-in timed out. Please try again.'));
      }, 3 * 60 * 1000);
    });

    return this.getTokens(code);
  }

  /**
   * Exchange authorization code for tokens
   */
  async getTokens(code) {
    const client = this._buildClient();
    const { tokens } = await client.getToken(code);
    this.tokens = tokens;
    client.setCredentials(tokens);
    this.calendar = google.calendar({ version: 'v3', auth: client });
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