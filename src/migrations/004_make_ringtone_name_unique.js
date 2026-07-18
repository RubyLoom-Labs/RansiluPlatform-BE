async function up(pool) {
  console.log('Running migration 004: Making ringtone name column unique...');
  
  // Clean up any duplicate records just in case before applying unique constraint
  try {
    await pool.query(`
      DELETE r1 FROM ringintone r1
      INNER JOIN ringintone r2 
      WHERE r1.id < r2.id AND LOWER(TRIM(r1.name)) = LOWER(TRIM(r2.name));
    `);
  } catch (err) {
    console.warn('Failed to clean duplicate ringtones before migration:', err.message);
  }

  // Make the name column UNIQUE
  await pool.query("ALTER TABLE ringintone MODIFY COLUMN name VARCHAR(255) NOT NULL UNIQUE;");
}

module.exports = {
  up,
};
