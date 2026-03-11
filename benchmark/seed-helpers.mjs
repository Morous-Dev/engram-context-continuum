/**
 * seed-helpers.mjs — DB seeding utilities for ECC benchmarks.
 *
 * Responsible for: inserting realistic session events into a SessionDB
 * instance to simulate what hooks would have captured during a real session.
 *
 * Depends on: build/session/db.js
 * Depended on by: benchmark scenarios.
 */

/**
 * Seed a batch of events into a SessionDB.
 * Each event is { type, category, priority, data }.
 *
 * @param {object} db         - SessionDB instance
 * @param {string} sessionId  - Session UUID
 * @param {Array}  events     - Event descriptors
 * @param {string} hook       - Source hook name
 */
export function seed(db, sessionId, events, hook = 'PostToolUse') {
  for (const ev of events) {
    db.insertEvent(sessionId, {
      type: ev.type,
      category: ev.category,
      priority: ev.priority ?? 2,
      data: ev.data,
    }, hook);
  }
}

/** Shorthand builders */
export const ev = {
  prompt:   (data) => ({ type: 'user_prompt',  category: 'prompt',   priority: 1, data }),
  decision: (data) => ({ type: 'decision',     category: 'decision', priority: 1, data }),
  fileEdit: (path) => ({ type: 'file_edit',    category: 'file',     priority: 2, data: path }),
  fileWrite:(path) => ({ type: 'file_write',   category: 'file',     priority: 2, data: path }),
  fileRead: (path) => ({ type: 'file_read',    category: 'file',     priority: 3, data: path }),
  error:    (data) => ({ type: 'error',        category: 'error',    priority: 1, data }),
  resolved: (data) => ({ type: 'error_resolved', category: 'error',  priority: 2, data }),
  tool:     (data) => ({ type: 'tool_use',     category: 'tool',     priority: 3, data }),
  rule:     (data) => ({ type: 'rule',         category: 'rule',     priority: 1, data }),
  task:     (data) => ({ type: 'task',         category: 'task',     priority: 1, data }),
};
