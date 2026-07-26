const { getPool } = require('../config/db');

async function up(pool) {
  console.log('Running migration 034: Add distributor_amount column to revenue table...');

  // Check if distributor_amount column exists
  const [cols] = await pool.query(`
    SELECT COLUMN_NAME 
    FROM INFORMATION_SCHEMA.COLUMNS 
    WHERE TABLE_SCHEMA = DATABASE() 
      AND TABLE_NAME = 'revenue' 
      AND COLUMN_NAME = 'distributor_amount'
  `);

  if (cols.length === 0) {
    console.log('Adding distributor_amount column to revenue table...');
    await pool.query(`
      ALTER TABLE revenue 
      ADD COLUMN distributor_amount DECIMAL(12, 2) DEFAULT 0.00 
      AFTER amount
    `);

    // Backfill existing rows:
    // distributor_amount = amount * 0.30
    // remain_revenue = (amount * 0.70) * ((is_recordlabel * 50 + is_lyrics * 25 + is_musician * 25) / 100)
    console.log('Backfilling distributor_amount and updating remain_revenue for existing revenue records...');
    await pool.query(`
      UPDATE revenue r
      JOIN songs s ON r.song_id = s.id
      SET 
        r.distributor_amount = ROUND(r.amount * 0.30, 2),
        r.remain_revenue = ROUND(
          (r.amount * 0.70) * (
            (IF(s.is_recordlabel = 1 OR s.is_recordlabel = '1' OR s.is_recordlabel IS TRUE, 50, 0) +
             IF(s.is_lyrics = 1 OR s.is_lyrics = '1' OR s.is_lyrics IS TRUE, 25, 0) +
             IF(s.is_musician = 1 OR s.is_musician = '1' OR s.is_musician IS TRUE, 25, 0)) / 100.0
          ), 2
        )
    `);
  } else {
    console.log('Column distributor_amount already exists. Skipping ALTER.');
  }

  console.log('Migration 034 completed successfully.');
}

module.exports = { up };
