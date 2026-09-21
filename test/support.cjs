const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { DatabaseSync } = require('node:sqlite');
const ts = require('typescript');

function database(schema = fs.readFileSync('src/db/schema.sql', 'utf8')) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  sqlite.exec(schema);
  const db = {
    sqlite,
    prepare(sql) {
      let args = [];
      return {
        bind(...values) { args = values; return this; },
        async first() { return sqlite.prepare(sql).get(...args) ?? null; },
        async all() { return { results: sqlite.prepare(sql).all(...args) }; },
        run() { return Promise.resolve(this.execute()); },
        execute() {
          const stmt = sqlite.prepare(sql);
          const results = stmt.columns().length ? stmt.all(...args) : (stmt.run(...args), []);
          return { results, meta: { changes: sqlite.prepare('SELECT changes() AS n').get().n } };
        },
      };
    },
    async batch(statements) {
      sqlite.exec('BEGIN');
      try {
        const result = statements.map(s => s.execute());
        sqlite.exec('COMMIT');
        return result;
      } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
  };
  return db;
}

function loader(mocks = {}, globals = {}) {
  const cache = new Map();
  function load(file) {
    const absolute = path.resolve(file);
    const key = path.relative(process.cwd(), absolute).replaceAll('\\', '/');
    if (mocks[key]) return mocks[key];
    if (cache.has(absolute)) return cache.get(absolute).exports;
    const module = { exports: {} };
    cache.set(absolute, module);
    const source = ts.transpileModule(fs.readFileSync(absolute, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    vm.runInNewContext(source, {
      module, exports: module.exports, console, Date, setTimeout, clearTimeout, crypto,
      AbortSignal, fetch, Response, Request, URL, TextEncoder, btoa,
      ...globals,
      require: name => name.startsWith('.') ? load(path.resolve(path.dirname(absolute), name + '.ts')) : require(name),
    }, { filename: absolute });
    return module.exports;
  }
  return load;
}

const slip = (ref = null) => ({ amount: 100, currency: 'THB', datetime: null, bank: null,
  receiver: 'Shop', trans_ref: ref, category: 'Other', confidence: 1 });
async function fixture(db, repo, group = 'g') {
  const user = await repo.upsertUser(db, 1, 'Test', 'local', 'member');
  const batch = await repo.claimBatch(db, user.id, group, 1, null);
  await repo.addBatchItem(db, batch.id, 1, 'file');
  const [item] = await repo.listBatchItems(db, batch.id);
  return { user, batch, item };
}
module.exports = { database, loader, fixture, slip };
