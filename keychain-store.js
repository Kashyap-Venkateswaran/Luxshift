"use strict";

const { safeStorage } = require('electron');
const Store = require('electron-store');

// Separate, dedicated store just for encrypted secrets.
// Values are stored as base64-encoded encrypted buffers, never plaintext.
const secretsStore = new Store({ name: 'luxshift-secrets' });

// Account name prefix for API keys
const API_KEY_ACCOUNT_PREFIX = 'api-key:';

/**
 * Get the storage key for a specific API provider
 * @param {string} provider - The API provider (e.g., 'openai', 'google')
 * @returns {string} The storage key
 */
function getApiKeyAccountName(provider) {
  return `${API_KEY_ACCOUNT_PREFIX}${provider}`;
}

/**
 * Securely store an API key using the OS keychain (via Electron's safeStorage)
 * @param {string} key - The API key to store
 * @param {string} provider - The API provider
 * @returns {Promise<{ok: boolean, error?: string}>} Result object
 */
async function saveApiKey(key, provider) {
  if (!key || !provider) {
    return { ok: false, error: 'Key and provider are required' };
  }

  try {
    if (!safeStorage.isEncryptionAvailable()) {
      return { ok: false, error: 'OS-level encryption is not available on this device' };
    }

    const accountName = getApiKeyAccountName(provider);
    const encrypted = safeStorage.encryptString(key);
    // electron-store persists JSON, so store the encrypted buffer as base64
    secretsStore.set(accountName, encrypted.toString('base64'));
    return { ok: true };
  } catch (error) {
    console.error('Failed to save API key:', error);
    return { ok: false, error: `Failed to save API key: ${error.message}` };
  }
}

/**
 * Retrieve an API key
 * @param {string} provider - The API provider
 * @returns {Promise<{ok: boolean, key?: string|null, error?: string}>} Result object
 */
async function getApiKey(provider) {
  if (!provider) {
    return { ok: false, error: 'Provider is required' };
  }

  try {
    const accountName = getApiKeyAccountName(provider);
    const stored = secretsStore.get(accountName);

    if (!stored) {
      return { ok: true, key: null };
    }

    if (!safeStorage.isEncryptionAvailable()) {
      return { ok: false, error: 'OS-level encryption is not available on this device' };
    }

    const buffer = Buffer.from(stored, 'base64');
    const key = safeStorage.decryptString(buffer);
    return { ok: true, key: key || null };
  } catch (error) {
    console.error('Failed to retrieve API key:', error);
    return { ok: false, error: `Failed to retrieve API key: ${error.message}` };
  }
}

/**
 * Delete an API key
 * @param {string} provider - The API provider
 * @returns {Promise<{ok: boolean, error?: string}>} Result object
 */
async function deleteApiKey(provider) {
  if (!provider) {
    return { ok: false, error: 'Provider is required' };
  }

  try {
    const accountName = getApiKeyAccountName(provider);
    const existed = secretsStore.has(accountName);
    secretsStore.delete(accountName);
    return { ok: true, deleted: existed };
  } catch (error) {
    console.error('Failed to delete API key:', error);
    return { ok: false, error: `Failed to delete API key: ${error.message}` };
  }
}

/**
 * Check if an API key exists
 * @param {string} provider - The API provider
 * @returns {Promise<{ok: boolean, exists?: boolean, error?: string}>} Result object
 */
async function hasApiKey(provider) {
  if (!provider) {
    return { ok: false, error: 'Provider is required' };
  }

  try {
    const accountName = getApiKeyAccountName(provider);
    return { ok: true, exists: secretsStore.has(accountName) };
  } catch (error) {
    console.error('Failed to check API key existence:', error);
    return { ok: false, error: `Failed to check API key: ${error.message}` };
  }
}

/**
 * Clear all API keys
 * @returns {Promise<{ok: boolean, error?: string}>} Result object
 */
async function clearAllApiKeys() {
  try {
    const allKeys = Object.keys(secretsStore.store);
    allKeys
      .filter(key => key.startsWith(API_KEY_ACCOUNT_PREFIX))
      .forEach(key => secretsStore.delete(key));
    return { ok: true };
  } catch (error) {
    console.error('Failed to clear API keys:', error);
    return { ok: false, error: `Failed to clear API keys: ${error.message}` };
  }
}

module.exports = {
  saveApiKey,
  getApiKey,
  deleteApiKey,
  hasApiKey,
  clearAllApiKeys
};