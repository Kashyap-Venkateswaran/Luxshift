/**
 * ICS (iCalendar) Parser
 * Parses .ics files into event objects
 */

function parseICS(content, startDate = null, endDate = null) {
  const events = [];
  const lines = content.split(/\r?\n/);

  let currentEvent = null;
  let inEvent = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed === 'BEGIN:VEVENT') {
      inEvent = true;
      currentEvent = {
        summary: '',
        description: '',
        location: '',
        dtstart: null,
        dtend: null,
        uid: '',
        rrule: null
      };
      continue;
    }

    if (trimmed === 'END:VEVENT') {
      if (currentEvent && currentEvent.dtstart) {
        // Filter by date range if provided
        const eventStart = parseICSDate(currentEvent.dtstart);
        const eventEnd = currentEvent.dtend ? parseICSDate(currentEvent.dtend) : null;

        if (startDate && eventEnd && eventEnd < startDate) {
          // Event ends before range
        } else if (endDate && eventStart && eventStart > endDate) {
          // Event starts after range
        } else {
          events.push({
            id: currentEvent.uid,
            title: currentEvent.summary || 'Untitled',
            description: currentEvent.description || '',
            location: currentEvent.location || '',
            start: eventStart,
            end: eventEnd,
            source: 'ics',
            rrule: currentEvent.rrule
          });
        }
      }
      inEvent = false;
      currentEvent = null;
      continue;
    }

    if (!inEvent || !currentEvent) continue;

    // Parse property lines
    const colonIndex = trimmed.indexOf(':');
    if (colonIndex === -1) continue;

    const propName = trimmed.slice(0, colonIndex).toUpperCase();
    const propValue = trimmed.slice(colonIndex + 1);

    // Handle folded lines (continuation lines start with space)
    if (propName === 'SUMMARY' || propName === 'DESCRIPTION' || propName === 'LOCATION') {
      currentEvent[propName.toLowerCase()] = propValue;
    } else if (propName.startsWith('DTSTART')) {
      currentEvent.dtstart = propValue;
    } else if (propName.startsWith('DTEND')) {
      currentEvent.dtend = propValue;
    } else if (propName === 'UID') {
      currentEvent.uid = propValue;
    } else if (propName === 'RRULE') {
      currentEvent.rrule = propValue;
    }
  }

  return events;
}

/**
 * Parse ICS date format to Date object
 * Supports: DATE (YYYYMMDD), DATETIME (YYYYMMDDTHHMMSSZ or YYYYMMDDTHHMMSS)
 */
function parseICSDate(dateStr) {
  if (!dateStr) return null;

  // Remove timezone info if present (e.g., "20240723T100000Z" or "20240723T100000")
  const clean = dateStr.replace(/[Z]/g, '');

  // DATE format: YYYYMMDD
  if (clean.length === 8) {
    const year = parseInt(clean.slice(0, 4), 10);
    const month = parseInt(clean.slice(4, 6), 10) - 1;
    const day = parseInt(clean.slice(6, 8), 10);
    return new Date(Date.UTC(year, month, day));
  }

  // DATETIME format: YYYYMMDDTHHMMSS
  if (clean.length >= 15) {
    const year = parseInt(clean.slice(0, 4), 10);
    const month = parseInt(clean.slice(4, 6), 10) - 1;
    const day = parseInt(clean.slice(6, 8), 10);
    const hour = parseInt(clean.slice(9, 11), 10);
    const minute = parseInt(clean.slice(11, 13), 10);
    const second = parseInt(clean.slice(13, 15), 10);

    // Check if it's UTC (ends with Z) or local
    const isUTC = dateStr.endsWith('Z');
    if (isUTC) {
      return new Date(Date.UTC(year, month, day, hour, minute, second));
    } else {
      return new Date(year, month, day, hour, minute, second);
    }
  }

  return null;
}

/**
 * Convert ICS events to LuxShift schedule blocks
 */
function icsEventsToBlocks(events) {
  return events.map(event => {
    const start = event.start ? new Date(event.start) : null;
    const end = event.end ? new Date(event.end) : null;

    return {
      type: mapEventType(event.title),
      title: event.title,
      start: start ? start.toTimeString().slice(0, 5) : null,
      end: end ? end.toTimeString().slice(0, 5) : null,
      note: event.description || '',
      location: event.location || '',
      source: 'ics-import',
      originalEvent: event
    };
  }).filter(b => b.start || b.end);
}

function mapEventType(title) {
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

module.exports = { parseICS, icsEventsToBlocks };