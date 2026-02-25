const express = require('express');
const router = express.Router();
const { uploadProfile } = require('../middleware/upload');
const fetchUser = require('../middleware/fetchuser');

router.post('/chat', fetchUser, uploadProfile, (req, res) => {

  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const fileUrl = `/uploads/profiles/${req.user.id}/${req.file.filename}`;
  res.json({ url: fileUrl });
});

module.exports = router;
