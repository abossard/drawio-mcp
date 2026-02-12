import { XMLParser, XMLBuilder } from 'fast-xml-parser';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { SHAPE_STYLES, EDGE_STYLES, DEFAULT_GEOMETRY, CONNECTION_POINTS } from './styles.js';

// XML parser/builder config for draw.io format
const parserOptions = {
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  allowBooleanAttributes: true,
  preserveOrder: true,
  commentPropName: '#comment',
  trimValues: false,
};

const builderOptions = {
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  preserveOrder: true,
  format: true,
  indentBy: '  ',
  suppressBooleanAttributes: false,
  commentPropName: '#comment',
};

const parser = new XMLParser(parserOptions);
const builder = new XMLBuilder(builderOptions);

// Track files we're currently writing to avoid echo
const writingFiles = new Set<string>();

// File change callbacks
type FileChangeCallback = (filePath: string) => void;
const fileWatchers = new Map<string, fs.FSWatcher>();
const changeCallbacks: FileChangeCallback[] = [];

export function onDiagramFileChanged(callback: FileChangeCallback): void {
  changeCallbacks.push(callback);
}

export function watchDiagramFile(filePath: string): void {
  const resolved = path.resolve(filePath);
  if (fileWatchers.has(resolved)) return;

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  const watcher = fs.watch(resolved, (eventType) => {
    if (eventType !== 'change') return;
    if (writingFiles.has(resolved)) return;  // Skip our own writes

    // Debounce to avoid duplicate events
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      for (const cb of changeCallbacks) {
        cb(resolved);
      }
    }, 200);
  });

  fileWatchers.set(resolved, watcher);
}

export function unwatchDiagramFile(filePath: string): void {
  const resolved = path.resolve(filePath);
  const watcher = fileWatchers.get(resolved);
  if (watcher) {
    watcher.close();
    fileWatchers.delete(resolved);
  }
}

export function unwatchAll(): void {
  for (const [, watcher] of fileWatchers) {
    watcher.close();
  }
  fileWatchers.clear();
}

export interface ChangeRecord {
  id: string;
  timestamp: string;
  operation: string;
  filePath: string;
  description: string;
  beforeXml: string;
  afterXml?: string;
  elementIds: string[];
}

const changeHistory: ChangeRecord[] = [];
const MAX_HISTORY = 50;
let undoneRecords: ChangeRecord[] = [];

export function recordChange(record: Omit<ChangeRecord, 'id' | 'timestamp'>): string {
  const id = generateId();
  const fullRecord: ChangeRecord = {
    ...record,
    id,
    timestamp: new Date().toISOString(),
  };
  changeHistory.push(fullRecord);
  undoneRecords = [];
  if (changeHistory.length > MAX_HISTORY) {
    changeHistory.splice(0, changeHistory.length - MAX_HISTORY);
  }
  return id;
}

export function getHistory(limit?: number): ChangeRecord[] {
  if (limit !== undefined) {
    return changeHistory.slice(-limit);
  }
  return [...changeHistory];
}

export async function undoLastOperation(): Promise<{ success: boolean; record?: ChangeRecord }> {
  const record = changeHistory.pop();
  if (!record) return { success: false };
  await writeXml(record.filePath, record.beforeXml);
  undoneRecords.push(record);
  return { success: true, record };
}

export async function redoLastOperation(): Promise<{ success: boolean; record?: ChangeRecord }> {
  const record = undoneRecords.pop();
  if (!record || !record.afterXml) return { success: false };
  await writeXml(record.filePath, record.afterXml);
  changeHistory.push(record);
  return { success: true, record };
}

export interface DiagramNode {
  id: string;
  value: string;
  style: string;
  vertex: boolean;
  edge: boolean;
  source?: string;
  target?: string;
  parent: string;
  geometry?: {
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    relative?: boolean;
  };
}

export interface DiagramPage {
  id: string;
  name: string;
  nodes: DiagramNode[];
}

export interface DiagramInfo {
  filePath: string;
  pages: DiagramPage[];
  totalNodes: number;
  totalEdges: number;
}

// ── Validation helpers ──────────────────────────────────────────────────

export class DiagramValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DiagramValidationError';
  }
}

/** Extract all element IDs from raw draw.io XML */
function getExistingIds(xml: string): Set<string> {
  const ids = new Set<string>();
  const regex = /<mxCell\s+[^>]*?\bid="([^"]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(xml)) !== null) {
    ids.add(match[1]);
  }
  return ids;
}

/** Validate that a shape name is known */
function validateShape(shape: string | undefined): void {
  if (shape !== undefined && !(shape in SHAPE_STYLES)) {
    const available = Object.keys(SHAPE_STYLES).join(', ');
    throw new DiagramValidationError(
      `Unknown shape "${shape}". Available shapes: ${available}`
    );
  }
}

/** Validate that an edge style name is known */
function validateEdgeStyle(edgeStyle: string | undefined): void {
  if (edgeStyle !== undefined && !(edgeStyle in EDGE_STYLES)) {
    const available = Object.keys(EDGE_STYLES).join(', ');
    throw new DiagramValidationError(
      `Unknown edgeStyle "${edgeStyle}". Available styles: ${available}`
    );
  }
}

/** Validate that an ID does not already exist in the diagram */
function validateIdNotExists(id: string | undefined, existingIds: Set<string>): void {
  if (id !== undefined && existingIds.has(id)) {
    throw new DiagramValidationError(
      `Duplicate ID "${id}": an element with this ID already exists in the diagram`
    );
  }
}

