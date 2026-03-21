// services/investigationAgent.js
// LLM-powered investigation agent backed by Claude (Anthropic API).
// Admins query it in natural language; it plans and executes tool calls
// against MongoDB and the device graph, then returns a structured report.
//
// The agent uses the tool-calling API. Tools are defined below and executed
// server-side — the LLM never has direct DB access.
//
// Usage:
//   const { runInvestigation } = require('./investigationAgent');
//   const report = await runInvestigation('Find users with referral abuse score > 0.7');
'use strict';

const User           = require('../models/User');
const FraudEvent     = require('../models/FraudEvent');
const DeviceGraph    = require('../models/DeviceGraph');
const RewardClaim    = require('../models/RewardClaim');
const BehaviorVector = require('../models/BehaviorVector');

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL             = 'claude-sonnet-4-20250514';
const MAX_TOOL_ROUNDS   = 6;  // max rounds of tool use per investigation

// ── Tool definitions (sent to Claude) ─────────────────────────────────────────
const TOOLS = [
  {
    name: 'query_users',
    description: 'Query the users collection. Returns user summaries with trust flags and risk scores.',
    input_schema: {
      type: 'object',
      properties: {
        filter: {
          type: 'object',
          description: 'MongoDB filter object. Available fields: trustFlags.riskScore, trustFlags.riskTier, trustFlags.rewardsFrozen, trustFlags.onWatchlist, trustFlags.referralAbuseScore, subscription.active, role. Example: { "trustFlags.riskScore": { "$gt": 0.7 } }',
        },
        limit:  { type: 'number', description: 'Max users to return (default 20, max 100)' },
        sortBy: { type: 'string', description: 'Field to sort by descending. E.g. "trustFlags.riskScore"' },
      },
      required: ['filter'],
    },
  },
  {
    name: 'get_fraud_events',
    description: 'Retrieve FraudEvent audit records. Returns risk scores, explanations, and actions taken.',
    input_schema: {
      type: 'object',
      properties: {
        userId:    { type: 'string', description: 'Filter by specific userId' },
        minScore:  { type: 'number', description: 'Minimum aggregateRiskScore (0–1)' },
        tier:      { type: 'string', enum: ['watchlist', 'kyc_gate', 'auto_flag'] },
        resolved:  { type: 'boolean', description: 'Filter by resolution status' },
        limit:     { type: 'number', description: 'Max records to return (default 20)' },
      },
    },
  },
  {
    name: 'get_cluster_members',
    description: 'Get all users in a device graph cluster. Useful for finding fraud rings.',
    input_schema: {
      type: 'object',
      properties: {
        clusterId: { type: 'string', description: 'Cluster ID from DeviceGraph.primaryClusterId' },
        minClusterSize: { type: 'number', description: 'Find clusters with at least this many user members' },
      },
    },
  },
  {
    name: 'get_referral_tree',
    description: 'Get the referral tree for a user (BFS, up to 4 levels deep).',
    input_schema: {
      type: 'object',
      properties: {
        userId: { type: 'string', description: 'Root user ID' },
      },
      required: ['userId'],
    },
  },
  {
    name: 'get_reward_claims',
    description: 'Get reward claim history for one or more users.',
    input_schema: {
      type: 'object',
      properties: {
        userId:  { type: 'string', description: 'Filter by userId' },
        type:    { type: 'string', enum: ['referral', 'post', 'streak'] },
        limit:   { type: 'number', description: 'Max records (default 50)' },
      },
    },
  },
  {
    name: 'get_behavior_vectors',
    description: 'Get behavioral fingerprint vectors for users. Useful for detecting bot patterns.',
    input_schema: {
      type: 'object',
      properties: {
        userIds:        { type: 'array', items: { type: 'string' }, description: 'List of user IDs' },
        minAnomalyScore: { type: 'number', description: 'Minimum anomaly score (0–1)' },
      },
    },
  },
];

