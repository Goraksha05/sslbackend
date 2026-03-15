// middleware/isAdmin.js  ← REPLACES existing isAdmin.js
// Now delegates to verifyAdmin from the RBAC module so all existing routes
// that import isAdmin continue to work unchanged while gaining RBAC support.

const { verifyAdmin } = require('./rbac');
module.exports = verifyAdmin;