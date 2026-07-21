async function up(pool) {
  console.log('Running migration 009: Replace simple UNIQUE on ringintone.name with application-level validation...');
  console.log('This allows re-creating a ringtone with the same name as a soft-deleted one.');

  // Drop the existing UNIQUE constraint on the name column.
  // MySQL doesn't support conditional/partial unique indexes, so uniqueness
  // among non-deleted records is enforced at the application level in
  // ringtoneController.createRingtone and ringtoneController.updateRingtone
  // using: WHERE LOWER(name) = ? AND is_deleted = 0
  try {
    await pool.query('ALTER TABLE ringintone DROP INDEX name');
  } catch (err) {
    if (err.code === 'ER_CANT_DROP_FIELD_OR_KEY') {
      console.log('UNIQUE index on ringintone.name does not exist, skipping.');
    } else {
      throw err;
    }
  }

  console.log('Migration 009 completed successfully.');
}

module.exports = { up };
