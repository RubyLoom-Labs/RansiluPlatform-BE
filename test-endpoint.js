const http = require('http');

http.get('http://localhost:5000/api/artists/3', (res) => {
  let data = '';
  res.on('data', (chunk) => { data += chunk; });
  res.on('end', () => {
    console.log("RESPONSE FROM ARTIST API:");
    console.log(JSON.stringify(JSON.parse(data), null, 2));
  });
}).on('error', (err) => {
  console.error("Error calling API:", err.message);
});
