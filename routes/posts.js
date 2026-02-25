require('dotenv').config();
const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const fsPromises = fs.promises;
const PostSchema = require('../models/Posts');
var fetchUser = require('../middleware/fetchuser');
const { body, validationResult } = require('express-validator');
//const { uploadMultiple } = require('../middleware/upload');
const {
    uploadPostMedia,
    //  uploadMultiple,
    createUploadMiddleware,
    generatePublicUrl,
} = require("../middleware/upload");
const Activity = require('../models/Activity');
const User = require('../models/User');
const calculatePostsReward = require('../utils/calculatePostsReward');
const Profile = require('../models/Profile');
const Comment = require('../models/Comment');
const compressFile = require("../utils/compressFile");
const generateThumbnail = require("../utils/generateThumbnail");
const Notification = require('../models/Notification');
const { getIO } = require('../sockets/IOsocket');
const { sendPushToUser } = require('../utils/pushService');
const notifyUser = require('../utils/notifyUser');
//const requireVerified = require('../middleware/requireVerified');
const moderateMedia = require('../utils/moderateMedia');
const sanitizeHtml = require('sanitize-html');
const getBaseUrl = (req) => {
    return process.env.NODE_ENV === "production"
        ? "https://api.sosholife.com"
        : `${req.protocol}://${req.get("host")}`;
};

//Route 1: Get All the Posts using: GET "/api/posts/fetchallposts". Login required
router.get('/fetchallposts', fetchUser, async (req, res) => {
    try {
        const posts = await PostSchema.find({
            $or: [
                { visibility: 'public' },
                { user_id: req.user.id } // include own posts even if private
            ]
        })
            .populate('user_id', 'name subscription')
            .sort({ date: -1 }); // Add this line to fetch user's name

        // Fetch all profiles once
        const userIds = posts.map(p => p.user_id._id);
        const profiles = await Profile.find({ user_id: { $in: userIds } });
        const profileMap = {};
        profiles.forEach(p => profileMap[p.user_id.toString()] = p);

        const postsWithAvatars = posts.map(p => {
            const profile = profileMap[p.user_id._id.toString()];
            return {
                ...p.toObject(),
                profileavatar: profile?.profileavatar?.URL || null
            };
        });

        res.json(postsWithAvatars);
    } catch (error) {
        console.error(error.message);
        res.status(500).send("Internal Server Error");
    }
});

