require('dotenv').config();
const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const fsPromises = fs.promises;
const PostSchema = require('../models/Posts');
var fetchUser = require('../middleware/fetchuser');
const { body, validationResult } = require('express-validator');
const {
    createUploadMiddleware,
    generatePublicUrl,
} = require("../middleware/upload");
const Activity = require('../models/Activity');
const User = require('../models/User');
const calculatePostsReward = require('../utils/tierCalculation/calculatePostsReward');
const Profile = require('../models/Profile');
const Comment = require('../models/Comment');
const compressFile = require("../utils/compressFile");
const Notification = require('../models/Notification');
const { getIO } = require('../sockets/IOsocket');
const { sendPushToUser } = require('../utils/pushService');
const notifyUser = require('../utils/notifyUser');
const moderateMedia = require('../utils/moderateMedia');
const sanitizeHtml = require('sanitize-html');
const mongoose = require('mongoose');
const DEFAULT_LIMIT = 20;
const MAX_LIMIT     = 50;

const getBaseUrl = (req) => {
    return process.env.NODE_ENV === "production"
        ? "https://api.sosholife.com"
        : `${req.protocol}://${req.get("host")}`;
};

// Route 1: Get posts with cursor pagination
router.get('/fetchallposts', fetchUser, async (req, res) => {
  try {
    // Parse pagination params
    const limit  = Math.min(parseInt(req.query.limit ?? DEFAULT_LIMIT, 10), MAX_LIMIT);
    const before = req.query.before; // ObjectId of the last post from previous page

    // Build query
    const query = {
      $or: [{ visibility: 'public' }, { user_id: req.user.id }],
    };

    // Cursor: only fetch posts older than the last seen
    if (before && mongoose.Types.ObjectId.isValid(before)) {
      query._id = { $lt: new mongoose.Types.ObjectId(before) };
    }

    // Use lean() for a plain JS object (much faster than full Mongoose hydration)
    const posts = await PostSchema.find(query)
      .populate('user_id', 'name subscription')
      .sort({ _id: -1 }) // Use _id for stable cursor pagination
      .limit(limit)
      .lean();

    // Batch-fetch profiles for all post authors
    const userIds  = [...new Set(posts.map((p) => p.user_id?._id?.toString()).filter(Boolean))];
    const profiles = await Profile.find({ user_id: { $in: userIds } }).lean();
    const profileMap = Object.fromEntries(profiles.map((p) => [p.user_id.toString(), p]));

    // Merge avatar into post objects
    const postsWithAvatars = posts.map((p) => {
      const uid     = p.user_id?._id?.toString();
      const profile = uid ? profileMap[uid] : null;
      return {
        ...p,
        profileavatar: profile?.profileavatar?.URL ?? null,
      };
    });

    // Return cursor for the next page
    const lastPost   = posts[posts.length - 1];
    const nextCursor = posts.length === limit ? lastPost?._id?.toString() : null;

    res.json({
      posts: postsWithAvatars,
      pagination: {
        limit,
        nextCursor,         // Pass as `?before=nextCursor` in the next request
        hasMore: !!nextCursor,
      },
    });
  } catch (error) {
    console.error('[posts] fetchallposts error:', error.message);
    res.status(500).json({ message: 'Internal Server Error' });
  }
});

