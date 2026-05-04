const axios = require('axios');

async function verifyPAN(panNumber) {
  try {
    const res = await axios.post(
      'https://api.sandbox.co.in/kyc/pan/verify',
      { pan: panNumber },
      {
        headers: {
          timeout: 8000,
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
    const status = err.response?.status;
    console.error('[verifyPAN] error:', status ?? 'network', err.message);

    // Transient: network error, timeout, rate-limit, server error
    // Return a distinct shape so callers can skip scoring rather than penalise
    if (!status || status === 429 || status >= 500) {
      return { valid: false, transient: true };
    }
    // 4xx (except 429) = definitive API rejection
    return { valid: false, transient: false };
  }

}

module.exports = { verifyPAN };