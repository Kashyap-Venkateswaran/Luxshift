/**
 * Apple Calendar (EventKit) Integration
 * Uses osascript to interact with macOS Calendar app
 */

const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

/**
 * Apple Calendar client for LuxShift
 * Uses native macOS EventKit via osascript
 */
class AppleCalendarClient {
  constructor() {}

  /**
   * Check if Calendar access is granted
   */
  async checkAccess() {
    const script = `
      tell application "Calendar"
        try
          get name of every calendar
          return "granted"
        on error
          return "denied"
        end try
      end tell
    `;
    try {
      const { stdout } = await execFileAsync('osascript', ['-e', script]);
      return stdout.trim() === 'granted';
    } catch {
      return false;
    }
  }

  /**
   * List all calendars
   */
  async listCalendars() {
    const script = `
      tell application "Calendar"
        set calList to {}
        repeat with cal in every calendar
          set end of calList to {name:name of cal, id:id of cal, color:color of cal as string}
        end repeat
        return calList
      end tell
    `;
    try {
      const { stdout } = await execFileAsync('osascript', ['-e', script]);
      // Parse AppleScript record list
      return this._parseCalendarList(stdout.trim());
    } catch (error) {
      console.error('Error listing Apple calendars:', error.message);
      return [];
    }
  }

  _parseCalendarList(output) {
    // AppleScript returns something like: {name:"Home", id:"xxx", color:"..."}, {name:"Work", id:"yyy", color:"..."}
    const calendars = [];
    const regex = /\{name:"([^"]+)", id:"([^"]+)", color:"([^"]+)"\}/g;
    let match;
    while ((match = regex.exec(output)) !== null) {
      calendars.push({
        name: match[1],
        id: match[2],
        color: match[3]
      });
    }
    return calendars;
  }

  /**
   * Fetch events from selected calendars within date range
   */
  async getEvents(calendarNames, startDate, endDate) {
    const calNames = calendarNames.join('","');
    const startISO = startDate.toISOString().replace('T', ' ').split('.')[0];
    const endISO = endDate.toISOString().replace('T', ' ').split('.')[0];

    const script = `
      tell application "Calendar"
        set startDate to date "${startISO}"
        set endDate to date "${endISO}"
        set eventList to {}
        repeat with calName in {"${calNames}"}
          try
            set cal to calendar calName
            set calEvents to every event of cal whose start date >= startDate and end date <= endDate
            repeat with ev in calEvents
              set end of eventList to {summary:summary of ev, start:start date of ev, end:end date of ev, description:description of ev, location:location of ev, uid:uid of ev, calendar:name of cal}
            end repeat
          end try
        end repeat
        return eventList
      end tell
    `;
    try {
      const { stdout } = await execFileAsync('osascript', ['-e', script]);
      return this._parseEvents(stdout.trim());
    } catch (error) {
      console.error('Error fetching Apple Calendar events:', error.message);
      return [];
    }
  }

  _parseEvents(output) {
    // Parse AppleScript event records
    const events = [];
    // AppleScript returns: {summary:"Event", start:date "...", end:date "...", description:"...", location:"...", uid:"...", calendar:"CalName"}
    const regex = /\{summary:"([^"]*)", start:date "([^"]+)", end:date "([^"]+)", description:"([^"]*)", location:"([^"]*)", uid:"([^"]*)", calendar:"([^"]+)"\}/g;
    let match;
    while ((match = regex.exec(output)) !== null) {
      events.push({
        title: match[1] || 'Untitled',
        start: new Date(match[2]),
        end: new Date(match[3]),
        description: match[4] || '',
        location: match[5] || '',
        id: match[6],
        calendarName: match[7],
        source: 'apple'
      });
    }
    return events;
  }
}

module.exports = { AppleCalendarClient };