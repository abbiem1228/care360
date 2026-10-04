// Data retention dry run. Shows every product whose subscription has
// ended, where it stands, and exactly what deleting it would remove,
// with row counts per table. Reads only: deletes nothing, emails no one,
// writes nothing.
//
//   node scripts/retention-dry-run.js
require('dotenv').config({ quiet: true });
const retention = require('../src/retention');

(async () => {
  const opts = { allowMissingLog: true };
  const assessed = await retention.assessAll(new Date(), opts);
  const items = [];
  for (const a of assessed) {
    for (const product of retention.PRODUCTS) {
      const s = a.products[product];
      if (['keep', 'none'].includes(s.status)) {
        console.log(`${a.accountName} | ${product}: ${s.status}${s.reason ? ` (${s.reason})` : ''}`);
        continue;
      }
      items.push(await retention.dryRun(a.accountId, product, new Date(), opts));
    }
  }
  console.log(`\nAccounts with any subscription: ${assessed.length}`);
  if (!items.length) { console.log('Nothing has ended. Nothing would be deleted.'); return; }
  for (const i of items) {
    console.log(`\n${i.accountName} (${i.accountId}) | ${i.product}: ${i.status}, ${i.state} since ${i.endedOn}, deletion date ${i.deletionDate}${i.warnedOn ? `, warned ${i.warnedOn}` : ''}`);
    for (const [t, n] of Object.entries(i.counts)) if (n) console.log(`    would delete ${t}: ${n}`);
    console.log(i.deletesAccount ? `    and the account: ${JSON.stringify(i.accountCounts)}` : '    account and login stay');
  }
})().catch(e => { console.error('Dry run failed:', e.message); process.exit(1); });
