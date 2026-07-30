/**
 * Notion Integration
 * Uses Notion REST API with integration token
 */

const { Client } = require('@notionhq/client');

class NotionCalendarClient {
  constructor() {
    this.notion = null;
    this.databaseId = null;
    this.token = null;
  }

  async initialize(token, databaseId) {
    if (!token || !databaseId) {
      // FIX: never leave a partially-built client sitting around —
      // this was the root cause of "Error: Not initialized" appearing
      // even after the user pressed Connect.
      this.notion = null;
      this.databaseId = null;
      this.token = null;
      return false;
    }

    const client = new Client({ auth: token });
    try {
      await client.databases.retrieve({ database_id: databaseId });
      // FIX: only commit state to `this` after the connection actually succeeds
      this.notion = client;
      this.databaseId = databaseId;
      this.token = token;
      return true;
    } catch (error) {
      console.error('Notion initialization failed:', error.message);
      this.notion = null;
      this.databaseId = null;
      this.token = null;
      return false;
    }
  }

  async getEvents(startDate, endDate) {
    if (!this.notion || !this.databaseId) {
      throw new Error('Notion is not connected. Enter a valid integration token and database ID, then click Connect Selected.');
    }

    const startISO = startDate.toISOString().split('T')[0];
    const endISO = endDate.toISOString().split('T')[0];

    try {
      const db = await this.notion.databases.retrieve({ database_id: this.databaseId });
      const datePropertyName = this._findDateProperty(db.properties);
      const titlePropertyName = this._findTitleProperty(db.properties);

      if (!datePropertyName) {
        throw new Error('No date property found in this Notion database.');
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

      return response.results.map((page) => {
        const props = page.properties;
        const dateProp = props[datePropertyName]?.date;
        const titleProp = titlePropertyName ? props[titlePropertyName]?.title : [];

        return {
          id: page.id,
          title: titleProp?.[0]?.plain_text || 'Untitled',
          start: dateProp?.start ? new Date(dateProp.start) : null,
          end: dateProp?.end ? new Date(dateProp.end) : null,
          url: page.url,
          source: 'notion'
        };
      });
    } catch (error) {
      console.error('Error fetching Notion events:', error.message);
      // FIX: rethrow instead of silently returning [] — renderer.js needs to
      // know this failed so it doesn't report "0 events" as a success.
      throw error;
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

  async searchDatabases() {
    if (!this.notion) throw new Error('Notion is not connected.');
    try {
      const response = await this.notion.search({
        filter: { property: 'object', value: 'database' },
        page_size: 50
      });
      return response.results.map((db) => ({
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