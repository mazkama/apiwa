/**
 * JID Utilities for WhatsApp LID (Linked ID) Support
 *
 * Background:
 * WhatsApp's Android multi-device system identifies users with a "LID" (Linked ID)
 * — a numeric identifier such as "70850149654769" stored as "70850149654769@lid".
 * This is different from the standard phone-number-based JID: "628xxx@s.whatsapp.net".
 *
 * Incoming messages from Android devices may carry LIDs instead of phone numbers,
 * which breaks any logic that assumes the sender is a phone number.
 *
 * This module:
 *  1. Maintains an in-memory LID → phone JID mapping (populated from Baileys events).
 *  2. Exposes normalizeJid() to resolve a LID to its phone JID where possible.
 *  3. Exposes getUserId() to consistently extract the sender from any message.
 */

const { jidNormalizedUser } = require('@whiskeysockets/baileys');

/**
 * In-memory store: bare LID string → standard phone JID
 * Example: "70850149654769" → "628123456789@s.whatsapp.net"
 *
 * Populated when Baileys fires "contacts.update" or "lid-mapping.update".
 */
const lidToJidMap = new Map();

/**
 * Populate the in-memory LID→JID mapping store.
 * Called from Baileys event handlers to register known LID/phone pairs.
 *
 * @param {Array<{lid: string, jid: string}>} mappings
 */
function updateLidMapping(mappings) {
    if (!Array.isArray(mappings)) return;
    for (const entry of mappings) {
        if (entry.lid && entry.jid) {
            // Strip the @lid domain so we can look up by bare numeric ID
            const lid = entry.lid.split('@')[0];
            lidToJidMap.set(lid, entry.jid);
            console.log(`[LID] Mapped LID ${lid} → ${entry.jid}`);
        }
    }
}

/**
 * Determine whether a JID is an Android LID rather than a standard phone JID.
 *
 * LIDs appear with an explicit "@lid" domain: "70850149654769@lid".
 * Standard phone JIDs look like "628xxx@s.whatsapp.net".
 * Group JIDs look like "120363xxx@g.us".
 *
 * @param {string} jid
 * @returns {boolean}
 */
function isLid(jid) {
    if (!jid) return false;
    return jid.endsWith('@lid');
}

/**
 * Normalize a WhatsApp JID to a standard phone-number-based JID where possible.
 *
 * Resolution order:
 *   1. Group JIDs (@g.us)           → returned unchanged (not affected by LID)
 *   2. Standard phone JIDs          → normalized via Baileys (strips :device suffix)
 *   3. LID JIDs (@lid or numeric)   → look up in lidToJidMap
 *        → Mapping found:   return phone JID
 *        → No mapping yet:  return as "<lid>@lid" (safe fallback)
 *
 * @param {string} jid - Raw JID from a Baileys message key
 * @returns {string} Normalized JID
 */
function normalizeJid(jid) {
    if (!jid) return jid;

    // Group JIDs are never LIDs — return immediately
    if (jid.endsWith('@g.us')) return jid;

    // Apply Baileys normalization to strip device suffixes (e.g. "628xxx:4@s.whatsapp.net")
    let normalized;
    try {
        normalized = jidNormalizedUser(jid);
    } catch (_) {
        normalized = jid;
    }

    // Already a standard phone JID — nothing more to do
    if (normalized.endsWith('@s.whatsapp.net')) return normalized;

    // LID resolution: attempt to convert numeric/LID to phone JID
    if (isLid(normalized)) {
        const lid = normalized.split('@')[0];
        const mapped = lidToJidMap.get(lid);
        if (mapped) {
            console.log(`[LID] Resolved LID ${lid} → ${mapped}`);
            return mapped;
        }
        // No mapping available yet — return with explicit @lid domain as a safe fallback
        const fallback = `${lid}@lid`;
        console.log(`[LID] No mapping for LID ${lid}, using fallback: ${fallback}`);
        return fallback;
    }

    return normalized;
}

/**
 * Extract a consistent sender identifier from a Baileys message object.
 *
 * Logic:
 *   - Group messages: the actual sender is msg.key.participant
 *   - DM messages:    the sender is msg.key.remoteJid
 *   - msg.key.remoteJidAlt is used as a secondary source when the primary is a LID
 *     but the alt contains a standard phone JID (provides an immediate resolution)
 *
 * @param {Object} msg - Baileys message object
 * @returns {{ id: string, jid: string, isLidBased: boolean }}
 *   id          — The identifier without the @domain (phone number or bare LID)
 *   jid         — The full normalized JID
 *   isLidBased  — true when the returned identifier is still an unresolved LID
 */
function getUserId(msg) {
    const rawJid = msg.key.participant || msg.key.remoteJid || '';
    const altJid = msg.key.remoteJidAlt || null;

    console.log(`[JID] Original: ${rawJid}${altJid ? ` | Alt: ${altJid}` : ''}`);

    // If the primary JID is a LID but remoteJidAlt is a standard phone JID, prefer the alt
    if (isLid(rawJid) && altJid && !isLid(altJid)) {
        const normalizedAlt = normalizeJid(altJid);
        const id = normalizedAlt.split('@')[0];
        console.log(`[JID] Resolved via remoteJidAlt: ${normalizedAlt} | Type: Phone`);
        return { id, jid: normalizedAlt, isLidBased: false };
    }

    const normalizedJid = normalizeJid(rawJid);
    const stillLid = isLid(normalizedJid);
    const id = normalizedJid.split('@')[0];

    console.log(`[JID] Normalized: ${normalizedJid} | Type: ${stillLid ? 'LID' : 'Phone'}`);

    return { id, jid: normalizedJid, isLidBased: stillLid };
}

module.exports = { updateLidMapping, normalizeJid, getUserId, isLid, lidToJidMap };
