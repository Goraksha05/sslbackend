// middleware/requireVerified.js
const User = require('../models/User');
module.exports = async (req,res,next)=>{
  const u = await User.findById(req.user.id).select('emailVerified phoneVerified trustScore banned');
  if(!u || u.banned) return res.status(403).json({message:'Account restricted'});
  if(!(u.emailVerified || u.phoneVerified)) {
    return res.status(403).json({message:'Verify your account to post or upload media'});
  }
  next();
};