/** Validate that edge source/target IDs reference existing nodes */
function validateEdgeTargets(
  sourceId: string,
  targetId: string,
  existingIds: Set<string>,
  batchNodeIds?: Set<string>
): void {
  const allKnown = new Set([...existingIds, ...(batchNodeIds ?? [])]);
  const missing: string[] = [];
  if (!allKnown.has(sourceId)) missing.push(`sourceId "${sourceId}"`);
  if (!allKnown.has(targetId)) missing.push(`targetId "${targetId}"`);
  if (missing.length > 0) {
    throw new DiagramValidationError(
      `Invalid edge: ${missing.join(' and ')} not found in diagram`
    );
  }
}

/** Validate connection point name (if provided) */
function validateConnectionPoint(point: string | undefined, paramName: string): void {
  if (point !== undefined && !(point in CONNECTION_POINTS)) {
    const available = Object.keys(CONNECTION_POINTS).join(', ');
    throw new DiagramValidationError(
      `Unknown ${paramName} "${point}". Available: ${available}`
    );
  }
}

/** Build exit/entry style fragments from connection point names */
function buildConnectionStyle(
  exitPoint?: string,
  entryPoint?: string
): string {
  let extra = '';
  if (exitPoint && CONNECTION_POINTS[exitPoint]) {
    const p = CONNECTION_POINTS[exitPoint];
    extra += `exitX=${p.x};exitY=${p.y};exitDx=0;exitDy=0;`;
  }
  if (entryPoint && CONNECTION_POINTS[entryPoint]) {
    const p = CONNECTION_POINTS[entryPoint];
    extra += `entryX=${p.x};entryY=${p.y};entryDx=0;entryDy=0;`;
  }
  return extra;
}

