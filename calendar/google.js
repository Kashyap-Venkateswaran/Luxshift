/**
 * Google Calendar API Integration
 * Uses OAuth 2.0 with a local loopback server to catch the redirect,
 * since a packaged desktop app has no fixed running web server.
 */
const { google } = require('googleapis');
const http = require('http');

const REDIRECT_PORT = 51823;
const REDIRECT_URI = `http://127.0.0.1:${REDIRECT_PORT}/callback`;

class GoogleCalendarClient {
  constructor() {
    this.oauth2Client = null;
    this.calendar = null;
    this.tokens = null;
  }

  _buildClient() {
    if (!this.oauth2Client) {
      // FIX: fail loudly if env vars are missing instead of creating a
      // broken OAuth2 client that fails deep inside googleapis with a
      // confusing "invalid_client" error.
      if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
        throw new Error(
          'GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not set. Add them to your .env file next to main.js.'
        );
      }
      this.oauth2Client = new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET,
        REDIRECT_URI
      );
    }
    return this.oauth2Client;
  }

  async initialize(tokens) {
    if (!tokens) throw new Error('No Google Calendar tokens supplied to initialize().');
    this.tokens = tokens;
    const client = this._buildClient();
    client.setCredentials(tokens);
    this.calendar = google.calendar({ version: 'v3', auth: client });
    return this;
  }

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

          // FIX: explicit UTF-8 charset — without this, any non-ASCII
          // character (✓, —, etc.) renders as mojibake like "âœ"" in the browser.
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });

          if (authCode) {
            res.end(
              '<html><body style="font-family:sans-serif;text-align:center;margin-top:20vh;">' +
              '<h1>LuxShift connected</h1>' +
              '<p>You can close this window and return to the app.</p>' +
              '</body></html>'
            );
            resolve(authCode);
          } else if (error) {
            res.end(
              '<html><body style="font-family:sans-serif;text-align:center;margin-top:20vh;">' +
              '<h1>Connection failed</h1>' +
              '<p>Please close this window and try again in LuxShift.</p>' +
              '</body></html>'
            );
            reject(new Error(`Google OAuth error: ${error}`));
          } else {
            res.end('<html><body>Waiting for authorization…</body></html>');
            return; // FIX: don't close server on unrelated requests (e.g. favicon.ico)
          }
        } catch (err) {
          reject(err);
        } finally {
          // FIX: close server only after a real code/error was received,
          // and do it on next tick so res.end() actually flushes first.
          setImmediate(() => server.close());
        }
      });

      // FIX: surface port-in-use / listen errors instead of hanging forever
      server.on('error', (err) => {
        reject(new Error(`Local OAuth server failed to start on port ${REDIRECT_PORT}: ${err.message}`));
      });

      server.listen(REDIRECT_PORT, '127.0.0.1', async () => {
        try {
          await openExternal(authUrl);
        } catch (err) {
          server.close();
          reject(new Error(`Could not open browser for Google sign-in: ${err.message}`));
        }
      });

      // FIX: add a timeout so a user who abandons the browser tab doesn't
      // leave the app hanging on "Opening browser for Google sign-in…" forever.
      setTimeout(() => {
        server.close();
        reject(new Error('Google sign-in timed out after 3 minutes. Please try again.'));
      }, 3 * 60 * 1000);
    });

    const tokens = await this.getTokens(code);
    return tokens;
  }

  async getTokens(code) {
    const client = this._buildClient();
    const { tokens } = await client.getToken(code);
    client.setCredentials(tokens);
    this.tokens = tokens;
    this.calendar = google.calendar({ version: 'v3', auth: client });
    return tokens;
  }

  async listCalendars() {
    if (!this.calendar) throw new Error('Google Calendar client not initialized. Call initialize() first.');
    const res = await this.calendar.calendarList.list();
    return (res.data.items || []).map((cal) => ({
      id: cal.id,
      name: cal.summary,
      primary: Boolean(cal.primary),
      color: cal.backgroundColor || null
    }));
  }

  async getEvents(calendarIds, startDate, endDate) {
    if (!this.calendar) throw new Error('Google Calendar client not initialized. Call initialize() first.');
    const ids = Array.isArray(calendarIds) && calendarIds.length ? calendarIds : ['primary'];
    const allEvents = [];

    for (const calendarId of ids) {
      try {
        const res = await this.calendar.events.list({
          calendarId,
          timeMin: startDate.toISOString(),
          timeMax: endDate.toISOString(),
          singleEvents: true,
          orderBy: 'startTime'
        });
        const events = (res.data.items || []).map((event) => ({
          id: event.id,
          title: event.summary || 'Untitled',
          start: event.start?.dateTime || event.start?.date || null,
          end: event.end?.dateTime || event.end?.date || null,
          location: event.location || '',
          description: event.description || '',
          source: 'google'
        }));
        allEvents.push(...events);
      } catch (error) {
        // FIX: one bad calendar ID no longer kills the whole fetch silently —
        // log which calendar failed so it's debuggable.
        console.error(`[Google Calendar] Failed to fetch events for calendar "${calendarId}":`, error.message);
      }
    }

    return allEvents;
  }
}

module.exports = { GoogleCalendarClient };