import { mkdir, open, writeFile } from 'node:fs/promises';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { displayMoney } from './engine.js';

export async function createOutput(mode, root = 'output', now = new Date()) {
  const pad = x => String(x).padStart(2, '0');
  const year = now.getFullYear(), month = pad(now.getMonth() + 1), day = pad(now.getDate());
  const directory = path.resolve(root, `${month}-${day}-${year}`, `${year}-${month}-${day}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`);
  await mkdir(path.dirname(directory), { recursive: true });
  await mkdir(directory); // Do not overwrite another run from the same second.
  await mkdir(path.join(directory, 'logs'));
  const detail = await open(path.join(directory, 'logs/recommendation-details.jsonl'), 'ax');
  const snapshot = mode === 'write' ? await open(path.join(directory, 'pre-write-snapshot.jsonl'), 'ax') : null;
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ filename: path.join(directory, 'recommendations-audit.xlsx'), useStyles: true });
  const sheet = workbook.addWorksheet('Recommendations', { views: [{ state: 'frozen', ySplit: 1 }] });
  sheet.columns = ['Source SKU', 'Source Product', 'Source Size', 'Source Price', ...Array.from({ length: 4 }, (_, i) => [`Recommendation ${i + 1}`, `Price ${i + 1}`]).flat()]
    .map(header => ({ header, key: header, width: header.includes('Price') ? 16 : 38 }));
  sheet.getRow(1).font = { bold: true };
  sheet.autoFilter = 'A1:L1';
  const writes = mode === 'write' ? new ExcelJS.stream.xlsx.WorkbookWriter({ filename: path.join(directory, 'write-results.xlsx') }) : null;
  const writeSheet = writes?.addWorksheet('Write results');
  if (writeSheet) writeSheet.columns = ['Owner ID', 'Metafield', 'Status', 'Variant IDs', 'Error'].map(header => ({ header, width: 38 }));
  let finished = false;
  return {
    directory,
    async log(record) { await detail.write(`${JSON.stringify({ timestamp: new Date().toISOString(), ...record })}\n`); },
    async snapshot(record) { if (!snapshot) throw new Error('Snapshot unavailable in audit mode.'); await snapshot.write(`${JSON.stringify(record)}\n`); await snapshot.sync(); },
    audit(source, selected) {
      const row = [source.sku, source.title, source.size, displayMoney(source.price)];
      for (let i = 0; i < 4; i++) row.push(selected[i]?.label || '', selected[i] ? displayMoney(selected[i].price) : null);
      sheet.addRow(row).commit();
    },
    writeResult(source, status, ids = [], error = '') { writeSheet?.addRow([source.ownerId, `ornate.${source.key}`, status, ids.join(', '), error]).commit(); },
    async finish(summary) {
      if (finished) return; finished = true;
      try {
        sheet.commit(); await workbook.commit();
        if (writes) { writeSheet.commit(); await writes.commit(); }
        await writeFile(path.join(directory, 'run-summary.json'), JSON.stringify(summary, null, 2));
      } finally { await detail.close(); await snapshot?.close(); }
    }
  };
}
