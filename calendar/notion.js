/**
 * Notion Integration
 * Uses Notion REST API with integration token
 */

const { Client } = require('@notionhq/client');

/**
 * Notion Calendar client for LuxShift
 */
class NotionCalendarClient {
  constructor() {
    this.notion = null;
    this.databaseId = null;
    this.token = null;
  }

  /**
   * Initialize with integration token and database ID
   */
  async initialize(token, databaseId) {
    this.token = token;
    this.databaseId = databaseId;
    this.notion = new Client({ auth: token });

    // Test connection
    try {
      await this.notion.databases.retrieve({ database_id: databaseId });
      return true;
    } catch (error) {
      console.error('Notion initialization failed:', error.message);
      return false;
    }
  }

  /**
   * Fetch events from Notion database within date range
   */
  async getEvents(startDate, endDate) {
    if (!this.notion || !this.databaseId) {
      throw new Error('Not initialized');
    }

    const startISO = startDate.toISOString().split('T')[0];
    const endISO = endDate.toISOString().split('T')[0];

    try {
      // Find date property name
      const db = await this.notion.databases.retrieve({ database_id: this.databaseId });
      const datePropertyName = this._findDateProperty(db.properties);
      const titlePropertyName = this._findTitleProperty(db.properties);

      if (!datePropertyName) {
        throw new Error('No date property found in database');
      }

      const response = await this.notion.databases.query({
        database_id: this.databaseId,
        filter: {
          and: [
            { property: datePropertyName, date: { on_or_after: startISO } },
            { property: datePropertyName, date: { on_or_before: endISO } }
          ]
        },
        sorts: [{ property: datePropertyName, direction: 'ascending' }],
        page_size: 100
      });

      return response.results.map(page => {
        const props = page.properties;
        const dateProp = props[datePropertyName]?.date;
        const titleProp = titlePropertyName ? props[titlePropertyName]?.title : [];

        return {
          id: page.id,
          title: titleProp[0]?.plain_text || 'Untitled',
          start: dateProp?.start ? new Date(dateProp.start) : null,
          end: dateProp?.end ? new Date(dateProp.end) : null,
          url: page.url,
          source: 'notion'
        };
      });
    } catch (error) {
      console.error('Error fetching Notion events:', error.message);
      return [];
    }
  }

  _findDateProperty(properties) {
    for (const [name, prop] of Object.entries(properties)) {
      if (prop.type === 'date') return name;
    }
    return null;
  }

  _findTitleProperty(properties) {
    for (const [name, prop] of Object.entries(properties)) {
      if (prop.type === 'title') return name;
    }
    return null;
  }

  /**
   * Search for databases the integration has access to
   */
  async searchDatabases() {
    if (!this.notion) throw new Error('Not initialized');

    try {
      const response = await this.notion.search({
        filter: { property: 'object', value: 'database' },
        page_size: 50
      });
      return response.results.map(db => ({
        id: db.id,
        title: db.title?.[0]?.plain_text || 'Untitled Database',
        properties: Object.keys(db.properties || {})
      }));
    } catch (error) {
      console.error('Error searching Notion databases:', error.message);
      return [];
    }
  }
}

module.exports = { NotionCalendarClient };