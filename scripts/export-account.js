// Export one product's data for one account, before deletion or on
// request: one CSV file per table, covering exactly the tables and rows
// the 60-day deletion would remove (same lists as src/retention.js).
// Run by IGC; the files contain the customer's personal data, so send
// them securely and delete the local copy afterward.
//
//   node scripts/export-account.js <accountId> <care360|element_profile> [outputDir]
//
// Default output: exports/<accountId>-<product>-<date>/ (gitignored).
require('dotenv').config({ quiet: true });
const fs   = require('fs');
const path = require('path');
const supabase  = require('../src/db/client');
const retention = require('../src/retention');

const PAGE = 1000;

function csvCell(value) {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function toCsv(rows) {
  if (!rows.length) return '';
  const columns = [...new Set(rows.flatMap(r => Object.keys(r)))];
  return [columns.join(','), ...rows.map(r => columns.map(c => csvCell(r[c])).join(','))].join('\n') + '\n';
}

// All rows, a page at a time. build(query) adds the filter, or returns
// null when there's nothing to match.
async function fetchAll(table, build) {
  const rows = [];
  for (let from = 0; ; from += PAGE) {
    const q = build(supabase.from(table).select('*'));
    if (!q) return rows;
    const { data, error } = await q.range(from, from + PAGE - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    rows.push(...data);
    if (data.length < PAGE) return rows;
  }
}

(async () => {
  const [accountId, product, outArg] = process.argv.slice(2);
  if (!accountId || !retention.PRODUCTS.includes(product)) {
    console.error('Usage: node scripts/export-account.js <accountId> <care360|element_profile> [outputDir]');
    process.exit(1);
  }
  const { data: account, error } = await supabase.from('accounts').select('id, name').eq('id', accountId).maybeSingle();
  if (error) throw error;
  if (!account) { console.error('No account with that id.'); process.exit(1); }

  const outDir = outArg || path.join(__dirname, '..', 'exports', `${accountId}-${product}-${new Date().toISOString().slice(0, 10)}`);
  fs.mkdirSync(outDir, { recursive: true });

  const { tables: tableList, ids } = await retention.productTables(accountId, product);
  const tables = tableList.map(([t, filters]) => [t, q => retention.matching(q, filters, ids)]);

  let total = 0;
  for (const [table, build] of tables) {
    const rows = await fetchAll(table, build);
    if (!rows.length) continue;
    fs.writeFileSync(path.join(outDir, `${table}.csv`), toCsv(rows));
    console.log(`  ${table}.csv  ${rows.length} rows`);
    total += rows.length;
  }
  console.log(`Exported ${total} rows of ${product} data for "${account.name}" to ${outDir}`);
})().catch(e => { console.error('Export failed:', e.message); process.exit(1); });