// ── Tool execution ─────────────────────────────────────────────────────────────
async function executeTool(toolName, input) {
  switch (toolName) {
    case 'query_users': {
      const limit  = Math.min(input.limit  || 20, 100);
      const sortBy = input.sortBy || 'trustFlags.riskScore';
      const users  = await User.find(input.filter || {})
        .select('name email username trustFlags subscription.plan subscription.active referralId date')
        .sort({ [sortBy]: -1 })
        .limit(limit)
        .lean();
      return users.map(u => ({
        userId:       String(u._id),
        name:         u.name,
        email:        u.email,
        username:     u.username,
        referralId:   u.referralId,
        plan:         u.subscription?.plan,
        active:       u.subscription?.active,
        riskScore:    u.trustFlags?.riskScore,
        riskTier:     u.trustFlags?.riskTier,
        rewardsFrozen: u.trustFlags?.rewardsFrozen,
        onWatchlist:  u.trustFlags?.onWatchlist,
        referralAbuseScore: u.trustFlags?.referralAbuseScore,
        registeredAt: u.date,
      }));
    }

    case 'get_fraud_events': {
      const filter = {};
      if (input.userId)   filter.userId    = input.userId;
      if (input.minScore) filter['scores.aggregateRiskScore'] = { $gte: input.minScore };
      if (input.tier)     filter['scores.multiAccountScore']  = { $gte: { watchlist: 0.45, kyc_gate: 0.60, auto_flag: 0.75 }[input.tier] || 0 };
      if (input.resolved !== undefined) filter.resolved = input.resolved;

      const events = await FraudEvent.find(filter)
        .sort({ createdAt: -1 })
        .limit(Math.min(input.limit || 20, 100))
        .lean();

      return events.map(e => ({
        id:            String(e._id),
        userId:        String(e.userId),
        triggerEvent:  e.triggerEvent,
        aggregateRisk: e.scores?.aggregateRiskScore,
        multiAccount:  e.scores?.multiAccountScore,
        referralAbuse: e.scores?.referralAbuse,
        actionsTriggered: e.actionsTriggered,
        explanation:   e.explanation,
        resolved:      e.resolved,
        createdAt:     e.createdAt,
      }));
    }

    case 'get_cluster_members': {
      if (input.clusterId) {
        // Get all user nodes in this cluster
        const nodes = await DeviceGraph.find({
          entityType: 'user',
          primaryClusterId: input.clusterId,
        }).lean();
        const userIds = nodes.map(n => n.entityId);
        const users   = await User.find({ _id: { $in: userIds } })
          .select('name email trustFlags.riskScore trustFlags.riskTier')
          .lean();
        return {
          clusterId:   input.clusterId,
          memberCount: users.length,
          members:     users.map(u => ({
            userId:    String(u._id),
            name:      u.name,
            email:     u.email,
            riskScore: u.trustFlags?.riskScore,
            riskTier:  u.trustFlags?.riskTier,
          })),
        };
      }

      if (input.minClusterSize) {
        // Find cluster IDs with enough user members
        const pipeline = [
          { $match: { entityType: 'user', primaryClusterId: { $ne: null } } },
          { $group: { _id: '$primaryClusterId', count: { $sum: 1 } } },
          { $match: { count: { $gte: input.minClusterSize } } },
          { $sort: { count: -1 } },
          { $limit: 20 },
        ];
        return DeviceGraph.aggregate(pipeline);
      }

      return { error: 'Provide either clusterId or minClusterSize' };
    }

    case 'get_referral_tree': {
      const tree    = [];
      const visited = new Set([input.userId]);
      const queue   = [{ id: input.userId, depth: 0, parentId: null }];

      while (queue.length > 0) {
        const { id, depth, parentId } = queue.shift();
        if (depth > 4) continue;

        const user = await User.findById(id)
          .select('name email referralId trustFlags.riskScore trustFlags.riskTier')
          .lean();
        if (!user) continue;

        tree.push({
          userId:    String(user._id),
          name:      user.name,
          email:     user.email,
          referralId: user.referralId,
          depth,
          parentId,
          riskScore: user.trustFlags?.riskScore,
          riskTier:  user.trustFlags?.riskTier,
        });

        const children = await User.find({ referral: id }).select('_id').lean();
        for (const child of children) {
          const childId = String(child._id);
          if (!visited.has(childId)) {
            visited.add(childId);
            queue.push({ id: childId, depth: depth + 1, parentId: id });
          }
        }
      }

      return { rootUserId: input.userId, nodeCount: tree.length, tree };
    }

    case 'get_reward_claims': {
      const filter = {};
      if (input.userId) filter.user = input.userId;
      if (input.type)   filter.type = input.type;

      const claims = await RewardClaim.find(filter)
        .sort({ claimedAt: -1 })
        .limit(Math.min(input.limit || 50, 200))
        .lean();

      return claims.map(c => ({
        id:        String(c._id),
        userId:    String(c.user),
        type:      c.type,
        milestone: c.milestone,
        claimedAt: c.claimedAt,
      }));
    }

    case 'get_behavior_vectors': {
      const filter = {};
      if (input.userIds)         filter.userId = { $in: input.userIds };
      if (input.minAnomalyScore) filter.anomalyScore = { $gte: input.minAnomalyScore };

      const vectors = await BehaviorVector.find(filter).limit(100).lean();
      return vectors.map(v => ({
        userId:               String(v.userId),
        loginIntervalEntropy: v.loginIntervalEntropy,
        typingVelocityMean:   v.typingVelocityMean,
        typingVelocityStdDev: v.typingVelocityStdDev,
        postCadenceRegularity:v.postCadenceRegularity,
        referralBurstScore:   v.referralBurstScore,
        anomalyScore:         v.anomalyScore,
        clusterSimilarityScore: v.clusterSimilarityScore,
        lastComputedAt:       v.lastComputedAt,
      }));
    }

    default:
      return { error: `Unknown tool: ${toolName}` };
  }
}