//Route 2: Add Posts using: POST "/api/posts/addnewposts". Login required
router.post(
    "/addnewposts",
    fetchUser,
    createUploadMiddleware("postmedia").array("media", 5),
    [
        body('visibility').optional().isIn(['public', 'private', 'friends']).withMessage('Invalid visibility type'),
    ],
    async (req, res) => {
        try {
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                return res.status(400).json({ errors: errors.array() });
            }

            const files = req.files || [];
            const cleanPost = sanitizeHtml(req.body.post || " ");
            const baseUrl = getBaseUrl(req);

            // Build initial media array from raw uploaded files (fast — no processing yet)
            // FIX: generatePublicUrl(req, subDir, userId, filename) — pass all 4 args correctly.
            const initialMedia = files.map(file => {
                const subDir = 'postmedia';
                const userId = req.user.id;
                const url = generatePublicUrl(req, subDir, userId, file.filename);
                return {
                    url,
                    type: file.mimetype.startsWith('image') ? 'image'
                        : file.mimetype.startsWith('video') ? 'video' : 'file',
                    mimeType: file.mimetype,
                    thumbnail: null,
                };
            });

            // Save post immediately with uncompressed URLs — client gets a fast response.
            const newpost = new PostSchema({
                user_id: req.user.id,
                post: cleanPost,
                visibility: req.body.visibility || 'public',
                media: initialMedia,
                moderation: { status: 'queued', labels: [], score: 0 }
            });

            const savePost = await newpost.save();

            // Respond immediately so the client doesn't time out.
            res.json({
                message: 'Post created',
                post: savePost,
            });

            // ── Background: compress + moderate (non-blocking, after response sent) ──
            if (files.length > 0) {
                setImmediate(async () => {
                    try {
                        // Compression
                        const processedMedia = [];
                        for (const file of files) {
                            try {
                                const { filePath, mimetype, thumbnails } = await compressFile(file.path, file.mimetype);
                                const subDir = 'postmedia';
                                const userId = req.user.id;
                                const filename = path.basename(filePath);
                                const url = generatePublicUrl(req, subDir, userId, filename);
                                const thumbUrl = thumbnails[0]
                                    ? generatePublicUrl(req, subDir, userId, path.basename(thumbnails[0]))
                                    : null;
                                processedMedia.push({
                                    url,
                                    type: mimetype.startsWith('image') ? 'image'
                                        : mimetype.startsWith('video') ? 'video' : 'file',
                                    mimeType: mimetype,
                                    thumbnail: thumbUrl,
                                });
                            } catch (compressErr) {
                                console.error('Compression failed for file, keeping original:', compressErr.message);
                                // Keep the original entry on error
                                const subDir = 'postmedia';
                                processedMedia.push({
                                    url: generatePublicUrl(req, subDir, req.user.id, file.filename),
                                    type: file.mimetype.startsWith('image') ? 'image'
                                        : file.mimetype.startsWith('video') ? 'video' : 'file',
                                    mimeType: file.mimetype,
                                    thumbnail: null,
                                });
                            }
                        }

                        // Moderation — only scan images (Rekognition doesn't handle video directly)
                        const imagePaths = files
                            .filter(f => f.mimetype.startsWith('image/'))
                            .map(f => f.path)
                            .filter(p => fs.existsSync(p));

                        let moderationResult = { isNSFW: false, labels: [], score: 0 };
                        if (imagePaths.length > 0) {
                            try {
                                moderationResult = await moderateMedia(imagePaths);
                            } catch (modErr) {
                                console.error('Moderation scan failed (non-fatal):', modErr.message);
                            }
                        }

                        const moderationStatus = moderationResult.isNSFW ? 'rejected' : 'approved';

                        // Update post with compressed media + moderation result
                        await PostSchema.findByIdAndUpdate(savePost._id, {
                            media: processedMedia,
                            moderation: {
                                status: moderationStatus,
                                labels: moderationResult.labels,
                                score: moderationResult.score,
                            }
                        });

                        if (moderationResult.isNSFW) {
                            console.warn(`Post ${savePost._id} flagged as NSFW and rejected.`);
                            return; // Skip rewards for rejected posts
                        }
                    } catch (bgErr) {
                        console.error('Background post processing error:', bgErr.message);
                    }

                    // ── Reward milestone check ──
                    try {
                        const user = await User.findById(req.user.id);
                        const postCount = await PostSchema.countDocuments({ user_id: req.user.id });
                        const slabs = [30, 70, 150, 300, 600, 1000];
                        const reachedSlab = slabs.find(slab => postCount === slab);

                        if (reachedSlab && !user.rewardedPostMilestones.includes(reachedSlab)) {
                            const reward = calculatePostsReward(postCount);
                            user.totalGroceryCoupons = (user.totalGroceryCoupons || 0) + reward.groceryCoupons;
                            user.totalShares = (user.totalShares || 0) + reward.shares;
                            user.rewardedPostMilestones.push(reachedSlab);
                            await user.save();

                            const activity = new Activity({ userpost: req.user.id });
                            await activity.save();

                            await Notification.create({
                                user: req.user.id,
                                sender: req.user.id,
                                type: 'post_reward',
                                message: `🎉 Congrats! You reached ${reachedSlab} posts and earned a reward.`,
                                url: '/rewards/posts'
                            });

                            await notifyUser(req.user.id, `🎉 Congrats! You reached ${reachedSlab} posts.`, 'post_reward');

                            sendPushToUser(req.user.id.toString(), {
                                title: 'Milestone Reached!',
                                message: `You've published ${reachedSlab} posts. Reward granted 🎁`,
                                url: '/rewards/posts'
                            });

                            const io = getIO();
                            io.to(req.user.id.toString()).emit('notification', {
                                type: 'post_reward',
                                message: `🎉 You reached ${reachedSlab} posts and earned a reward!`
                            });
                        }
                    } catch (rewardErr) {
                        console.error('Reward processing error:', rewardErr.message);
                    }
                });
            } else {
                // Text-only post: run reward check inline (fast, no file I/O)
                try {
                    const user = await User.findById(req.user.id);
                    const postCount = await PostSchema.countDocuments({ user_id: req.user.id });
                    const slabs = [30, 70, 150, 300, 600, 1000];
                    const reachedSlab = slabs.find(slab => postCount === slab);

                    if (reachedSlab && !user.rewardedPostMilestones.includes(reachedSlab)) {
                        const reward = calculatePostsReward(postCount);
                        user.totalGroceryCoupons = (user.totalGroceryCoupons || 0) + reward.groceryCoupons;
                        user.totalShares = (user.totalShares || 0) + reward.shares;
                        user.rewardedPostMilestones.push(reachedSlab);
                        await user.save();
                    }
                } catch (rewardErr) {
                    console.error('Text post reward error:', rewardErr.message);
                }

                await PostSchema.findByIdAndUpdate(savePost._id, {
                    'moderation.status': 'approved'
                });
            }

        } catch (error) {
            console.error(error.message);
            // Only send error response if headers not already sent
            if (!res.headersSent) {
                res.status(500).send("Internal Server Error");
            }
        }
    });

