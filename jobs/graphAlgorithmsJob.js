// jobs/graphAlgorithmsJob.js
// Nightly job (runs at 03:00 IST) that executes graph algorithms over
// the DeviceGraph collection to identify clusters, hub accounts, and referral loops.
//
// FIX: detectReferralCycles used recursive DFS. Node.js has a default call
// stack limit of ~10,000 frames. A deep referral tree (e.g. a pyramid scheme
// with 500+ levels) would throw "Maximum call stack size exceeded", crash the
// graph job, and leave all users' cluster flags stale indefinitely.
// Replaced with iterative DFS using an explicit stack array — handles any
// depth with O(1) stack space from the JS engine's perspective.
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

  getClusters() {
    const result = {};
    for (const node of Object.keys(this.parent)) {
      result[node] = this.find(node);
    }
    return result;
  }
}

// ── Load entire graph into memory (adjacency map) ────────────────────────────
async function loadAdjacencyMap() {
  const adj       = {};
  const nodeTypes = {};

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
  return uf.getClusters();
}

// ── Algorithm 2: Cycle detection in referral sub-graph ────────────────────────
// Returns Set of nodeKeys that participate in a referral cycle.
//
// FIX: Was recursive DFS — replaced with iterative DFS using an explicit
// stack to prevent "Maximum call stack size exceeded" on deep trees.
//
// Iterative DFS for cycle detection uses a colour-marking scheme:
//   WHITE (0) = not visited
//   GRAY  (1) = currently on the active DFS path (in stack)
//   BLACK (2) = fully processed
// A back-edge (GRAY → GRAY) indicates a cycle.
function detectReferralCycles(adj, nodeTypes) {
  // Build referral-only directed adjacency (user → user edges only)
  const refAdj = {};
  for (const [node, neighbors] of Object.entries(adj)) {
    if (nodeTypes[node] !== 'user') continue;
    refAdj[node] = [];
    for (const neighbor of neighbors) {
      if (nodeTypes[neighbor] === 'user') refAdj[node].push(neighbor);
    }
  }

  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color     = {};  // node → WHITE | GRAY | BLACK
  const cycleNodes = new Set();

  for (const startNode of Object.keys(refAdj)) {
    if ((color[startNode] || WHITE) !== WHITE) continue;

    // Iterative DFS: each stack entry is [node, iteratorIndex]
    // iteratorIndex tracks which neighbour we're about to visit next,
    // allowing us to correctly set a node BLACK only after all its
    // subtrees have been fully explored.
    const stack = [[startNode, 0]];
    color[startNode] = GRAY;

    while (stack.length > 0) {
      const frame    = stack[stack.length - 1];
      const node     = frame[0];
      const neighbors = refAdj[node] || [];

      if (frame[1] < neighbors.length) {
        const neighbor = neighbors[frame[1]];
        frame[1]++;                              // advance iterator

        const nColor = color[neighbor] || WHITE;

        if (nColor === WHITE) {
          color[neighbor] = GRAY;
          stack.push([neighbor, 0]);
        } else if (nColor === GRAY) {
          // Back-edge → cycle detected
          cycleNodes.add(node);
          cycleNodes.add(neighbor);
        }
        // BLACK neighbours are already fully processed — skip
      } else {
        // All neighbours of `node` processed — mark it BLACK and pop
        color[node] = BLACK;
        stack.pop();
      }
    }
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
  const nodes      = Object.keys(clusterMap);

  for (let i = 0; i < nodes.length; i += BATCH_SIZE) {
    const batch   = nodes.slice(i, i + BATCH_SIZE);
    const bulkOps = batch.map(nodeKey => {
      const [entityType, ...idParts] = nodeKey.split(':');
      const entityId   = idParts.join(':');
      const clusterId  = clusterMap[nodeKey];

      const riskFlags = [];
      if (cycleNodes.has(nodeKey))                              riskFlags.push('referral_loop');
      if ((degrees[nodeKey] || 0) > 20)                        riskFlags.push('high_degree');
      if ((hubScores[nodeKey] || 0) > 0.7)                     riskFlags.push('hub_account');
      if (entityType === 'device' && (degrees[nodeKey] || 0) > 3) riskFlags.push('shared_device_farm');
      if (entityType === 'ip'     && (degrees[nodeKey] || 0) > 5) riskFlags.push('ip_cluster');

      return {
        updateOne: {
          filter: { entityType, entityId },
          update: {
            $set: {
              primaryClusterId:  clusterId,
              clusterIds:        [clusterId],
              degreeScore:       degrees[nodeKey]   || 0,
              betweennessScore:  hubScores[nodeKey]  || 0,
              riskFlags,
              lastGraphUpdateAt: new Date(),
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
    const slice   = userNodes.slice(i, i + BATCH);
    const bulkOps = slice.map(([nodeKey, clusterId]) => {
      const userId = nodeKey.split(':')[1];
      return {
        updateOne: {
          filter: { _id: userId },
          update: {
            $set: {
              'trustFlags.primaryClusterId':  clusterId,
              'trustFlags.inReferralCycle':   cycleNodes.has(nodeKey),
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

  console.log('[graphAlgorithmsJob] Detecting referral cycles (iterative DFS)…');
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