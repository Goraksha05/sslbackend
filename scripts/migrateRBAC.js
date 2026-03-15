// scripts/migrateRBAC.js
// Run ONCE after deploying the new User schema and RBAC middleware.
//
//   node scripts/migrateRBAC.js
//
// What it does:
//   1. Promotes the earliest admin user to super_admin.
//   2. Creates the five default AdminRole documents.
//   3. Ensures all remaining admin users have role:'admin' and isAdmin:true.

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const mongoose = require('mongoose');

const MONGO_URI =
  process.env.MONGO_URI ||
  process.env.MONGODB_URI ||
  process.env.MONGO_URL ||
  process.env.DATABASE_URL;

if (!MONGO_URI) {
  console.error('\n❌  No MongoDB connection string found.');
  console.error('    Looked for: MONGO_URI, MONGODB_URI, MONGO_URL, DATABASE_URL');
  console.error('    .env path searched:', path.resolve(__dirname, '../.env'));
  console.error('\n    Either add MONGO_URI=<your-uri> to your .env file,');
  console.error('    or run:  MONGO_URI="mongodb://..." node scripts/migrateRBAC.js\n');
  process.exit(1);
}

// ── Inline schemas (avoid importing models that may need the full app context) ─

const AdminRoleSchema = new mongoose.Schema({
  roleName:    { type: String, required: true, unique: true },
  permissions: { type: [String], default: [] },
  description: { type: String, default: '' },
  createdAt:   { type: Date, default: Date.now },
});
const AdminRole = mongoose.model('AdminRole', AdminRoleSchema);

// We only need a lightweight user schema for this migration
const UserMini = mongoose.model('user', new mongoose.Schema({}, { strict: false }));

// ── Default roles ─────────────────────────────────────────────────────────────
const DEFAULT_ROLES = [
  {
    roleName:    'finance_admin',
    description: 'Access to financial reports and payouts',
    permissions: ['view_financial_reports','export_financial_reports','manage_payouts','view_reports','export_reports'],
  },
  {
    roleName:    'rewards_admin',
    description: 'Manage reward slabs and undo redemptions',
    permissions: ['view_rewards','manage_rewards','undo_rewards','approve_reward_claims','reset_rewards'],
  },
  {
    roleName:    'moderator',
    description: 'Moderate user-generated content',
    permissions: ['moderate_posts','delete_posts','approve_posts','reject_posts','view_users'],
  },
  {
    roleName:    'user_manager',
    description: 'Manage user accounts and suspensions',
    permissions: ['view_users','ban_users','suspend_users','reset_rewards'],
  },
  {
    roleName:    'analytics_admin',
    description: 'View analytics and export reports',
    permissions: ['view_analytics','view_reports','export_reports'],
  },
];

async function run() {
  await mongoose.connect(MONGO_URI);
  console.log('✅ Connected to MongoDB');

  // 1. Promote oldest admin → super_admin
  const firstAdmin = await UserMini.findOne(
    { $or: [{ role: 'admin' }, { isAdmin: true }] },
    null,
    { sort: { date: 1 } }
  );

  if (firstAdmin) {
    await UserMini.updateOne(
      { _id: firstAdmin._id },
      { $set: { role: 'super_admin', isAdmin: true, adminPermissions: [] } }
    );
    console.log(`⭐ Super admin: ${firstAdmin.email || firstAdmin._id}`);
  } else {
    console.warn('⚠️  No existing admin found — set super_admin manually');
  }

  // 2. Ensure all other admins have consistent fields
  const result = await UserMini.updateMany(
    { $or: [{ role: 'admin' }, { isAdmin: true }], _id: { $ne: firstAdmin?._id } },
    { $set: { role: 'admin', isAdmin: true }, $setOnInsert: { adminPermissions: [] } }
  );
  console.log(`👥 Normalised ${result.modifiedCount} existing admin(s)`);

  // 3. Seed default roles (skip if already exists)
  for (const role of DEFAULT_ROLES) {
    const exists = await AdminRole.findOne({ roleName: role.roleName });
    if (exists) {
      console.log(`   ↩  Role already exists: ${role.roleName}`);
    } else {
      await AdminRole.create(role);
      console.log(`   ✅ Created role: ${role.roleName}`);
    }
  }

  console.log('\n🎉 RBAC migration complete.');
  await mongoose.disconnect();
}

run().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});