// constants/permissions.js
// Single source of truth for every permission token used in the RBAC system.
// Import this file on the backend (middleware) and frontend (UI gating).

const PERMISSIONS = {
  // ── Users ────────────────────────────────────────────────
  VIEW_USERS:     'view_users',
  BAN_USERS:      'ban_users',
  SUSPEND_USERS:  'suspend_users',
  RESET_REWARDS:  'reset_rewards',

  // ── Rewards ──────────────────────────────────────────────
  VIEW_REWARDS:         'view_rewards',
  MANAGE_REWARDS:       'manage_rewards',
  UNDO_REWARDS:         'undo_rewards',
  APPROVE_REWARD_CLAIMS:'approve_reward_claims',

  // ── Financial ────────────────────────────────────────────
  VIEW_FINANCIAL_REPORTS:   'view_financial_reports',
  EXPORT_FINANCIAL_REPORTS: 'export_financial_reports',
  MANAGE_PAYOUTS:           'manage_payouts',

  // ── Content / Posts ──────────────────────────────────────
  MODERATE_POSTS: 'moderate_posts',
  DELETE_POSTS:   'delete_posts',
  APPROVE_POSTS:  'approve_posts',
  REJECT_POSTS:   'reject_posts',

  // ── Analytics / Reports ──────────────────────────────────
  VIEW_ANALYTICS: 'view_analytics',
  VIEW_REPORTS:   'view_reports',
  EXPORT_REPORTS: 'export_reports',

  // ── Admin Management (super_admin only) ──────────────────
  MANAGE_ADMINS: 'manage_admins',
  MANAGE_ROLES:  'manage_roles',
  VIEW_AUDIT_LOGS: 'view_audit_logs',

  // ── Wildcard (super_admin) ────────────────────────────────
  WILDCARD: '*',
};

// Pre-built role bundles used when seeding default roles
const ROLE_PRESETS = {
  finance_admin: [
    PERMISSIONS.VIEW_FINANCIAL_REPORTS,
    PERMISSIONS.EXPORT_FINANCIAL_REPORTS,
    PERMISSIONS.MANAGE_PAYOUTS,
    PERMISSIONS.VIEW_REPORTS,
    PERMISSIONS.EXPORT_REPORTS,
  ],
  rewards_admin: [
    PERMISSIONS.VIEW_REWARDS,
    PERMISSIONS.MANAGE_REWARDS,
    PERMISSIONS.UNDO_REWARDS,
    PERMISSIONS.APPROVE_REWARD_CLAIMS,
    PERMISSIONS.RESET_REWARDS,
  ],
  moderator: [
    PERMISSIONS.MODERATE_POSTS,
    PERMISSIONS.DELETE_POSTS,
    PERMISSIONS.APPROVE_POSTS,
    PERMISSIONS.REJECT_POSTS,
    PERMISSIONS.VIEW_USERS,
  ],
  user_manager: [
    PERMISSIONS.VIEW_USERS,
    PERMISSIONS.BAN_USERS,
    PERMISSIONS.SUSPEND_USERS,
    PERMISSIONS.RESET_REWARDS,
  ],
  analytics_admin: [
    PERMISSIONS.VIEW_ANALYTICS,
    PERMISSIONS.VIEW_REPORTS,
    PERMISSIONS.EXPORT_REPORTS,
  ],
};

module.exports = { PERMISSIONS, ROLE_PRESETS };