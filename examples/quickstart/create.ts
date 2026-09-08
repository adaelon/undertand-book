import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { markdownToBlocks } from '../../packages/core/src/md-adapter.ts';
import { segment } from '../../packages/core/src/segment.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const destination = path.resolve(root, '.understand-book/quickstart-demo');
const source = fs.readFileSync(path.join(root, 'examples/quickstart/book.md'), 'utf8');
const lidNodes = segment(markdownToBlocks(source));
const concepts = ['原文', 'LID', '知识图谱', '构建时', '阅读时', '笔记'];
const graphNodes = concepts.map(name => ({ id: `concept:${name}`, type: 'concept', name,
  occurrences: lidNodes.filter(n => !n.children.length && source.slice(n.span.start, n.span.end).includes(name)).map(n => n.lid), source_lid: null }));
const graphEdges = [['知识图谱', '原文'], ['构建时', '阅读时'], ['阅读时', '笔记']].map(([a, b]) => ({
  source: `concept:${a}`, target: `concept:${b}`, type: 'related_to', direction: 'undirected', scope: 'local', weight: 1,
}));
if (fs.existsSync(destination)) {
  const previous = fs.readFileSync(path.join(destination, 'source.txt'), 'utf8');
  if (previous !== source) throw new Error('Demo directory already exists with different source; choose a separate workspace before regenerating.');
  console.log(`Using existing demo without overwriting its graph: ${destination}`);
  process.exit(0);
}
fs.mkdirSync(destination, { recursive: true });
fs.writeFileSync(path.join(destination, 'source.txt'), source);
fs.writeFileSync(path.join(destination, 'base.json'), JSON.stringify({ book_id: 'quickstart-demo', lid_nodes: lidNodes, graph_nodes: graphNodes, graph_edges: graphEdges }, null, 2));
fs.writeFileSync(path.join(destination, 'profile_metadata.json'), JSON.stringify({ header: {
  book_id: 'quickstart-demo', book_version: 'v1', profile_id: 'technical_learning', profile_version: 'technical_learning_v0', core_schema_version: 'core_v0', generated_at: '2026-09-08T00:00:00Z',
} }, null, 2));
console.log(`Created original demo: ${destination} (${lidNodes.length} LIDs, ${graphNodes.length} preset concepts)`);
