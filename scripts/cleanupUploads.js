// scripts/cleanupUploads.js
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const Message = require("../schema_models/Message");
const Post = require("../schema_models/PostSchema");

const UPLOADS_DIR = path.join(__dirname, "..", "uploads");

const getAllUsedFiles = async () => {
  const messageMedia = await Message.find({ mediaUrl: { $exists: true } }).select("mediaUrl thumbnailUrl");
  const postMedia = await Post.find({ "media.url": { $exists: true } }).select("media");

  const usedFiles = new Set();

  for (const msg of messageMedia) {
    if (msg.mediaUrl) usedFiles.add(path.basename(msg.mediaUrl));
    if (msg.thumbnailUrl) usedFiles.add(path.basename(msg.thumbnailUrl));
  }

  for (const post of postMedia) {
    for (const media of post.media || []) {
      if (media.url) usedFiles.add(path.basename(media.url));
    }
  }

  return usedFiles;
};

const deleteOrphanFiles = async () => {
  const usedFiles = await getAllUsedFiles();
  const foldersToClean = ["chatmedia", "postmedia", "chatthumbnail", "profiles"];

  for (const folder of foldersToClean) {
    const folderPath = path.join(UPLOADS_DIR, folder);
    if (!fs.existsSync(folderPath)) continue;

    const users = fs.readdirSync(folderPath);
    for (const userDir of users) {
      const userFolder = path.join(folderPath, userDir);
      if (!fs.statSync(userFolder).isDirectory()) continue;

      const files = fs.readdirSync(userFolder);
      for (const file of files) {
        if (!usedFiles.has(file)) {
          const fullPath = path.join(userFolder, file);
          fs.unlinkSync(fullPath);
          console.log(`🧹 Deleted orphan file: ${fullPath}`);
        }
      }

      // Delete empty user folder
      if (fs.readdirSync(userFolder).length === 0) {
        fs.rmdirSync(userFolder);
        console.log(`🧹 Deleted empty folder: ${userFolder}`);
      }
    }
  }

  console.log("✅ Cleanup completed.");
};

mongoose.connect("mongodb://localhost:27017/sosholife", { useNewUrlParser: true, useUnifiedTopology: true }).then(async () => {
  await deleteOrphanFiles();
  mongoose.disconnect();
});
