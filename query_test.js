const mysql = require('mysql2/promise');
require('dotenv').config();

async function check() {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME
  });

  console.log("CONNECTED TO DB");
  const [songs] = await connection.query("SELECT * FROM songs");
  console.log("\n--- SONGS ---");
  console.log(songs);

  const [singers] = await connection.query("SELECT * FROM songSinger");
  console.log("\n--- songSinger ---");
  console.log(singers);

  const [artists] = await connection.query("SELECT * FROM artists");
  console.log("\n--- artists ---");
  console.log(artists);

  await connection.end();
}

check().catch(console.error);
