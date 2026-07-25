async function up(pool) {
  console.log('Running migration 023: Create notesandcases and situation tables...');

  try {
    // 1. Create notesandcases table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS notesandcases (
        id INT AUTO_INCREMENT PRIMARY KEY,
        type ENUM('note', 'case') NOT NULL DEFAULT 'case',
        name VARCHAR(255) NOT NULL,
        description TEXT DEFAULT NULL,
        tags TEXT DEFAULT NULL,
        priority ENUM('high', 'medium', 'low', 'neutral') NOT NULL DEFAULT 'medium',
        link_type VARCHAR(255) DEFAULT NULL,
        link_result VARCHAR(255) DEFAULT NULL,
        start_date DATE DEFAULT NULL,
        end_date DATE DEFAULT NULL,
        status TINYINT(1) DEFAULT 1,
        is_delete TINYINT(1) DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);
    console.log('Table notesandcases verified/created successfully.');

    // 2. Create situation table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS situation (
        id INT AUTO_INCREMENT PRIMARY KEY,
        notesandcase_id INT NOT NULL,
        order_id INT DEFAULT 1,
        description TEXT NOT NULL,
        start_date DATE DEFAULT NULL,
        end_date DATE DEFAULT NULL,
        status TINYINT(1) DEFAULT 1,
        is_delete TINYINT(1) DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        CONSTRAINT fk_situation_notesandcase FOREIGN KEY (notesandcase_id) REFERENCES notesandcases(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);
    console.log('Table situation verified/created successfully.');

    // Seed initial records if empty
    const [existing] = await pool.query(`SELECT COUNT(*) as cnt FROM notesandcases`);
    if (existing[0].cnt === 0) {
      console.log('Seeding initial records into notesandcases and situation tables...');

      // Seed 5 Cases
      const casesData = [
        {
          name: 'Case One',
          type: 'case',
          tags: 'Youtube, name',
          description: 'Dispute regarding YouTube content claim for song melody.',
          priority: 'high',
          link_type: 'Songs',
          link_result: 'Song Name Shinhala',
          start_date: '2026-06-15',
          end_date: '2026-07-02',
          situations: [
            { order_id: 1, start_date: '2026-06-15', end_date: '2026-06-20', description: 'Initial dispute raised regarding digital distribution rights on streaming channels.' },
            { order_id: 2, start_date: '2026-07-02', end_date: '2026-07-10', description: 'Documentation collected and sent to legal consultants for draft review.' }
          ]
        },
        {
          name: 'Case Two',
          type: 'case',
          tags: 'Youtube, publishing',
          description: 'Dispute regarding music synchronization license and publishing royalty splits.',
          priority: 'medium',
          link_type: 'Songs',
          link_result: 'Amma Shinhala Melody',
          start_date: '2026-06-20',
          end_date: '2026-06-25',
          situations: [
            { order_id: 1, start_date: '2026-06-20', end_date: '2026-06-25', description: 'Licensing claim logged by co-writer regarding split percentages.' }
          ]
        },
        {
          name: 'Case Three',
          type: 'case',
          tags: 'Infringement, sampling',
          description: 'Copyright infringement notice received for unauthorized sampling.',
          priority: 'high',
          link_type: 'Songs',
          link_result: 'Oba Asana Geetha',
          start_date: '2026-05-18',
          end_date: '2026-05-25',
          situations: [
            { order_id: 1, start_date: '2026-05-18', end_date: '2026-05-25', description: 'Notice of potential claim received from claimant publishers.' }
          ]
        },
        {
          name: 'Case Four',
          type: 'case',
          tags: 'Contract, audit',
          description: 'Record label split contract dispute and publishing collection mismatch.',
          priority: 'low',
          link_type: 'Singer',
          link_result: 'Costa',
          start_date: '2026-07-01',
          end_date: '2026-07-05',
          situations: [
            { order_id: 1, start_date: '2026-07-01', end_date: '2026-07-05', description: 'Internal audit triggered to review distributor payouts.' }
          ]
        },
        {
          name: 'Case Five',
          type: 'case',
          tags: 'Mechanical, Radio',
          description: 'Mechanical rights distribution mismatch regarding public performance royalty calculations.',
          priority: 'neutral',
          link_type: 'Recode Label',
          link_result: 'Ransilu Music Group',
          start_date: '2026-07-10',
          end_date: '2026-07-15',
          situations: [
            { order_id: 1, start_date: '2026-07-10', end_date: '2026-07-15', description: 'Royalty invoice mismatch logged for radio streaming broadcasts.' }
          ]
        }
      ];

      for (const item of casesData) {
        const [res] = await pool.query(
          `INSERT INTO notesandcases (type, name, description, tags, priority, link_type, link_result, start_date, end_date, status, is_delete)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0)`,
          [item.type, item.name, item.description, item.tags, item.priority, item.link_type, item.link_result, item.start_date, item.end_date]
        );
        const caseId = res.insertId;

        for (const sit of item.situations) {
          await pool.query(
            `INSERT INTO situation (notesandcase_id, order_id, description, start_date, end_date, status, is_delete)
             VALUES (?, ?, ?, ?, ?, 1, 0)`,
            [caseId, sit.order_id, sit.description, sit.start_date, sit.end_date]
          );
        }
      }

      // Seed 2 Notes
      const notesData = [
        {
          name: 'Distribution Memo',
          type: 'note',
          tags: 'Youtube, distribution',
          description: 'Memo regarding future distribution account requirements and streaming checklist updates.',
          priority: 'medium',
          link_type: 'Others',
          link_result: 'Checklist #101',
          start_date: '2026-07-12'
        },
        {
          name: 'Contractual Review Note',
          type: 'note',
          tags: 'Legal, Review',
          description: 'Ensure all upcoming singer agreements include digital sync permissions.',
          priority: 'high',
          link_type: 'Singer',
          link_result: 'Kasun Kalhara',
          start_date: '2026-07-14'
        }
      ];

      for (const item of notesData) {
        await pool.query(
          `INSERT INTO notesandcases (type, name, description, tags, priority, link_type, link_result, start_date, status, is_delete)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 0)`,
          [item.type, item.name, item.description, item.tags, item.priority, item.link_type, item.link_result, item.start_date]
        );
      }

      console.log('Seeded notesandcases and situation initial records successfully.');
    }
  } catch (error) {
    console.error('Error running migration 023:', error);
    throw error;
  }
}

module.exports = { up };