//Route 2: Add Posts using: POST "/api/posts/addnweposts". Login required
//router.post('/addnewposts', fetchUser, uploadMultiple('media', 5), [
router.post(
    "/addnewposts",
    fetchUser,
//    requireVerified,
    createUploadMiddleware("postmedia").array("media", 5),
    [
        //    body('post').isLength({ min: 1 }).withMessage('Post must be at least 1 characters long'),
        body('visibility').optional().isIn(['public', 'private', 'friends']).withMessage('Invalid visibility type'),
        // body('media').custom((value, { req }) => {
        //     if (!req.files || req.files.length === 0) return true; // No media is okay
        //     if (!Array.isArray(req.files)) return true; // multer handles array
        //     return true;
        // }).withMessage('Invalid media format')

    ], async (req, res) => {
        const { post, media, visibility } = req.body;

        try {
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                // console.log("Validation failed:", errors.array());
                return res.status(400).json({ errors: errors.array() });
            }

            // const mediaArray = req.files.map(file => ({

            //     url: generatePublicUrl(file.path),

            //     //            url: `/uploads/profiles/${req.user.id}/${file.filename}`,
            //     type: file.mimetype.startsWith('image') ? 'image' : file.mimetype.startsWith('video') ? 'video' : 'file',
            // }));

            const localPaths = (req.files || []).map(f => f.path); // paths before generatePublicUrl
            const mod = await moderateMedia(localPaths); // <-- scan
            if (mod.isNSFW) {
                // Option A: hard reject (auto-clear)
                return res.status(415).json({ message: "NSFW content is not allowed." });
                // Option B: quarantine
                // newpost.moderation = { status:'rejected', labels:mod.labels, score:mod.score };
            }

            // 🔽 Compress every uploaded file and capture (possibly changed) paths
            const processedMedia = [];
            for (const file of req.files || []) {
                const { filePath, mimetype, thumbnails } = await compressFile(file.path, file.mimetype);


                processedMedia.push({
                    url: generatePublicUrl(filePath),
                    type: mimetype.startsWith("image") ? "image" : 
                    mimetype.startsWith("video") ? "video" : "file",
                    mimeType: mimetype,
                    thumbnail: thumbnails[0] ? generatePublicUrl(thumbnails[0]) : null,
                });
            }

            const cleanPost = sanitizeHtml(req.body.post || " ");

            const newpost = new PostSchema({
                user_id: req.user.id,
                post: cleanPost,
                visibility: req.body.visibility || 'public',
                // media: mediaArray,
                media: processedMedia,
                moderation: { status: 'approved', labels: mod.labels, score: mod.score }
            });

            const savePost = await newpost.save();

            // ---- Auto reward with slab tracking ----
            const user = await User.findById(req.user.id);
            const postCount = await PostSchema.countDocuments({ user_id: req.user.id });

            // Define slabs same as in calculatePostsReward
            const slabs = [30, 70, 150, 300, 600, 1000];
            const reachedSlab = slabs.find(slab => postCount === slab);

            let reward = null;

            if (reachedSlab && !user.rewardedPostMilestones.includes(reachedSlab)) {
                reward = calculatePostsReward(postCount);

                user.totalGroceryCoupons = (user.totalGroceryCoupons || 0) + reward.groceryCoupons;
                user.totalShares = (user.totalShares || 0) + reward.shares;
                user.rewardedPostMilestones.push(reachedSlab);
                await user.save();

                const activity = new Activity({ userpost: req.user.id });
                await activity.save();
            }

            // Push Notification
            if (reward) {
                // ✅ DB Notification
                await Notification.create({
                    user: req.user.id,
                    sender: req.user.id,
                    type: 'post_reward',
                    message: `🎉 Congrats! You reached ${reachedSlab} posts and earned a reward.`,
                    url: '/rewards/posts'
                });

                // ✅ Toast
                await notifyUser(req.user.id, `🎉 Congrats! You reached ${reachedSlab} posts.`, 'post_reward');

                // ✅ Push
                sendPushToUser(req.user.id.toString(), {
                    title: 'Milestone Reached!',
                    message: `You’ve published ${reachedSlab} posts. Reward granted 🎁`,
                    url: '/rewards/posts'
                });

                // ✅ Socket
                const io = getIO();
                io.to(req.user.id.toString()).emit('notification', {
                    type: 'post_reward',
                    message: `🎉 You reached ${reachedSlab} posts and earned a reward!`
                });
            }

            res.json({
                message: 'Post created',
                post: savePost,
                ...(reward && { reward, note: `Slab ${reachedSlab} reached, reward granted` })
            });

        } catch (error) {
            console.error(error.message);
            res.status(500).send("Internal Server Error");
        }
    });

//Route 3: Update Posts using: PUT "/api/posts/updateposts". Login required
router.put('/updateposts/:id', fetchUser, async (req, res) => {

    const { post, media, visibility } = req.body;

    try {
        //create a newPost Object
        let newPost = {};
        if (post) { newPost.post = post; }
        if (media) { newPost.media = media; }
        if (visibility) { newPost.visibility = visibility; }

        //Find the post to be updated and update it
        let userPost = await PostSchema.findById(req.params.id);  //here req.params.id means post id
        if (!userPost) { return res.status(404).send("Not Found") }

        if (!userPost.user_id) {                                    //here user_id means that id which is in PostSchema
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
        const userPost = await PostSchema.findById(req.params.id); // req.params.id = post id

        if (!userPost) {
            return res.status(404).send("Post not found");
        }

        if (!userPost.user_id) {
            return res.status(400).send("Post has no associated user");
        }

        // ✅ Check if logged-in user is the owner
        if (userPost.user_id.toString() !== req.user.id) {
            return res.status(401).send("Not allowed");
        }

        // ✅ Delete associated media files if present
        if (userPost.media && userPost.media.length > 0) {
            for (const media of userPost.media) {
                if (!media.url) continue;

                try {
                    // Extract filename from stored URL
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
                        // console.log("✅ Deleted media file:", mediaPath);
                    } else {
                        console.warn("⚠️ Media file not found:", mediaPath);
                    }
                } catch (unlinkError) {
                    console.error("❌ Error deleting media file:", unlinkError);
                }
            }
        }

        // ✅ Delete post from DB
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
    console.log('Incoming comment content:', content);

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

        // Emit real-time comment
        const { getIO } = require('../sockets/IOsocket');
        const io = getIO();
        io.to(postId).emit('comment:new', saved);

        // ✅ Notify post owner about new comment
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

            const io = getIO();
            io.to(post.user_id._id.toString()).emit('notification', {
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

// routes/comments.js
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
            post.likes.push(userId); // Like
        } else {
            post.likes.splice(index, 1); // Unlike
        }

        await post.save();

        if (index === -1 && post.user_id.toString() !== req.user.id) {
            // ✅ Notify post owner on like
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


module.exports = router