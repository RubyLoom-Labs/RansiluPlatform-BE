async function up(pool) {
  console.log('Running migration 019: Add ownership_type to ownershipsong table...');

  const [cols] = await pool.query("SHOW COLUMNS FROM ownershipsong LIKE 'ownership_type'");
  if (cols.length === 0) {
    await pool.query(`
      ALTER TABLE ownershipsong
      ADD COLUMN ownership_type VARCHAR(100) NULL AFTER ownership_id;
    `);
    console.log('Column ownership_type added to ownershipsong successfully.');
  } else {
    console.log('Column ownership_type already exists in ownershipsong.');
  }
}

module.exports = { up };
