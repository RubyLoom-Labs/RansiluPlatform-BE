const multer = require('multer');
const path = require('path');
const fs = require('fs');

// Ensure upload directories exist
const uploadDirs = {
  images: path.join(__dirname, '../../uploads/images'),
  audio: path.join(__dirname, '../../uploads/audio'),
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
    } else if (file.fieldname === 'image' || file.fieldname === 'art' || file.fieldname === 'logo') {
      cb(null, uploadDirs.images);
    } else {
      cb(new Error('Unexpected field name for upload'), null);
    }
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  },
});

// File validation helper
const fileFilter = (req, file, cb) => {
  if (file.fieldname === 'track') {
    // Expect MP3 audio file
    if (file.mimetype === 'audio/mpeg' || file.originalname.endsWith('.mp3')) {
      cb(null, true);
    } else {
      cb(new Error('Only MP3 tracks are allowed!'), false);
    }
  } else if (file.fieldname === 'image' || file.fieldname === 'art' || file.fieldname === 'logo') {
    // Expect Image file or PDF (since company logo could be a PDF)
    if (file.mimetype.startsWith('image/') || file.mimetype === 'application/pdf' || file.originalname.endsWith('.pdf')) {
      cb(null, true);
    } else {
      cb(new Error('Only images and PDF files are allowed!'), false);
    }
  } else {
    cb(new Error('Unknown upload field'), false);
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 15 * 1024 * 1024, // 15MB limit
  },
});

module.exports = upload;