// ── Main agent loop ────────────────────────────────────────────────────────────
/**
 * Run a fraud investigation in response to a natural language query.
 *
 * @param {string} query          Admin's natural language question
 * @param {string} adminId        ID of the admin running the investigation
 * @returns {Promise<{
 *   report:    string,    Markdown-formatted investigation report
 *   toolCalls: object[],  All tool calls made
 *   duration:  number,    Ms elapsed
 * }>}
 */
async function runInvestigation(query, adminId) {
  const t0 = Date.now();

  const systemPrompt = `You are a Trust & Safety AI analyst for SoShoLife, a social-economy platform.
You have access to tools that query the platform's fraud detection data.

Your job:
1. Understand the admin's investigation query
2. Call tools in sequence to gather evidence
3. Synthesize findings into a clear, structured report

Report format (Markdown):
## Investigation Summary
(1-2 sentence summary of findings)

## Evidence Found
(Bullet points of key data)

## Risk Assessment
(Overall risk level and which users/clusters are most concerning)

## Recommended Actions
(Specific, actionable steps for the admin team)

Guidelines:
- Always look at multiple signals before drawing conclusions
- Flag confidence level (high/medium/low) for each finding
- Be specific: name user IDs, cluster IDs, and score values
- If you find nothing suspicious, say so clearly — false positives harm real users
- Never recommend account deletion without multiple corroborating signals`;

  const messages = [
    { role: 'user', content: query },
  ];

  const toolCallLog = [];
  let round = 0;
  let finalReport = '';

  while (round < MAX_TOOL_ROUNDS) {
    round++;

    const response = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type':      'application/json',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model:      MODEL,
        max_tokens: 4096,
        system:     systemPrompt,
        tools:      TOOLS,
        messages,
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`[investigationAgent] API error: ${response.status} ${err}`);
    }

    const data = await response.json();

    // Collect text blocks as the evolving report
    const textBlocks = (data.content || []).filter(b => b.type === 'text');
    if (textBlocks.length > 0) {
      finalReport = textBlocks.map(b => b.text).join('\n\n');
    }

    // If model is done, break
    if (data.stop_reason === 'end_turn') break;

    // Execute tool calls
    const toolUseBlocks = (data.content || []).filter(b => b.type === 'tool_use');
    if (toolUseBlocks.length === 0) break;

    // Add assistant message to history
    messages.push({ role: 'assistant', content: data.content });

    // Execute all tool calls and build tool_result message
    const toolResults = [];
    for (const tool of toolUseBlocks) {
      let result;
      try {
        result = await executeTool(tool.name, tool.input);
        toolCallLog.push({ tool: tool.name, input: tool.input, resultCount: Array.isArray(result) ? result.length : 1 });
      } catch (err) {
        result = { error: err.message };
        toolCallLog.push({ tool: tool.name, input: tool.input, error: err.message });
      }

      toolResults.push({
        type:        'tool_result',
        tool_use_id: tool.id,
        content:     JSON.stringify(result),
      });
    }

    messages.push({ role: 'user', content: toolResults });
  }

  return {
    report:    finalReport || 'Investigation complete. No significant findings.',
    toolCalls: toolCallLog,
    duration:  Date.now() - t0,
    query,
    adminId,
    generatedAt: new Date().toISOString(),
  };
}

module.exports = { runInvestigation };