//Route 3: Update Posts using: PUT "/api/posts/updateposts". Login required
router.put('/updateposts/:id', fetchUser, async (req, res) => {

    const { post, media, visibility } = req.body;

    try {
        let newPost = {};
        if (post) { newPost.post = post; }
        if (media) { newPost.media = media; }
        if (visibility) { newPost.visibility = visibility; }

        let userPost = await PostSchema.findById(req.params.id);
        if (!userPost) { return res.status(404).send("Not Found") }

        if (!userPost.user_id) {
            return res.status(400).send("Post has no associated user");
        }

        if (userPost.user_id.toString() !== req.user.id) { return res.status(401).send("Not Allowed") }

        const updatedPost = await PostSchema.findByIdAndUpdate(
            req.params.id,
            { $set: newPost },
            { new: true }
        );
        res.json({ updatedPost });

    } catch (error) {
        console.error(error.message);
        res.status(500).send("Internal Server Error");
    }
});

//Route 4: Delete Posts using: DELETE "/api/posts/deleteposts". Login required
router.delete('/deleteposts/:id', fetchUser, async (req, res) => {
    try {
        const userPost = await PostSchema.findById(req.params.id);

        if (!userPost) {
            return res.status(404).send("Post not found");
        }

        if (!userPost.user_id) {
            return res.status(400).send("Post has no associated user");
        }

        if (userPost.user_id.toString() !== req.user.id) {
            return res.status(401).send("Not allowed");
        }

        if (userPost.media && userPost.media.length > 0) {
            for (const media of userPost.media) {
                if (!media.url) continue;
                try {
                    const mediaFileName = path.basename(media.url);
                    const mediaPath = path.join(
                        __dirname,
                        "..",
                        "uploads",
                        "postmedia",
                        userPost.user_id.toString(),
                        mediaFileName
                    );
                    if (fs.existsSync(mediaPath)) {
                        await fsPromises.unlink(mediaPath);
                    } else {
                        console.warn("⚠️ Media file not found:", mediaPath);
                    }
                } catch (unlinkError) {
                    console.error("❌ Error deleting media file:", unlinkError);
                }
            }
        }

        const deletedPost = await PostSchema.findByIdAndDelete(req.params.id);

        return res.json({
            success: true,
            message: "Post and associated media deleted successfully",
            deletedPost
        });

    } catch (error) {
        console.error("Error deleting post:", error.message);
        res.status(500).send("Internal Server Error");
    }
});

