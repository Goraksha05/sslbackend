const mongoose = require('mongoose');

const otpSchema = new mongoose.Schema({
  phone: { 
    type: String, 
    required: true, 
    unique: true 
},
  otpHash: { 
    type: String, 
    required: true 
},
  createdAt: { 
    type: Date, 
    default: Date.now, 
    expires: 300 
} // auto delete after 5 min

});

module.exports = mongoose.model('Otp', otpSchema);
