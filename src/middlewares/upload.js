const multer = require('multer');
const path = require('path');
const fs = require('fs');

// Ensure upload directories exist
const uploadDirs = {
  images: path.join(__dirname, '../../uploads/images'),
  audio: path.join(__dirname, '../../uploads/audio'),
  documents: path.join(__dirname, '../../uploads/documents'),
};

for (const dir of Object.values(uploadDirs)) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// Configure storage
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    if (file.fieldname === 'track') {
      cb(null, uploadDirs.audio);
    } else if (file.fieldname === 'image' || file.fieldname === 'art' || file.fieldname === 'logo' || file.fieldname === 'profile_image') {
      cb(null, uploadDirs.images);
    } else {
      // Default to documents directory for any document/other uploads
      cb(null, uploadDirs.documents);
    }
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, (file.fieldname || 'doc') + '-' + uniqueSuffix + path.extname(file.originalname));
  },
});

// File validation helper
const fileFilter = (req, file, cb) => {
  cb(null, true);
};

const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 25 * 1024 * 1024, // 25MB limit
  },
});

module.exports = upload;