/** Generate a unique ID for new cells */
function generateId(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < 20; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

/** Create empty draw.io XML */
export function createEmptyDiagram(pageName: string = 'Page-1'): string {
  const diagramId = generateId();
  return `<?xml version="1.0" encoding="UTF-8"?>
<mxfile host="drawio-mcp" modified="${new Date().toISOString()}" agent="drawio-mcp" version="1.0.0" type="device">
  <diagram id="${diagramId}" name="${pageName}">
    <mxGraphModel dx="1422" dy="762" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="1169" pageHeight="827" math="0" shadow="0">
      <root>
        <mxCell id="0" />
        <mxCell id="1" parent="0" />
      </root>
    </mxGraphModel>
  </diagram>
</mxfile>`;
}

/** Read and parse a draw.io file */
export async function readDiagram(filePath: string): Promise<DiagramInfo> {
  const resolvedPath = path.resolve(filePath);
  const content = await fsp.readFile(resolvedPath, 'utf-8');
  const result = parseDiagramXml(content, resolvedPath);
  watchDiagramFile(resolvedPath);
  return result;
}

/** Parse draw.io XML string into structured data */
function parseDiagramXml(xml: string, filePath: string): DiagramInfo {
  const parsed = parser.parse(xml);
  const pages: DiagramPage[] = [];
  let totalNodes = 0;
  let totalEdges = 0;

  // Navigate: mxfile > diagram(s)
  const mxfileItem = findItem(parsed, 'mxfile');
  if (!mxfileItem) throw new Error('Invalid draw.io file: no mxfile element found');
  const mxfileChildren = mxfileItem['mxfile'] as any[];

  const diagramItems = findAllItems(mxfileChildren, 'diagram');

  for (const diagramItem of diagramItems) {
    const attrs = getAttrs(diagramItem);
    const pageId = attrs['id'] || generateId();
    const pageName = attrs['name'] || 'Untitled';
    const nodes: DiagramNode[] = [];
    const diagramChildren = diagramItem['diagram'] as any[];

    const graphModelItem = findItem(diagramChildren, 'mxGraphModel');
    if (!graphModelItem) continue;
    const graphModelChildren = graphModelItem['mxGraphModel'] as any[];

    const rootItem = findItem(graphModelChildren, 'root');
    if (!rootItem) continue;
    const rootChildren = rootItem['root'] as any[];

    const cellItems = findAllItems(rootChildren, 'mxCell');
    for (const cellItem of cellItems) {
      const cellAttrs = getAttrs(cellItem);
      const id = cellAttrs['id'] || '';

      // Skip root cells (id=0, id=1)
      if (id === '0' || id === '1') continue;

      const isVertex = cellAttrs['vertex'] === '1';
      const isEdge = cellAttrs['edge'] === '1';

      const node: DiagramNode = {
        id,
        value: cellAttrs['value'] || '',
        style: cellAttrs['style'] || '',
        vertex: isVertex,
        edge: isEdge,
        parent: cellAttrs['parent'] || '1',
        source: cellAttrs['source'],
        target: cellAttrs['target'],
      };

      // Parse geometry from cell's children
      const cellChildren = cellItem['mxCell'] as any[];
      const geomItem = findItem(cellChildren, 'mxGeometry');
      if (geomItem) {
        const geomAttrs = getAttrs(geomItem);
        node.geometry = {
          x: geomAttrs['x'] ? Number(geomAttrs['x']) : undefined,
          y: geomAttrs['y'] ? Number(geomAttrs['y']) : undefined,
          width: geomAttrs['width'] ? Number(geomAttrs['width']) : undefined,
          height: geomAttrs['height'] ? Number(geomAttrs['height']) : undefined,
          relative: geomAttrs['relative'] === '1',
        };
      }

      nodes.push(node);
      if (isVertex) totalNodes++;
      if (isEdge) totalEdges++;
    }

    pages.push({ id: pageId, name: pageName, nodes });
  }

  return { filePath, pages, totalNodes, totalEdges };
}

/** Find an item by tag name in preserveOrder array, returns the full item object */
function findItem(arr: any[], tagName: string): any | undefined {
  for (const item of arr) {
    if (item[tagName] !== undefined) {
      return item;
    }
  }
  return undefined;
}

/** Find all items with a given tag name in preserveOrder array */
function findAllItems(arr: any[], tagName: string): any[] {
  const results: any[] = [];
  for (const item of arr) {
    if (item[tagName] !== undefined) {
      results.push(item);
    }
  }
  return results;
}

/** Get attributes from a preserveOrder item (attributes are in ':@' property) */
function getAttrs(item: any): Record<string, string> {
  const attrs: Record<string, string> = {};
  if (item[':@']) {
    for (const [key, value] of Object.entries(item[':@'])) {
      const cleanKey = key.replace(/^@_/, '');
      attrs[cleanKey] = String(value);
    }
  }
  return attrs;
}

/** Read raw XML from file */
async function readRawXml(filePath: string): Promise<string> {
  return fsp.readFile(path.resolve(filePath), 'utf-8');
}

/** Write XML to file */
async function writeXml(filePath: string, xml: string): Promise<void> {
  const resolved = path.resolve(filePath);
  writingFiles.add(resolved);
  await fsp.writeFile(resolved, xml, 'utf-8');
  // Remove from writing set after a short delay to avoid catching our own event
  setTimeout(() => writingFiles.delete(resolved), 500);
}

/** Create a new draw.io diagram file */
export async function createDiagramFile(
  filePath: string,
  pageName: string = 'Page-1'
): Promise<string> {
  const resolvedPath = path.resolve(filePath);
  const xml = createEmptyDiagram(pageName);
  await fsp.mkdir(path.dirname(resolvedPath), { recursive: true });
  await writeXml(resolvedPath, xml);
  watchDiagramFile(resolvedPath);
  return resolvedPath;
}

/** Add a node (vertex) to a diagram */
export async function addNode(
  filePath: string,
  options: {
    label: string;
    shape?: string;
    style?: string;
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    pageIndex?: number;
    id?: string;
  }
): Promise<{ id: string; filePath: string; changeId: string }> {
  const resolvedPath = path.resolve(filePath);
  const beforeXml = await readRawXml(resolvedPath);
  let xml = beforeXml;

  // Validation
  const existingIds = getExistingIds(xml);
  validateShape(options.shape);
  validateIdNotExists(options.id, existingIds);

  const nodeId = options.id || generateId();
  let style = options.style || '';

  // Apply predefined shape style if specified
  if (options.shape && SHAPE_STYLES[options.shape]) {
    style = SHAPE_STYLES[options.shape] + style;
  } else if (!style) {
    style = SHAPE_STYLES.roundedRectangle;
  }

  const x = options.x ?? DEFAULT_GEOMETRY.x;
  const y = options.y ?? DEFAULT_GEOMETRY.y;
  const width = options.width ?? DEFAULT_GEOMETRY.width;
  const height = options.height ?? DEFAULT_GEOMETRY.height;

  const cellXml = `        <mxCell id="${nodeId}" value="${escapeXml(options.label)}" style="${escapeXml(style)}" vertex="1" parent="1">
          <mxGeometry x="${x}" y="${y}" width="${width}" height="${height}" as="geometry" />
        </mxCell>`;

  xml = insertCellIntoPage(xml, cellXml, options.pageIndex ?? 0);
  await writeXml(resolvedPath, xml);
  const afterXml = await readRawXml(resolvedPath);
  const changeId = recordChange({
    operation: 'add_node',
    filePath: resolvedPath,
    description: `Added node "${options.label}" (${nodeId})`,
    beforeXml,
    afterXml,
    elementIds: [nodeId],
  });

  return { id: nodeId, filePath: resolvedPath, changeId };
}

/** Add an edge (connection) between two nodes */
export async function addEdge(
  filePath: string,
  options: {
    sourceId: string;
    targetId: string;
    label?: string;
    style?: string;
    edgeStyle?: string;
    exitPoint?: string;
    entryPoint?: string;
    pageIndex?: number;
    id?: string;
  }
): Promise<{ id: string; filePath: string; changeId: string; layoutWarnings: LayoutWarning[] }> {
  const resolvedPath = path.resolve(filePath);
  const beforeXml = await readRawXml(resolvedPath);
  let xml = beforeXml;

  // Validation
  const existingIds = getExistingIds(xml);
  validateEdgeStyle(options.edgeStyle);
  validateIdNotExists(options.id, existingIds);
  validateEdgeTargets(options.sourceId, options.targetId, existingIds);
  validateConnectionPoint(options.exitPoint, 'exitPoint');
  validateConnectionPoint(options.entryPoint, 'entryPoint');

  const edgeId = options.id || generateId();
  let style = options.style || '';

  if (options.edgeStyle && EDGE_STYLES[options.edgeStyle]) {
    style = EDGE_STYLES[options.edgeStyle] + style;
  }

  // Append connection point style fragments
  style += buildConnectionStyle(options.exitPoint, options.entryPoint);

  const label = options.label || '';

  const cellXml = `        <mxCell id="${edgeId}" value="${escapeXml(label)}" style="${escapeXml(style)}" edge="1" parent="1" source="${escapeXml(options.sourceId)}" target="${escapeXml(options.targetId)}">
          <mxGeometry relative="1" as="geometry" />
        </mxCell>`;

  xml = insertCellIntoPage(xml, cellXml, options.pageIndex ?? 0);
  await writeXml(resolvedPath, xml);
  const afterXml = await readRawXml(resolvedPath);
  const changeId = recordChange({
    operation: 'add_edge',
    filePath: resolvedPath,
    description: `Added edge "${label}" from ${options.sourceId} to ${options.targetId} (${edgeId})`,
    beforeXml,
    afterXml,
    elementIds: [edgeId],
  });

  // Run layout analysis and return warnings
  const postInfo = await readDiagram(resolvedPath);
  const layoutWarnings = postInfo.pages.length > 0
    ? analyzePageLayout(postInfo.pages[options.pageIndex ?? 0] ?? postInfo.pages[0])
    : [];

  return { id: edgeId, filePath: resolvedPath, changeId, layoutWarnings };
}

/** Update an existing element's properties */
export async function updateElement(
  filePath: string,
  elementId: string,
  updates: {
    label?: string;
    style?: string;
    x?: number;
    y?: number;
    width?: number;
    height?: number;
  }
): Promise<{ success: boolean; changeId?: string }> {
  const resolvedPath = path.resolve(filePath);
  const beforeXml = await readRawXml(resolvedPath);
  let xml = beforeXml;

  // Find the mxCell with the given ID using regex
  const cellRegex = new RegExp(
    `(<mxCell[^>]*\\sid="${escapeRegex(elementId)}"[^>]*?)(/?>)`,
    's'
  );
  const match = xml.match(cellRegex);
  if (!match) return { success: false };

  let cellTag = match[1];
  const closing = match[2];

  // Update attributes
  if (updates.label !== undefined) {
    cellTag = replaceOrAddAttr(cellTag, 'value', updates.label);
  }
  if (updates.style !== undefined) {
    cellTag = replaceOrAddAttr(cellTag, 'style', updates.style);
  }

  xml = xml.replace(match[0], cellTag + closing);

  // Update geometry if position/size changed
  if (updates.x !== undefined || updates.y !== undefined || updates.width !== undefined || updates.height !== undefined) {
    // Match just the mxGeometry tag that follows the mxCell with this ID
    const geomRegex = new RegExp(
      `(<mxCell[^>]*\\sid="${escapeRegex(elementId)}"[^>]*>[\\s]*<mxGeometry\\s)([^/]*?)(\\/?>)`,
      's'
    );
    const geomMatch = xml.match(geomRegex);
    if (geomMatch) {
      let geomAttrs = geomMatch[2];
      if (updates.x !== undefined) geomAttrs = replaceOrAddAttr(geomAttrs, 'x', String(updates.x));
      if (updates.y !== undefined) geomAttrs = replaceOrAddAttr(geomAttrs, 'y', String(updates.y));
      if (updates.width !== undefined) geomAttrs = replaceOrAddAttr(geomAttrs, 'width', String(updates.width));
      if (updates.height !== undefined) geomAttrs = replaceOrAddAttr(geomAttrs, 'height', String(updates.height));
      xml = xml.replace(geomMatch[0], geomMatch[1] + geomAttrs + geomMatch[3]);
    }
  }

  await writeXml(resolvedPath, xml);
  const afterXml = await readRawXml(resolvedPath);
  const changeId = recordChange({
    operation: 'update_element',
    filePath: resolvedPath,
    description: `Updated element ${elementId}`,
    beforeXml,
    afterXml,
    elementIds: [elementId],
  });

  return { success: true, changeId };
}

/** Remove an element by ID */
export async function removeElement(
  filePath: string,
  elementId: string
): Promise<{ success: boolean; changeId?: string }> {
  const resolvedPath = path.resolve(filePath);
  const beforeXml = await readRawXml(resolvedPath);
  let xml = beforeXml;

  // Match self-closing or full mxCell with nested content
  const selfClosingRegex = new RegExp(
    `\\s*<mxCell[^>]*\\sid="${escapeRegex(elementId)}"[^/]*/>[\\t ]*\\n?`,
    's'
  );
  const fullRegex = new RegExp(
    `\\s*<mxCell[^>]*\\sid="${escapeRegex(elementId)}"[^>]*>[\\s\\S]*?</mxCell>[\\t ]*\\n?`,
    's'
  );

  let found = false;
  if (fullRegex.test(xml)) {
    xml = xml.replace(fullRegex, '\n');
    found = true;
  } else if (selfClosingRegex.test(xml)) {
    xml = xml.replace(selfClosingRegex, '\n');
    found = true;
  }

  if (found) {
    await writeXml(resolvedPath, xml);
    const afterXml = await readRawXml(resolvedPath);
    const changeId = recordChange({
      operation: 'remove_element',
      filePath: resolvedPath,
      description: `Removed element ${elementId}`,
      beforeXml,
      afterXml,
      elementIds: [elementId],
    });
    return { success: true, changeId };
  }
  return { success: false };
}

/** Add a new page to a diagram */
export async function addPage(
  filePath: string,
  pageName: string
): Promise<{ pageId: string; filePath: string; changeId: string }> {
  const resolvedPath = path.resolve(filePath);
  const beforeXml = await readRawXml(resolvedPath);
  let xml = beforeXml;

  const pageId = generateId();
  const newPage = `  <diagram id="${pageId}" name="${escapeXml(pageName)}">
    <mxGraphModel dx="1422" dy="762" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="1169" pageHeight="827" math="0" shadow="0">
      <root>
        <mxCell id="0" />
        <mxCell id="1" parent="0" />
      </root>
    </mxGraphModel>
  </diagram>`;

  // Insert before </mxfile>
  xml = xml.replace('</mxfile>', newPage + '\n</mxfile>');
  await writeXml(resolvedPath, xml);
  const afterXml = await readRawXml(resolvedPath);
  const changeId = recordChange({
    operation: 'add_page',
    filePath: resolvedPath,
    description: `Added page "${pageName}" (${pageId})`,
    beforeXml,
    afterXml,
    elementIds: [pageId],
  });

  return { pageId, filePath: resolvedPath, changeId };
}

/** Batch-add multiple nodes and edges in a single file write */
export async function batchAddElements(
  filePath: string,
  options: {
    nodes?: Array<{
      label: string;
      shape?: string;
      style?: string;
      x?: number;
      y?: number;
      width?: number;
      height?: number;
      pageIndex?: number;
      id?: string;
    }>;
    edges?: Array<{
      sourceId: string;
      targetId: string;
      label?: string;
      style?: string;
      edgeStyle?: string;
      exitPoint?: string;
      entryPoint?: string;
      pageIndex?: number;
      id?: string;
    }>;
  }
): Promise<{
  nodeIds: Array<{ id: string; label: string }>;
  edgeIds: Array<{ id: string; sourceId: string; targetId: string }>;
  changeId: string;
  layoutWarnings: LayoutWarning[];
}> {
  const resolvedPath = path.resolve(filePath);
  const beforeXml = await readRawXml(resolvedPath);
  let xml = beforeXml;

  // Pre-validate everything before making any changes
  const existingIds = getExistingIds(xml);
  const batchNodeIds = new Set<string>();
  const batchAllIds = new Set<string>();

  // Validate all nodes first
  for (const node of options.nodes ?? []) {
    validateShape(node.shape);
    const nodeId = node.id || generateId();
    // Assign generated IDs back so we use them consistently
    node.id = nodeId;
    validateIdNotExists(nodeId, existingIds);
    if (batchAllIds.has(nodeId)) {
      throw new DiagramValidationError(`Duplicate ID "${nodeId}" within batch`);
    }
    batchNodeIds.add(nodeId);
    batchAllIds.add(nodeId);
  }

  // Validate all edges (can reference existing nodes OR batch nodes)
  for (const edge of options.edges ?? []) {
    validateEdgeStyle(edge.edgeStyle);
    validateConnectionPoint(edge.exitPoint, 'exitPoint');
    validateConnectionPoint(edge.entryPoint, 'entryPoint');
    const edgeId = edge.id || generateId();
    edge.id = edgeId;
    validateIdNotExists(edgeId, existingIds);
    if (batchAllIds.has(edgeId)) {
      throw new DiagramValidationError(`Duplicate ID "${edgeId}" within batch`);
    }
    batchAllIds.add(edgeId);
    validateEdgeTargets(edge.sourceId, edge.targetId, existingIds, batchNodeIds);
  }

  const nodeResults: Array<{ id: string; label: string }> = [];
  const edgeResults: Array<{ id: string; sourceId: string; targetId: string }> = [];
  const allIds: string[] = [];

  // Insert all nodes
  for (const node of options.nodes ?? []) {
    const nodeId = node.id!;
    let style = node.style || '';
    if (node.shape && SHAPE_STYLES[node.shape]) {
      style = SHAPE_STYLES[node.shape] + style;
    } else if (!style) {
      style = SHAPE_STYLES.roundedRectangle;
    }
    const x = node.x ?? DEFAULT_GEOMETRY.x;
    const y = node.y ?? DEFAULT_GEOMETRY.y;
    const width = node.width ?? DEFAULT_GEOMETRY.width;
    const height = node.height ?? DEFAULT_GEOMETRY.height;

    const cellXml = `        <mxCell id="${nodeId}" value="${escapeXml(node.label)}" style="${escapeXml(style)}" vertex="1" parent="1">
          <mxGeometry x="${x}" y="${y}" width="${width}" height="${height}" as="geometry" />
        </mxCell>`;
    xml = insertCellIntoPage(xml, cellXml, node.pageIndex ?? 0);
    nodeResults.push({ id: nodeId, label: node.label });
    allIds.push(nodeId);
  }

  // Insert all edges
  for (const edge of options.edges ?? []) {
    const edgeId = edge.id!;
    let style = edge.style || '';
    if (edge.edgeStyle && EDGE_STYLES[edge.edgeStyle]) {
      style = EDGE_STYLES[edge.edgeStyle] + style;
    }
    style += buildConnectionStyle(edge.exitPoint, edge.entryPoint);
    const label = edge.label || '';

    const cellXml = `        <mxCell id="${edgeId}" value="${escapeXml(label)}" style="${escapeXml(style)}" edge="1" parent="1" source="${escapeXml(edge.sourceId)}" target="${escapeXml(edge.targetId)}">
          <mxGeometry relative="1" as="geometry" />
        </mxCell>`;
    xml = insertCellIntoPage(xml, cellXml, edge.pageIndex ?? 0);
    edgeResults.push({ id: edgeId, sourceId: edge.sourceId, targetId: edge.targetId });
    allIds.push(edgeId);
  }

  // Single file write
  await writeXml(resolvedPath, xml);
  const afterXml = await readRawXml(resolvedPath);

  const nodeCount = nodeResults.length;
  const edgeCount = edgeResults.length;
  const changeId = recordChange({
    operation: 'batch_add',
    filePath: resolvedPath,
    description: `Batch added ${nodeCount} node(s) and ${edgeCount} edge(s)`,
    beforeXml,
    afterXml,
    elementIds: allIds,
  });

  // Run layout analysis and return warnings
  const postInfo = parseDiagramXml(afterXml, resolvedPath);
  const layoutWarnings = postInfo.pages.length > 0
    ? analyzePageLayout(postInfo.pages[0])
    : [];

  return { nodeIds: nodeResults, edgeIds: edgeResults, changeId, layoutWarnings };
}

/** List all .drawio files in a directory recursively */
export async function listDiagramFiles(dir: string): Promise<string[]> {
  const resolvedDir = path.resolve(dir);
  const files: string[] = [];

  async function walk(currentDir: string): Promise<void> {
    try {
      const entries = await fsp.readdir(currentDir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(currentDir, entry.name);
        if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
          await walk(fullPath);
        } else if (entry.isFile() && (entry.name.endsWith('.drawio') || entry.name.endsWith('.dio'))) {
          files.push(fullPath);
        }
      }
    } catch {
      // Skip directories we can't read
    }
  }

  await walk(resolvedDir);
  return files;
}

