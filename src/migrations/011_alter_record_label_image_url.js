async function up(pool) {
  console.log('Running migration 011: Modify record_label image_url and ringintone company_logo columns to LONGTEXT...');

  await pool.query(`
    ALTER TABLE record_label MODIFY COLUMN image_url LONGTEXT NULL;
  `);

  await pool.query(`
    ALTER TABLE ringintone MODIFY COLUMN company_logo LONGTEXT NULL;
  `);

  console.log('Migration 011 completed successfully.');
}

module.exports = { up };