// GET paginated comments
router.get('/:postId/comments', fetchUser, async (req, res) => {
    const { postId } = req.params;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;

    try {
        const comments = await Comment.find({ postId })
            .populate('userId', 'name')
            .sort({ createdAt: -1 })
            .skip((page - 1) * limit)
            .limit(limit);

        res.json({ comments });
    } catch (err) {
        console.error('Error fetching comments:', err.message);
        res.status(500).send('Internal Server Error');
    }
});

// POST new comment
router.post('/:postId/comments', fetchUser, async (req, res) => {
    const { postId } = req.params;
    const { content } = req.body;

    if (!content || content.trim() === '') {
        return res.status(400).json({ message: 'Comment cannot be empty' });
    }

    try {
        const newComment = new Comment({
            postId,
            userId: req.user.id,
            content: content.trim()
        });

        const saved = await newComment.save();
        await saved.populate('userId', 'name');

        const { getIO } = require('../sockets/IOsocket');
        const io = getIO();
        io.to(postId).emit('comment:new', saved);

        const post = await PostSchema.findById(postId).populate('user_id', 'name');
        if (post && post.user_id._id.toString() !== req.user.id) {
            await Notification.create({
                user: post.user_id._id,
                sender: req.user.id,
                type: 'comment',
                message: `${saved.userId.name} commented on your post: "${saved.content}"`,
                url: `/posts/${postId}`
            });

            await notifyUser(post.user_id._id, `${saved.userId.name} commented on your post 💬`, 'comment');

            sendPushToUser(post.user_id._id.toString(), {
                title: 'New Comment',
                message: `${saved.userId.name} commented: "${saved.content}"`,
                url: `/posts/${postId}`
            });

            const io2 = getIO();
            io2.to(post.user_id._id.toString()).emit('notification', {
                type: 'comment',
                from: req.user.id,
                message: `${saved.userId.name} commented on your post 💬`
            });
        }

        res.status(201).json(saved);
    } catch (err) {
        console.error('Error saving comment:', err.message);
        res.status(500).send('Internal Server Error');
    }
});

router.get('/:postId/comments/count', async (req, res) => {
    const { postId } = req.params;
    try {
        const count = await Comment.countDocuments({ postId });
        res.json({ count });
    } catch (err) {
        console.error('Error getting comment count:', err.message);
        res.status(500).send('Internal Server Error');
    }
});

// Like or unlike a post
router.put('/like/:id', fetchUser, async (req, res) => {
    try {
        const post = await PostSchema.findById(req.params.id);
        if (!post) return res.status(404).send("Post not found");

        const userId = req.user.id;
        const index = post.likes.indexOf(userId);

        if (index === -1) {
            post.likes.push(userId);
        } else {
            post.likes.splice(index, 1);
        }

        await post.save();

        if (index === -1 && post.user_id.toString() !== req.user.id) {
            await Notification.create({
                user: post.user_id,
                sender: req.user.id,
                type: 'like',
                message: `❤️ Your post was liked.`,
                url: `/posts/${post._id}`
            });

            await notifyUser(post.user_id, `❤️ Your post was liked`, 'like');

            sendPushToUser(post.user_id.toString(), {
                title: 'New Like',
                message: `Someone liked your post ❤️`,
                url: `/posts/${post._id}`
            });

            const io = getIO();
            io.to(post.user_id.toString()).emit('notification', {
                type: 'like',
                from: req.user.id,
                message: `❤️ Your post was liked`
            });
        }

        res.json({ success: true, likes: post.likes });
    } catch (err) {
        console.error(err.message);
        res.status(500).send("Internal Server Error");
    }
});


module.exports = router;