async function up(pool) {
  console.log('Running migration 031: Add remain_revenue column to revenue table...');

  // Add remain_revenue column if it does not already exist
  const [columns] = await pool.query(`
    SELECT COLUMN_NAME 
    FROM INFORMATION_SCHEMA.COLUMNS 
    WHERE TABLE_SCHEMA = DATABASE() 
      AND TABLE_NAME = 'revenue' 
      AND COLUMN_NAME = 'remain_revenue'
  `);

  if (columns.length === 0) {
    await pool.query(`
      ALTER TABLE revenue 
      ADD COLUMN remain_revenue DECIMAL(12, 2) DEFAULT 0.00 
      AFTER amount
    `);
    console.log('Column remain_revenue added to revenue table.');
  } else {
    console.log('Column remain_revenue already exists. Skipping ALTER.');
  }

  console.log('Migration 031 completed successfully.');
}

module.exports = { up };
