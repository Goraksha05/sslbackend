// jobs/graphAlgorithmsJob.js
// Nightly job (runs at 03:00 IST) that executes graph algorithms over
// the DeviceGraph collection to identify clusters, hub accounts, and referral loops.
//
// Algorithms implemented in pure JS over MongoDB cursor batches:
//   1. Connected components (Union-Find / Disjoint Set Union)
//   2. Cycle detection in referral sub-graph (DFS)
//   3. Degree centrality (edge count per node)
//   4. Betweenness centrality (simplified: fraction of shortest paths through node)
//   5. Risk flag assignment based on algorithm results
//
// Schedule:
//   cron.schedule('30 21 * * *', runGraphAlgorithmsJob); // 21:30 UTC = 03:00 IST
'use strict';

const DeviceGraph = require('../models/DeviceGraph');
const User        = require('../models/User');

// ── Union-Find (Disjoint Set Union) ──────────────────────────────────────────
class UnionFind {
  constructor() {
    this.parent = {};
    this.rank   = {};
  }

  find(x) {
    if (this.parent[x] === undefined) {
      this.parent[x] = x;
      this.rank[x]   = 0;
    }
    if (this.parent[x] !== x) {
      this.parent[x] = this.find(this.parent[x]); // path compression
    }
    return this.parent[x];
  }

  union(x, y) {
    const rx = this.find(x);
    const ry = this.find(y);
    if (rx === ry) return;
    if ((this.rank[rx] || 0) < (this.rank[ry] || 0)) {
      this.parent[rx] = ry;
    } else if ((this.rank[rx] || 0) > (this.rank[ry] || 0)) {
      this.parent[ry] = rx;
    } else {
      this.parent[ry] = rx;
      this.rank[rx]   = (this.rank[rx] || 0) + 1;
    }
  }

  // Returns { nodeId: clusterId } map
  // Cluster ID is the root representative of the component
  getClusters() {
    const result = {};
    for (const node of Object.keys(this.parent)) {
      result[node] = this.find(node);
    }
    return result;
  }
}

// ── Load entire graph into memory (adjacency map) ────────────────────────────
// For 10M users this won't fit in RAM — use batch streaming.
// At current scale (< 500K users) loading all nodes is safe (~200MB).
async function loadAdjacencyMap() {
  const adj = {};  // nodeKey -> Set of nodeKey
  const nodeTypes = {};  // nodeKey -> entityType

  const cursor = DeviceGraph.find({}).lean().cursor();

  for await (const node of cursor) {
    const nodeKey = `${node.entityType}:${node.entityId}`;
    nodeTypes[nodeKey] = node.entityType;
    if (!adj[nodeKey]) adj[nodeKey] = new Set();

    for (const edge of (node.edges || [])) {
      const targetKey = `${edge.targetType}:${edge.targetId}`;
      adj[nodeKey].add(targetKey);
      if (!adj[targetKey]) adj[targetKey] = new Set();
      adj[targetKey].add(nodeKey);
      nodeTypes[targetKey] = edge.targetType;
    }
  }

  return { adj, nodeTypes };
}

// ── Algorithm 1: Connected components ─────────────────────────────────────────
function computeConnectedComponents(adj) {
  const uf = new UnionFind();

  for (const [node, neighbors] of Object.entries(adj)) {
    for (const neighbor of neighbors) {
      uf.union(node, neighbor);
    }
  }

  return uf.getClusters();  // nodeKey -> clusterId (root representative)
}

// ── Algorithm 2: Cycle detection in referral sub-graph ────────────────────────
// Returns Set of nodeKeys that participate in a referral cycle.
function detectReferralCycles(adj, nodeTypes) {
  // Build referral-only directed adjacency
  const refAdj = {};
  for (const [node, neighbors] of Object.entries(adj)) {
    if (nodeTypes[node] !== 'user') continue;
    refAdj[node] = [];
    for (const neighbor of neighbors) {
      if (nodeTypes[neighbor] === 'user') refAdj[node].push(neighbor);
    }
  }

  const visited    = new Set();
  const inStack    = new Set();
  const cycleNodes = new Set();

  function dfs(node) {
    visited.add(node);
    inStack.add(node);

    for (const neighbor of (refAdj[node] || [])) {
      if (!visited.has(neighbor)) {
        dfs(neighbor);
      } else if (inStack.has(neighbor)) {
        // Cycle detected — mark both ends
        cycleNodes.add(node);
        cycleNodes.add(neighbor);
      }
    }

    inStack.delete(node);
  }

  for (const node of Object.keys(refAdj)) {
    if (!visited.has(node)) dfs(node);
  }

  return cycleNodes;
}

// ── Algorithm 3: Degree centrality ───────────────────────────────────────────
function computeDegreeCentrality(adj) {
  const degrees = {};
  for (const [node, neighbors] of Object.entries(adj)) {
    degrees[node] = neighbors.size;
  }
  return degrees;
}