// ── Layout analysis ─────────────────────────────────────────────────────────

export interface LayoutWarning {
  type: 'node_overlap' | 'edge_label_overlap' | 'insufficient_spacing' | 'node_outside_bounds';
  severity: 'error' | 'warning' | 'info';
  message: string;
  elementIds: string[];
  suggestion?: string;
}

interface MovementCandidate {
  direction: 'up' | 'down' | 'left' | 'right';
  dx: number;
  dy: number;
  conflictsWith: string[]; // IDs of nodes that would be in the way
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

function rectsOverlap(a: Rect, b: Rect): boolean {
  return !(a.x + a.width <= b.x || b.x + b.width <= a.x ||
           a.y + a.height <= b.y || b.y + b.height <= a.y);
}

function rectArea(a: Rect, b: Rect): number {
  const overlapX = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const overlapY = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  return overlapX * overlapY;
}

/** Estimate the bounding rect of an edge label (placed at midpoint between source/target) */
function estimateLabelRect(
  sourceRect: Rect,
  targetRect: Rect,
  label: string
): Rect {
  const srcCx = sourceRect.x + sourceRect.width / 2;
  const srcCy = sourceRect.y + sourceRect.height / 2;
  const tgtCx = targetRect.x + targetRect.width / 2;
  const tgtCy = targetRect.y + targetRect.height / 2;
  const midX = (srcCx + tgtCx) / 2;
  const midY = (srcCy + tgtCy) / 2;
  // Rough estimate: ~7px per char, 14px height, with padding
  const labelWidth = Math.max(40, label.length * 7 + 16);
  const labelHeight = 18;
  return {
    x: midX - labelWidth / 2,
    y: midY - labelHeight / 2,
    width: labelWidth,
    height: labelHeight,
  };
}

/** Check layout of a diagram and return warnings */
export async function checkLayout(
  filePath: string,
  options?: { pageIndex?: number }
): Promise<LayoutWarning[]> {
  const info = await readDiagram(filePath);
  const pageIdx = options?.pageIndex ?? 0;
  const page = info.pages[pageIdx];
  if (!page) return [];

  return analyzePageLayout(page);
}

/** Analyze layout of a parsed page — can be used without file I/O */
export function analyzePageLayout(page: DiagramPage): LayoutWarning[] {
  const warnings: LayoutWarning[] = [];

  // Separate vertices and edges, skip container-like nodes (very large)
  const vertices = page.nodes.filter(n => n.vertex && n.geometry && !n.geometry.relative);
  const edges = page.nodes.filter(n => n.edge);

  // Build rect map
  const rectMap = new Map<string, Rect>();
  for (const v of vertices) {
    const g = v.geometry!;
    rectMap.set(v.id, {
      x: g.x ?? 0,
      y: g.y ?? 0,
      width: g.width ?? DEFAULT_GEOMETRY.width,
      height: g.height ?? DEFAULT_GEOMETRY.height,
    });
  }

  // Identify containers (large nodes, typically > 250x150)
  const containerIds = new Set<string>();
  for (const v of vertices) {
    const r = rectMap.get(v.id)!;
    if (r.width >= 250 && r.height >= 150) {
      containerIds.add(v.id);
    }
  }

  const nonContainers = vertices.filter(v => !containerIds.has(v.id));
  const nonContainerRects = nonContainers.map(v => ({ id: v.id, rect: rectMap.get(v.id)! }));

  // 1. Check node-node overlaps (skip containers)
  for (let i = 0; i < nonContainers.length; i++) {
    for (let j = i + 1; j < nonContainers.length; j++) {
      const a = nonContainers[i];
      const b = nonContainers[j];
      const ra = rectMap.get(a.id)!;
      const rb = rectMap.get(b.id)!;
      if (rectsOverlap(ra, rb)) {
        const overlap = rectArea(ra, rb);
        const smallerArea = Math.min(ra.width * ra.height, rb.width * rb.height);
        const severity = overlap > smallerArea * 0.5 ? 'error' : 'warning';
        const moveAmount = Math.round(Math.sqrt(overlap)) + 20;
        const moveSuggestion = suggestMovement(b.id, rb, moveAmount, nonContainerRects, rectMap);
        warnings.push({
          type: 'node_overlap',
          severity,
          message: `Nodes "${a.id}" and "${b.id}" overlap (${Math.round(overlap)}px² intersection)`,
          elementIds: [a.id, b.id],
          suggestion: moveSuggestion,
        });
      }
    }
  }

  // 2. Check edge label vs node overlaps
  for (const edge of edges) {
    if (!edge.value || edge.value.trim() === '') continue;
    const srcRect = rectMap.get(edge.source ?? '');
    const tgtRect = rectMap.get(edge.target ?? '');
    if (!srcRect || !tgtRect) continue;

    const labelRect = estimateLabelRect(srcRect, tgtRect, edge.value);

    for (const v of nonContainers) {
      if (v.id === edge.source || v.id === edge.target) continue;
      const nodeRect = rectMap.get(v.id)!;
      if (rectsOverlap(labelRect, nodeRect)) {
        const moveAmount = Math.max(labelRect.width, labelRect.height) + 20;
        const moveSuggestion = suggestMovement(v.id, nodeRect, moveAmount, nonContainerRects, rectMap);
        warnings.push({
          type: 'edge_label_overlap',
          severity: 'warning',
          message: `Edge "${edge.id}" label "${edge.value}" overlaps with node "${v.id}"`,
          elementIds: [edge.id, v.id],
          suggestion: moveSuggestion,
        });
      }
    }
  }

  // 3. Check insufficient spacing between connected nodes (label won't fit)
  const MIN_LABEL_GAP = 60; // minimum px gap for a readable label
  for (const edge of edges) {
    if (!edge.value || edge.value.trim() === '') continue;
    const srcRect = rectMap.get(edge.source ?? '');
    const tgtRect = rectMap.get(edge.target ?? '');
    if (!srcRect || !tgtRect) continue;

    // Calculate minimum gap between the two node rects
    const gapX = Math.max(0,
      Math.max(srcRect.x, tgtRect.x) - Math.min(srcRect.x + srcRect.width, tgtRect.x + tgtRect.width)
    );
    const gapY = Math.max(0,
      Math.max(srcRect.y, tgtRect.y) - Math.min(srcRect.y + srcRect.height, tgtRect.y + tgtRect.height)
    );
    const gap = Math.max(gapX, gapY);

    // Estimate needed space based on label length
    const neededGap = Math.max(MIN_LABEL_GAP, edge.value.length * 7 + 20);

    if (gap < neededGap) {
      const severity = gap < MIN_LABEL_GAP ? 'warning' : 'info';
      const deficit = neededGap - gap;

      // Determine the dominant axis and suggest moving the target node
      const tgtId = edge.target ?? '';
      const moveDir = computeEdgeAxis(srcRect, tgtRect);
      const moveSuggestion = suggestMovementAlongAxis(
        tgtId, tgtRect, moveDir, deficit, nonContainerRects, rectMap
      );

      warnings.push({
        type: 'insufficient_spacing',
        severity,
        message: `Edge "${edge.id}" label "${edge.value}" (needs ~${neededGap}px) between "${edge.source}" and "${edge.target}" (gap: ${Math.round(gap)}px)`,
        elementIds: [edge.id, edge.source ?? '', edge.target ?? ''],
        suggestion: moveSuggestion,
      });
    }
  }

  return warnings;
}

/** Determine the dominant axis between two rects: which direction is target relative to source */
function computeEdgeAxis(src: Rect, tgt: Rect): 'right' | 'left' | 'down' | 'up' {
  const srcCx = src.x + src.width / 2;
  const srcCy = src.y + src.height / 2;
  const tgtCx = tgt.x + tgt.width / 2;
  const tgtCy = tgt.y + tgt.height / 2;
  const dx = tgtCx - srcCx;
  const dy = tgtCy - srcCy;
  if (Math.abs(dx) > Math.abs(dy)) {
    return dx > 0 ? 'right' : 'left';
  }
  return dy > 0 ? 'down' : 'up';
}

/** Suggest moving a node in a preferred axis direction, checking for cascading conflicts */
function suggestMovementAlongAxis(
  nodeId: string,
  nodeRect: Rect,
  axis: 'right' | 'left' | 'down' | 'up',
  amount: number,
  allRects: { id: string; rect: Rect }[],
  _rectMap: Map<string, Rect>,
): string {
  const padded = amount + 20; // add margin
  const dirMap: Record<string, { dx: number; dy: number }> = {
    right: { dx: padded, dy: 0 },
    left: { dx: -padded, dy: 0 },
    down: { dx: 0, dy: padded },
    up: { dx: 0, dy: -padded },
  };

  const primaryDir = dirMap[axis];
  const candidates = buildMovementCandidates(nodeId, nodeRect, padded, primaryDir, allRects);

  if (candidates.length === 0) {
    return `Move "${nodeId}" ${padded}px ${axis} to create enough gap`;
  }

  // Find the candidate with fewest conflicts
  const best = candidates.sort((a, b) => a.conflictsWith.length - b.conflictsWith.length)[0];

  if (best.conflictsWith.length === 0) {
    return `Move "${nodeId}" ${Math.abs(best.dx || best.dy)}px ${best.direction} (clear path, no new conflicts)`;
  }

  const conflictList = best.conflictsWith.map(id => `"${id}"`).join(', ');
  return `Move "${nodeId}" ${Math.abs(best.dx || best.dy)}px ${best.direction} — ⚠️ would conflict with ${conflictList}. Consider moving those nodes too, or use a different layout direction.`;
}

/** Suggest the best direction to move a node to resolve an overlap */
function suggestMovement(
  nodeId: string,
  nodeRect: Rect,
  amount: number,
  allRects: { id: string; rect: Rect }[],
  _rectMap: Map<string, Rect>,
): string {
  const directions: Array<{ name: string; dx: number; dy: number }> = [
    { name: 'right', dx: amount, dy: 0 },
    { name: 'left', dx: -amount, dy: 0 },
    { name: 'down', dx: 0, dy: amount },
    { name: 'up', dx: 0, dy: -amount },
  ];

  const candidates: MovementCandidate[] = [];

  for (const dir of directions) {
    const movedRect: Rect = {
      x: nodeRect.x + dir.dx,
      y: nodeRect.y + dir.dy,
      width: nodeRect.width,
      height: nodeRect.height,
    };

    const conflicts: string[] = [];
    for (const other of allRects) {
      if (other.id === nodeId) continue;
      if (rectsOverlap(movedRect, other.rect)) {
        conflicts.push(other.id);
      }
    }

    candidates.push({
      direction: dir.name as MovementCandidate['direction'],
      dx: dir.dx,
      dy: dir.dy,
      conflictsWith: conflicts,
    });
  }

  // Sort: prefer directions with zero conflicts, then by fewest conflicts
  candidates.sort((a, b) => a.conflictsWith.length - b.conflictsWith.length);
  const best = candidates[0];

  if (best.conflictsWith.length === 0) {
    return `Move "${nodeId}" ${amount}px ${best.direction} (clear path, no new conflicts)`;
  }

  // All directions have conflicts — report the best and the cascade
  const conflictList = best.conflictsWith.map(id => `"${id}"`).join(', ');
  const altCandidates = candidates.filter(c => c.conflictsWith.length === best.conflictsWith.length);
  const altDirs = altCandidates.map(c => c.direction).join(' or ');

  return `Move "${nodeId}" ${amount}px ${altDirs} — ⚠️ would also push into ${conflictList}. Consider cascading: move ${conflictList} first, then move "${nodeId}".`;
}

/** Build movement candidates, trying primary direction first, then alternatives */
function buildMovementCandidates(
  nodeId: string,
  nodeRect: Rect,
  amount: number,
  primaryDir: { dx: number; dy: number },
  allRects: { id: string; rect: Rect }[],
): MovementCandidate[] {
  const directions: Array<{ name: MovementCandidate['direction']; dx: number; dy: number }> = [
    { name: 'right', dx: amount, dy: 0 },
    { name: 'left', dx: -amount, dy: 0 },
    { name: 'down', dx: 0, dy: amount },
    { name: 'up', dx: 0, dy: -amount },
  ];

  // Put primary direction first
  directions.sort((a, b) => {
    const aMatch = (a.dx === primaryDir.dx && a.dy === primaryDir.dy) ? 0 : 1;
    const bMatch = (b.dx === primaryDir.dx && b.dy === primaryDir.dy) ? 0 : 1;
    return aMatch - bMatch;
  });

  const candidates: MovementCandidate[] = [];
  for (const dir of directions) {
    const movedRect: Rect = {
      x: nodeRect.x + dir.dx,
      y: nodeRect.y + dir.dy,
      width: nodeRect.width,
      height: nodeRect.height,
    };
    const conflicts: string[] = [];
    for (const other of allRects) {
      if (other.id === nodeId) continue;
      if (rectsOverlap(movedRect, other.rect)) {
        conflicts.push(other.id);
      }
    }
    candidates.push({ direction: dir.name, dx: dir.dx, dy: dir.dy, conflictsWith: conflicts });
  }

  return candidates;
}

// --- Utility functions ---

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function replaceOrAddAttr(tag: string, attr: string, value: string): string {
  // Use word boundary to avoid matching inside other attribute names (e.g., 'x' inside 'vertex')
  const attrRegex = new RegExp(`\\b${attr}="[^"]*"`);
  if (attrRegex.test(tag)) {
    return tag.replace(attrRegex, `${attr}="${escapeXml(value)}"`);
  }
  return tag + ` ${attr}="${escapeXml(value)}"`;
}

/** Insert a cell XML snippet into the specified page's <root> */
function insertCellIntoPage(xml: string, cellXml: string, pageIndex: number): string {
  // Find all </root> tags and insert before the one at pageIndex
  const rootCloseRegex = /<\/root>/g;
  let match: RegExpExecArray | null;
  let currentIndex = 0;

  while ((match = rootCloseRegex.exec(xml)) !== null) {
    if (currentIndex === pageIndex) {
      const insertPos = match.index;
      return xml.slice(0, insertPos) + cellXml + '\n' + xml.slice(insertPos);
    }
    currentIndex++;
  }

  // If pageIndex not found, insert in last page
  const lastRootClose = xml.lastIndexOf('</root>');
  if (lastRootClose !== -1) {
    return xml.slice(0, lastRootClose) + cellXml + '\n' + xml.slice(lastRootClose);
  }

  throw new Error('Cannot find <root> element in diagram');
}
