const fs = require('fs');
const path = require('path');
// Built into Node 22.13+ (still marked experimental; prints one warning).
const { DatabaseSync } = require('node:sqlite');
const { cleanBoard, emptyBoard, boardDocIds } = require('./board');

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
const MAX_BOARD_VERSIONS = 30;

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
    CREATE TABLE IF NOT EXISTS boards (
      collection_id INTEGER PRIMARY KEY REFERENCES collections(id) ON DELETE CASCADE,
      revision      INTEGER NOT NULL,
      data          TEXT NOT NULL,
      updated       TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS board_versions (
      id            INTEGER PRIMARY KEY,
      collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
      name          TEXT NOT NULL,
      auto          INTEGER NOT NULL,
      data          TEXT NOT NULL,
      created       TEXT NOT NULL
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
    hasItem: db.prepare('SELECT 1 FROM items WHERE collection_id = ? AND doc_id = ?'),
    versions: db.prepare('SELECT id, name, auto, data, created FROM board_versions WHERE collection_id = ? ORDER BY id DESC'),
    version: db.prepare('SELECT id, name, data FROM board_versions WHERE id = ? AND collection_id = ?'),
    versionCount: db.prepare('SELECT COUNT(*) AS n FROM board_versions WHERE collection_id = ?'),
    oldestAuto: db.prepare('SELECT id FROM board_versions WHERE collection_id = ? AND auto = 1 ORDER BY id LIMIT 1'),
    addVersion: db.prepare('INSERT INTO board_versions (collection_id, name, auto, data, created) VALUES (?, ?, ?, ?, ?)'),
    removeVersion: db.prepare('DELETE FROM board_versions WHERE id = ? AND collection_id = ?'),
    board: db.prepare('SELECT revision, data FROM boards WHERE collection_id = ?'),
    saveBoard: db.prepare(`INSERT INTO boards (collection_id, revision, data, updated) VALUES (?, ?, ?, ?)
                           ON CONFLICT (collection_id) DO UPDATE SET revision = excluded.revision,
                             data = excluded.data, updated = excluded.updated`),
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

  function inTransaction(fn) {
    db.exec('BEGIN');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  function uniqueName(fn) {
    try {
      return fn();
    } catch (err) {
      if (/UNIQUE/.test(err.message)) throw new CollectionError('You already have a collection with that name', 409);
      throw err;
    }
  }

  function storedBoard(cid) {
    const row = q.board.get(cid);
    return row ? { revision: row.revision, ...JSON.parse(row.data) } : { revision: 0, ...emptyBoard() };
  }

  // A copy of the board as saved. An automatic one makes room for itself by
  // dropping the oldest other automatic one; a named one is never dropped.
  function addBoardVersion(cid, name, auto) {
    if (q.versionCount.get(cid).n >= MAX_BOARD_VERSIONS) {
      const oldest = auto ? q.oldestAuto.get(cid) : null;
      if (!oldest) throw new CollectionError(`A board can keep up to ${MAX_BOARD_VERSIONS} versions. Delete one to save another`, 400);
      q.removeVersion.run(oldest.id, cid);
    }
    const { revision, ...board } = storedBoard(cid);
    const { lastInsertRowid } = q.addVersion.run(cid, name, auto ? 1 : 0, JSON.stringify(board), new Date().toISOString());
    return Number(lastInsertRowid);
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
    // Adds as many of docIds as fit, keeping the earliest in the list if they
    // don't all fit, and listing first among the collection's items in that
    // same order. Returns the ids added, and how many were there already or
    // wouldn't fit.
    addItems(owner, id, docIds) {
      owned(owner, id);
      const cid = Number(id);
      return inTransaction(() => {
        const fresh = docIds.filter(docId => !q.hasItem.get(cid, docId));
        const added = fresh.slice(0, Math.max(0, MAX_ITEMS - q.itemCount.get(cid).n));
        const now = new Date().toISOString();
        for (const docId of [...added].reverse()) q.addItem.run(cid, docId, now);
        return { added, already: docIds.length - fresh.length, over: fresh.length - added.length };
      });
    },
    removeItems(owner, id, docIds) {
      owned(owner, id);
      inTransaction(() => docIds.forEach(docId => q.removeItem.run(Number(id), docId)));
    },
    // The collection's board, or an empty one at revision 0.
    board(owner, id) {
      owned(owner, id);
      return storedBoard(Number(id));
    },
    // Replaces the board, if revision is the one the caller last read: saving
    // over a change made in another window would silently lose it. A document
    // can only be new to the board if it's in the collection; one already on
    // the board stays when it's removed from the collection, so that the
    // notes and connections around it aren't lost.
    saveBoard(owner, id, revision, input) {
      owned(owner, id);
      const cid = Number(id);
      const board = cleanBoard(input);
      return inTransaction(() => {
        const current = storedBoard(cid);
        if (revision !== current.revision) {
          throw new CollectionError('This board was changed in another window', 409);
        }
        const known = new Set(boardDocIds(current));
        if (boardDocIds(board).some(docId => !known.has(docId) && !q.hasItem.get(cid, docId))) {
          throw new CollectionError('Only documents in this collection can be added to its board', 400);
        }
        const next = current.revision + 1;
        q.saveBoard.run(cid, next, JSON.stringify(board), new Date().toISOString());
        return { revision: next };
      });
    },
    // Newest first, with how much each holds rather than its contents.
    boardVersions(owner, id) {
      owned(owner, id);
      return q.versions.all(Number(id)).map(v => {
        const board = JSON.parse(v.data);
        return {
          id: v.id, name: v.name, auto: Boolean(v.auto), created: v.created,
          cards: board.objects.length, groups: board.groups.length, connections: board.connections.length,
        };
      });
    },
    saveBoardVersion(owner, id, name, auto) {
      owned(owner, id);
      const clean = typeof name === 'string' ? name.trim() : '';
      if (!clean || clean.length > MAX_NAME) throw new CollectionError(`A name of 1 to ${MAX_NAME} characters is required`, 400);
      const cid = Number(id);
      return { id: inTransaction(() => addBoardVersion(cid, clean, auto === true)) };
    },
    // Replaces the board with a version, keeping what it replaces as an automatic
    // version. A version's documents were all on this board once, so unlike a
    // save, they needn't still be in the collection: their cards say if they aren't.
    restoreBoardVersion(owner, id, versionId, revision) {
      owned(owner, id);
      const cid = Number(id);
      const version = q.version.get(Number(versionId), cid);
      if (!version) throw new CollectionError('Version not found', 404);
      return inTransaction(() => {
        const current = storedBoard(cid);
        if (revision !== current.revision) throw new CollectionError('This board was changed in another window', 409);
        addBoardVersion(cid, `Before restoring ${version.name}`.slice(0, MAX_NAME), true);
        const next = current.revision + 1;
        q.saveBoard.run(cid, next, version.data, new Date().toISOString());
        return { revision: next };
      });
    },
    removeBoardVersion(owner, id, versionId) {
      owned(owner, id);
      q.removeVersion.run(Number(versionId), Number(id));
    },
    describe: () => dbPath,
  };
}

module.exports = { openCollections, CollectionError, MAX_ITEMS };
