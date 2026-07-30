/**
 * Apple Calendar (EventKit) Integration
 * Uses osascript to interact with macOS Calendar app
 */

const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

class AppleCalendarClient {
  constructor() {}

  _escapeAppleScriptString(value) {
    return String(value ?? '')
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"');
  }

  _toAppleScriptDate(date) {
    const d = new Date(date);
    if (Number.isNaN(d.getTime())) {
      throw new Error('Invalid date supplied to Apple Calendar client.');
    }

    const monthNames = [
      'January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December'
    ];

    const month = monthNames[d.getMonth()];
    const day = d.getDate();
    const year = d.getFullYear();
    const hours = d.getHours();
    const minutes = String(d.getMinutes()).padStart(2, '0');
    const seconds = String(d.getSeconds()).padStart(2, '0');
    const suffix = hours >= 12 ? 'PM' : 'AM';
    const hour12 = ((hours + 11) % 12) + 1;

    return `${month} ${day}, ${year} ${hour12}:${minutes}:${seconds} ${suffix}`;
  }

  _runAppleScript(script) {
    return execFileAsync('osascript', ['-e', script], {
      maxBuffer: 1024 * 1024 * 8
    });
  }

  async checkAccess() {
    const script = `
      tell application "Calendar"
        try
          get name of every calendar
          return "granted"
        on error errMsg number errNum
          return "denied"
        end try
      end tell
    `;

    try {
      const { stdout } = await this._runAppleScript(script);
      return stdout.trim() === 'granted';
    } catch (error) {
      console.error('Apple Calendar access check failed:', error.message);
      return false;
    }
  }

  async listCalendars() {
    const script = `
      set text item delimiters to ""
      tell application "Calendar"
        set outText to ""
        repeat with cal in every calendar
          set outText to outText & (id of cal as text) & "||" & (name of cal as text) & linefeed
        end repeat
        return outText
      end tell
    `;

    try {
      const { stdout } = await this._runAppleScript(script);
      return this._parseCalendarList(stdout);
    } catch (error) {
      console.error('Error listing Apple calendars:', error.message);
      return [];
    }
  }

  _parseCalendarList(output) {
    return String(output || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [id, name] = line.split('||');
        return {
          id: id || '',
          name: name || 'Untitled'
        };
      })
      .filter((item) => item.id && item.name);
  }

  async getEvents(calendarNames, startDate, endDate) {
    if (!Array.isArray(calendarNames) || calendarNames.length === 0) {
      return [];
    }

    const startStr = this._escapeAppleScriptString(this._toAppleScriptDate(startDate));
    const endStr = this._escapeAppleScriptString(this._toAppleScriptDate(endDate));
    const calendarListLiteral = calendarNames
      .filter(Boolean)
      .map((name) => `"${this._escapeAppleScriptString(name)}"`)
      .join(', ');

    const script = `
      set startDate to date "${startStr}"
      set endDate to date "${endStr}"
      set lineSep to "<<<LUXSHIFT_LINE>>>"
      set fieldSep to "<<<LUXSHIFT_FIELD>>>"

      tell application "Calendar"
        set outText to ""
        repeat with calName in {${calendarListLiteral}}
          try
            set calRef to first calendar whose name is (contents of calName)
            set calEvents to every event of calRef whose end date > startDate and start date < endDate
            repeat with ev in calEvents
              set eventId to ""
              try
                set eventId to uid of ev as text
              end try

              set eventTitle to ""
              try
                set eventTitle to summary of ev as text
              end try

              set eventDesc to ""
              try
                set eventDesc to description of ev as text
              end try

              set eventLoc to ""
              try
                set eventLoc to location of ev as text
              end try

              set outText to outText & eventId & fieldSep & eventTitle & fieldSep & ((start date of ev) as text) & fieldSep & ((end date of ev) as text) & fieldSep & eventDesc & fieldSep & eventLoc & fieldSep & (name of calRef as text) & lineSep
            end repeat
          end try
        end repeat
        return outText
      end tell
    `;

    try {
      const { stdout } = await this._runAppleScript(script);
      return this._parseEvents(stdout);
    } catch (error) {
      console.error('Error fetching Apple Calendar events:', error.message);
      return [];
    }
  }

  _parseEvents(output) {
    const lineSep = '<<<LUXSHIFT_LINE>>>';
    const fieldSep = '<<<LUXSHIFT_FIELD>>>';

    return String(output || '')
      .split(lineSep)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const parts = line.split(fieldSep);
        if (parts.length < 7) return null;

        const [id, title, start, end, description, location, calendarName] = parts;

        return {
          id: id || '',
          title: title || 'Untitled',
          start: start ? new Date(start) : null,
          end: end ? new Date(end) : null,
          description: description || '',
          location: location || '',
          calendarName: calendarName || '',
          source: 'apple'
        };
      })
      .filter((event) => event && event.start && !Number.isNaN(event.start.getTime()));
  }
}

module.exports = { AppleCalendarClient };