// ── Algorithm 4: Simplified betweenness (hub detection) ───────────────────────
// Full betweenness is O(V*E) — too slow for 500K nodes.
// We approximate it: a node is a "hub" if it connects two otherwise-separate clusters.
// Strategy: nodes that bridge the most cluster pairs score highest.
function computeHubScores(adj, clusterMap) {
  const bridgeCount = {};

  for (const [node, neighbors] of Object.entries(adj)) {
    const neighborClusters = new Set();
    for (const neighbor of neighbors) {
      if (clusterMap[neighbor] && clusterMap[neighbor] !== clusterMap[node]) {
        neighborClusters.add(clusterMap[neighbor]);
      }
    }
    bridgeCount[node] = neighborClusters.size;
  }

  // Normalise to 0–1
  const maxBridge = Math.max(1, ...Object.values(bridgeCount));
  const scores    = {};
  for (const [node, count] of Object.entries(bridgeCount)) {
    scores[node] = count / maxBridge;
  }
  return scores;
}

// ── Write results back to MongoDB ─────────────────────────────────────────────
async function persistResults(clusterMap, cycleNodes, degrees, hubScores, nodeTypes) {
  const BATCH_SIZE = 500;
  const nodes = Object.keys(clusterMap);

  for (let i = 0; i < nodes.length; i += BATCH_SIZE) {
    const batch = nodes.slice(i, i + BATCH_SIZE);
    const bulkOps = batch.map(nodeKey => {
      const [entityType, ...idParts] = nodeKey.split(':');
      const entityId = idParts.join(':');
      const clusterId = clusterMap[nodeKey];

      const riskFlags = [];
      if (cycleNodes.has(nodeKey))                            riskFlags.push('referral_loop');
      if ((degrees[nodeKey] || 0) > 20)                      riskFlags.push('high_degree');
      if ((hubScores[nodeKey] || 0) > 0.7)                   riskFlags.push('hub_account');
      if (entityType === 'device' && (degrees[nodeKey] || 0) > 3) riskFlags.push('shared_device_farm');
      if (entityType === 'ip'     && (degrees[nodeKey] || 0) > 5) riskFlags.push('ip_cluster');

      return {
        updateOne: {
          filter: { entityType, entityId },
          update: {
            $set: {
              primaryClusterId:   clusterId,
              clusterIds:         [clusterId],
              degreeScore:        degrees[nodeKey]  || 0,
              betweennessScore:   hubScores[nodeKey] || 0,
              riskFlags,
              lastGraphUpdateAt:  new Date(),
            },
          },
          upsert: false,
        },
      };
    });

    await DeviceGraph.bulkWrite(bulkOps, { ordered: false });
  }
}

// ── Update User trustFlags with cluster info ──────────────────────────────────
async function updateUserClusterFlags(clusterMap, cycleNodes, nodeTypes) {
  const userNodes = Object.entries(clusterMap)
    .filter(([key]) => nodeTypes[key] === 'user');

  const BATCH = 500;
  for (let i = 0; i < userNodes.length; i += BATCH) {
    const slice = userNodes.slice(i, i + BATCH);
    const bulkOps = slice.map(([nodeKey, clusterId]) => {
      const userId = nodeKey.split(':')[1];
      return {
        updateOne: {
          filter: { _id: userId },
          update: {
            $set: {
              'trustFlags.primaryClusterId': clusterId,
              'trustFlags.inReferralCycle':  cycleNodes.has(nodeKey),
              'trustFlags.lastGraphUpdateAt': new Date(),
            },
          },
        },
      };
    });
    await User.bulkWrite(bulkOps, { ordered: false });
  }
}

// ── Main job ──────────────────────────────────────────────────────────────────
async function runGraphAlgorithmsJob() {
  console.log('[graphAlgorithmsJob] Starting…');
  const t0 = Date.now();

  console.log('[graphAlgorithmsJob] Loading adjacency map…');
  const { adj, nodeTypes } = await loadAdjacencyMap();
  const nodeCount = Object.keys(adj).length;
  console.log(`[graphAlgorithmsJob] Loaded ${nodeCount} nodes.`);

  console.log('[graphAlgorithmsJob] Computing connected components…');
  const clusterMap = computeConnectedComponents(adj);

  console.log('[graphAlgorithmsJob] Detecting referral cycles…');
  const cycleNodes = detectReferralCycles(adj, nodeTypes);
  console.log(`[graphAlgorithmsJob] Found ${cycleNodes.size} cycle nodes.`);

  console.log('[graphAlgorithmsJob] Computing degree centrality…');
  const degrees = computeDegreeCentrality(adj);

  console.log('[graphAlgorithmsJob] Computing hub scores…');
  const hubScores = computeHubScores(adj, clusterMap);

  console.log('[graphAlgorithmsJob] Persisting results…');
  await persistResults(clusterMap, cycleNodes, degrees, hubScores, nodeTypes);

  console.log('[graphAlgorithmsJob] Updating user cluster flags…');
  await updateUserClusterFlags(clusterMap, cycleNodes, nodeTypes);

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[graphAlgorithmsJob] Done in ${elapsed}s. Nodes: ${nodeCount}, Cycles: ${cycleNodes.size}`);
}

module.exports = { runGraphAlgorithmsJob };