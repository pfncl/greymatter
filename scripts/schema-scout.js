#!/usr/bin/env node
require('../lib/resolve-deps');

/**
 * Schema Scout — Live SQLite database documentation generator.
 *
 * Walks a project root, discovers `.db` and `.sqlite` files, and writes
 * markdown docs of each database's tables, columns, foreign keys, and indexes.
 * Reads live runtime state — distinct from query.js --schema, which reads
 * graph nodes parsed from source schema.sql files.
 *
 * Usage:
 *   node schema-scout.js [--project <path>]
 *
 * Default: process.cwd(). Output: <project>/schemas/.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const SKIP_DIRS = new Set([
    'node_modules', '.git', '.svelte-kit', 'dist', 'build', 'coverage',
    'marked-for-deletion', 'tmp', '.cache',
]);
const DB_EXTENSIONS = new Set(['.db', '.sqlite']);

function parseArgs(argv) {
    const args = { project: process.cwd() };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--project' || a === '--root' || a === '--dir') {
            args.project = path.resolve(argv[++i]);
        }
    }
    return args;
}

function discoverDatabases(rootDir) {
    const found = [];
    function walk(dir) {
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (SKIP_DIRS.has(entry.name)) continue;
                walk(full);
            } else {
                const ext = path.extname(entry.name);
                if (!DB_EXTENSIONS.has(ext)) continue;
                if (entry.name.includes('.aidex')) continue;
                found.push(full);
            }
        }
    }
    walk(rootDir);
    return found;
}

function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function slugify(relPath) {
    return relPath.replace(/[\/\\]/g, '__').replace(/\.(db|sqlite)$/, '');
}

function extractSchema(dbPath, rootDir) {
    try {
        const db = new Database(dbPath, { readonly: true });
        const tables = db.prepare(
            `SELECT name FROM sqlite_master WHERE type='table' AND name != 'sqlite_sequence' ORDER BY name`
        ).all();

        const schema = {
            name: path.basename(dbPath),
            relativePath: path.relative(rootDir, dbPath),
            fileSize: formatBytes(fs.statSync(dbPath).size),
            tableCount: tables.length,
            tables: [],
        };

        for (const { name: tableName } of tables) {
            const columns = db.prepare(`PRAGMA table_info("${tableName}")`).all();
            const foreignKeys = db.prepare(`PRAGMA foreign_key_list("${tableName}")`).all();
            const indexList = db.prepare(`PRAGMA index_list("${tableName}")`).all();

            const indexes = [];
            for (const idx of indexList) {
                if (idx.name.startsWith('sqlite_autoindex_')) continue;
                const indexCols = db.prepare(`PRAGMA index_info("${idx.name}")`).all();
                indexes.push({
                    name: idx.name,
                    unique: idx.unique === 1,
                    columns: indexCols.map(c => c.name),
                });
            }

            let hasAutoincrement = false;
            try {
                const seqRow = db.prepare(`SELECT 1 FROM sqlite_sequence WHERE name = ?`).get(tableName);
                hasAutoincrement = !!seqRow;
            } catch {
                // sqlite_sequence absent — no autoincrement tables in this DB
            }

            schema.tables.push({
                name: tableName,
                columns: columns.map(col => ({
                    name: col.name,
                    type: col.type || 'ANY',
                    nullable: col.notnull === 0,
                    defaultValue: col.dflt_value,
                    pk: col.pk > 0,
                    autoincrement: col.pk > 0 && hasAutoincrement && col.type === 'INTEGER',
                })),
                foreignKeys: foreignKeys.map(fk => ({
                    from: fk.from,
                    table: fk.table,
                    to: fk.to,
                })),
                indexes,
            });
        }

        db.close();
        return schema;
    } catch (err) {
        console.log(`  FAIL ${path.relative(rootDir, dbPath)} — ${err.message}`);
        return null;
    }
}

function schemaToMarkdown(schema) {
    const today = new Date().toISOString().split('T')[0];
    const lines = [];
    lines.push(`# ${schema.name}`);
    lines.push('');
    lines.push(`> Path: \`${schema.relativePath}\``);
    lines.push(`> Size: ${schema.fileSize} | Tables: ${schema.tableCount} | Generated: ${today}`);
    lines.push('');

    for (const table of schema.tables) {
        lines.push(`## ${table.name}`);
        lines.push('');
        lines.push('| Column | Type | Nullable | Default | PK |');
        lines.push('|--------|------|----------|---------|----|');
        for (const col of table.columns) {
            const nullable = col.nullable ? 'YES' : 'NO';
            const def = col.defaultValue !== null ? `\`${col.defaultValue}\`` : '—';
            let pk = '';
            if (col.pk) pk = col.autoincrement ? 'YES (autoincrement)' : 'YES';
            lines.push(`| ${col.name} | ${col.type} | ${nullable} | ${def} | ${pk} |`);
        }
        lines.push('');

        if (table.foreignKeys.length > 0) {
            const fkList = table.foreignKeys.map(
                fk => `\`${fk.from}\` → \`${fk.table}\`(\`${fk.to}\`)`
            );
            lines.push(`**Foreign Keys:** ${fkList.join(', ')}`);
        } else {
            lines.push('**Foreign Keys:** none');
        }
        lines.push('');

        if (table.indexes.length > 0) {
            lines.push('**Indexes:**');
            for (const idx of table.indexes) {
                const unique = idx.unique ? ' UNIQUE' : '';
                lines.push(`- \`${idx.name}\` ON (${idx.columns.join(', ')})${unique}`);
            }
        } else {
            lines.push('**Indexes:** none');
        }

        lines.push('');
        lines.push('---');
        lines.push('');
    }

    return lines.join('\n');
}

function generateReadme(rootDir, results) {
    const today = new Date().toISOString().split('T')[0];
    const lines = [];
    lines.push('# Database Schemas');
    lines.push('');
    lines.push(`> Generated: ${today} | Run \`node greymatter/scripts/schema-scout.js --project ${rootDir}\` to regenerate`);
    lines.push('');
    lines.push('| Database | File | Tables | Size |');
    lines.push('|----------|------|--------|------|');
    for (const { schema, outputName } of results) {
        lines.push(`| \`${schema.relativePath}\` | [${outputName}.md](${outputName}.md) | ${schema.tableCount} | ${schema.fileSize} |`);
    }
    lines.push('');
    return lines.join('\n');
}

function main() {
    const startTime = Date.now();
    const args = parseArgs(process.argv.slice(2));
    const rootDir = args.project;
    const schemasDir = path.join(rootDir, 'schemas');

    console.log(`Schema Scout — scanning ${rootDir}\n`);

    const databases = discoverDatabases(rootDir);
    if (databases.length === 0) {
        console.log('No SQLite databases found.');
        return;
    }
    console.log(`Found ${databases.length} databases\n`);

    fs.mkdirSync(schemasDir, { recursive: true });
    const results = [];

    for (const dbPath of databases) {
        const schema = extractSchema(dbPath, rootDir);
        if (!schema) continue;

        const outputName = slugify(schema.relativePath);
        const outputPath = path.join(schemasDir, `${outputName}.md`);
        fs.writeFileSync(outputPath, schemaToMarkdown(schema));
        console.log(`  OK   ${outputName}.md (${schema.tableCount} tables)`);
        results.push({ schema, outputName });
    }

    fs.writeFileSync(path.join(schemasDir, 'README.md'), generateReadme(rootDir, results));
    console.log(`  OK   README.md`);

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\nDone: ${results.length} databases documented (${elapsed}s)`);
}

main();
