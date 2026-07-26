async function up(pool) {
  console.log('Running migration 032: Add status and is_delete columns to revenue table...');

  const [colsStatus] = await pool.query(`
    SELECT COLUMN_NAME 
    FROM INFORMATION_SCHEMA.COLUMNS 
    WHERE TABLE_SCHEMA = DATABASE() 
      AND TABLE_NAME = 'revenue' 
      AND COLUMN_NAME = 'status'
  `);

  if (colsStatus.length === 0) {
    await pool.query(`
      ALTER TABLE revenue 
      ADD COLUMN status INT DEFAULT 1 AFTER remain_revenue
    `);
    console.log('Column status added to revenue table.');
  }

  const [colsIsDelete] = await pool.query(`
    SELECT COLUMN_NAME 
    FROM INFORMATION_SCHEMA.COLUMNS 
    WHERE TABLE_SCHEMA = DATABASE() 
      AND TABLE_NAME = 'revenue' 
      AND COLUMN_NAME = 'is_delete'
  `);

  if (colsIsDelete.length === 0) {
    await pool.query(`
      ALTER TABLE revenue 
      ADD COLUMN is_delete INT DEFAULT 0 AFTER status
    `);
    console.log('Column is_delete added to revenue table.');
  }

  await pool.query(`UPDATE revenue SET status = 1 WHERE status IS NULL`);
  await pool.query(`UPDATE revenue SET is_delete = 0 WHERE is_delete IS NULL`);

  console.log('Migration 032 completed successfully.');
}

module.exports = { up };
