const fs = require('fs');
const path = require('path');
// Built into Node 22.13+ (still marked experimental; prints one warning).
const { DatabaseSync } = require('node:sqlite');

// ---------------------------------------------------------------------
// Users' private collections of search results, in SQLite on disk. Only
// document ids are kept, never text or titles: whoever views a collection
// sees its documents through a fresh, role-filtered search, so an item
// they've lost access to simply drops out of view.
//
// Every call takes the owner, and every query is scoped to it, so one
// user's collection ids are just "not found" for anyone else.
// ---------------------------------------------------------------------
const MAX_COLLECTIONS = 100;
const MAX_ITEMS = 1000;
const MAX_NAME = 100;
const MAX_DESCRIPTION = 1000;

class CollectionError extends Error {
  constructor(message, status) { super(message); this.status = status; this.expose = true; }
}

function openCollections(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS collections (
      id      INTEGER PRIMARY KEY,
      owner   TEXT NOT NULL,
      name    TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      created TEXT NOT NULL,
      UNIQUE (owner, name)
    );
    CREATE TABLE IF NOT EXISTS items (
      collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
      doc_id        TEXT NOT NULL,
      added         TEXT NOT NULL,
      PRIMARY KEY (collection_id, doc_id)
    );
  `);
  // Databases created before descriptions existed.
  if (!db.prepare('PRAGMA table_info(collections)').all().some(c => c.name === 'description')) {
    db.exec("ALTER TABLE collections ADD COLUMN description TEXT NOT NULL DEFAULT ''");
  }

  const q = {
    list: db.prepare(`SELECT c.id, c.name, c.description, c.created, COUNT(i.doc_id) AS count
                        FROM collections c LEFT JOIN items i ON i.collection_id = c.id
                       WHERE c.owner = ? GROUP BY c.id ORDER BY c.name COLLATE NOCASE`),
    listWithDoc: db.prepare(`SELECT c.id, c.name, c.description, COUNT(i.doc_id) AS count,
                                    MAX(i.doc_id = ?) AS contains
                               FROM collections c LEFT JOIN items i ON i.collection_id = c.id
                              WHERE c.owner = ? GROUP BY c.id ORDER BY c.name COLLATE NOCASE`),
    count: db.prepare('SELECT COUNT(*) AS n FROM collections WHERE owner = ?'),
    get: db.prepare('SELECT id, name, description, created FROM collections WHERE id = ? AND owner = ?'),
    create: db.prepare('INSERT INTO collections (owner, name, description, created) VALUES (?, ?, ?, ?)'),
    update: db.prepare('UPDATE collections SET name = ?, description = ? WHERE id = ? AND owner = ?'),
    remove: db.prepare('DELETE FROM collections WHERE id = ? AND owner = ?'),
    items: db.prepare('SELECT doc_id FROM items WHERE collection_id = ? ORDER BY added DESC, rowid DESC'),
    itemCount: db.prepare('SELECT COUNT(*) AS n FROM items WHERE collection_id = ?'),
    addItem: db.prepare('INSERT OR IGNORE INTO items (collection_id, doc_id, added) VALUES (?, ?, ?)'),
    removeItem: db.prepare('DELETE FROM items WHERE collection_id = ? AND doc_id = ?'),
  };

  function cleanName(name) {
    const n = typeof name === 'string' ? name.trim() : '';
    if (!n || n.length > MAX_NAME) throw new CollectionError(`A name of 1 to ${MAX_NAME} characters is required`, 400);
    return n;
  }

  // Optional; trimmed. undefined stays undefined (leave it as it is).
  function cleanDescription(description) {
    if (description === undefined) return undefined;
    if (typeof description !== 'string' || description.trim().length > MAX_DESCRIPTION) {
      throw new CollectionError(`A description can be up to ${MAX_DESCRIPTION} characters`, 400);
    }
    return description.trim();
  }

  // Throws 404 unless the collection exists and belongs to owner.
  function owned(owner, id) {
    const c = q.get.get(Number(id), owner);
    if (!c) throw new CollectionError('Collection not found', 404);
    return c;
  }

  function uniqueName(fn) {
    try {
      return fn();
    } catch (err) {
      if (/UNIQUE/.test(err.message)) throw new CollectionError('You already have a collection with that name', 409);
      throw err;
    }
  }

  return {
    // [{ id, name, count }], plus `contains` for docId if given.
    list(owner, docId) {
      return docId
        ? q.listWithDoc.all(docId, owner).map(c => ({ ...c, contains: Boolean(c.contains) }))
        : q.list.all(owner);
    },
    create(owner, name, description) {
      const n = cleanName(name);
      const d = cleanDescription(description) ?? '';
      if (q.count.get(owner).n >= MAX_COLLECTIONS) {
        throw new CollectionError(`You can have up to ${MAX_COLLECTIONS} collections`, 400);
      }
      return uniqueName(() => {
        const { lastInsertRowid } = q.create.run(owner, n, d, new Date().toISOString());
        return { id: Number(lastInsertRowid), name: n, description: d, count: 0 };
      });
    },
    get(owner, id) { return owned(owner, id); },
    // Changes the name and/or description; whichever is undefined is kept.
    update(owner, id, { name, description } = {}) {
      const current = owned(owner, id);
      const n = name === undefined ? current.name : cleanName(name);
      const d = cleanDescription(description) ?? current.description;
      uniqueName(() => q.update.run(n, d, Number(id), owner));
      return { id: Number(id), name: n, description: d };
    },
    remove(owner, id) {
      owned(owner, id);
      q.remove.run(Number(id), owner);
    },
    // Document ids, most recently added first.
    items(owner, id) {
      owned(owner, id);
      return q.items.all(Number(id)).map(r => r.doc_id);
    },
    addItem(owner, id, docId) {
      owned(owner, id);
      if (q.itemCount.get(Number(id)).n >= MAX_ITEMS) {
        throw new CollectionError(`A collection can hold up to ${MAX_ITEMS} documents`, 400);
      }
      q.addItem.run(Number(id), docId, new Date().toISOString());
    },
    removeItem(owner, id, docId) {
      owned(owner, id);
      q.removeItem.run(Number(id), docId);
    },
    describe: () => dbPath,
  };
}

module.exports = { openCollections, CollectionError };
