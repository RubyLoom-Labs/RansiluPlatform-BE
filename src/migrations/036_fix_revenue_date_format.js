async function up(pool) {
  console.log('Running migration 036: Fix corrupted revenue date format...');

  const [rows] = await pool.query('SELECT id, date FROM revenue');

  let fixedCount = 0;
  for (const row of rows) {
    const raw = row.date;
    if (!raw) continue;

    const trimmed = String(raw).trim();

    // Already a clean ISO date (YYYY-MM-DD) - skip
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) continue;

    // Attempt to parse (handles truncated JS Date.toString() output like
    // "Tue Jul 28 2026 05:30:00 GMT+0530 (India Standard ")
    const parsed = new Date(trimmed);
    if (isNaN(parsed.getTime())) {
      console.warn(`Migration 036: Could not parse date for revenue id=${row.id}: "${trimmed}"`);
      continue;
    }

    const y = parsed.getFullYear();
    const m = String(parsed.getMonth() + 1).padStart(2, '0');
    const d = String(parsed.getDate()).padStart(2, '0');
    const isoDate = `${y}-${m}-${d}`;

    await pool.query('UPDATE revenue SET date = ? WHERE id = ?', [isoDate, row.id]);
    fixedCount++;
  }

  console.log(`Migration 036 completed successfully. Fixed ${fixedCount} revenue date value(s).`);

  // Also normalize any legacy artist_payments.period_label values that used the old
  // "YYYY.MM.DD to YYYY.MM.DD" range format instead of a single ISO date.
  const [tables] = await pool.query(`
    SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'artist_payments'
  `);
  if (tables.length > 0) {
    const [paymentRows] = await pool.query('SELECT id, period_label FROM artist_payments');
    let fixedPayments = 0;
    for (const row of paymentRows) {
      const label = row.period_label;
      if (!label) continue;
      const trimmed = String(label).trim();
      if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) continue; // already clean

      // Legacy "YYYY.MM.DD to YYYY.MM.DD" range - use the end date
      const rangeMatch = trimmed.match(/(\d{4})\.(\d{2})\.(\d{2})\s*to\s*(\d{4})\.(\d{2})\.(\d{2})/);
      let isoDate = null;
      if (rangeMatch) {
        isoDate = `${rangeMatch[4]}-${rangeMatch[5]}-${rangeMatch[6]}`;
      } else {
        const parsed = new Date(trimmed);
        if (!isNaN(parsed.getTime())) {
          const y = parsed.getFullYear();
          const m = String(parsed.getMonth() + 1).padStart(2, '0');
          const d = String(parsed.getDate()).padStart(2, '0');
          isoDate = `${y}-${m}-${d}`;
        }
      }

      if (isoDate) {
        await pool.query('UPDATE artist_payments SET period_label = ? WHERE id = ?', [isoDate, row.id]);
        fixedPayments++;
      } else {
        console.warn(`Migration 036: Could not parse period_label for artist_payments id=${row.id}: "${trimmed}"`);
      }
    }
    console.log(`Migration 036: Fixed ${fixedPayments} artist_payments period_label value(s).`);
  }
}

module.exports = { up };

