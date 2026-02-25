// schema_models/VerifiedPhone.js
const mongoose = require("mongoose");


const verifiedPhoneSchema = new mongoose.Schema({
  phone: { 
    type: String, 
    required: true, 
    unique: true 
},
  verifiedAt: { 
    type: Date, 
    default: Date.now, 
    expires: 300 
} // Expires after 5 min
});

module.exports = mongoose.model("VerifiedPhone", verifiedPhoneSchema);
