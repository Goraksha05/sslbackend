const axios = require('axios');

async function verifyPAN(panNumber) {
  try {
    const res = await axios.post(
      'https://api.sandbox.co.in/kyc/pan/verify',
      { pan: panNumber },
      {
        headers: {
          'x-api-key': process.env.PAN_API_KEY,
          'Content-Type': 'application/json'
        }
      }
    );

    return {
      valid: res.data.valid,
      name: res.data.name
    };

  } catch (err) {
    console.error('PAN verification failed');
    return { valid: false };
  }
}

module.exports = { verifyPAN };